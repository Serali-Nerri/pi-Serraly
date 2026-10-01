// Adapted from pi-cc-extensions v0.8.69; see THIRD_PARTY_NOTICES.md.
import { type BuildSystemPromptOptions, type ExtensionCommandContext, type SessionProjection, type ToolInfo, estimateTokens, formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { contentText, getCurrentSystemMessage, getCurrentSystemPrompt, getCurrentTools, type SystemMessage } from "@earendil-works/pi-ai";
import { hasContextUsageAnchor, readContextSnapshot, type ContextSnapshot } from "./context-snapshot.ts";

export type ContextPart = {
	label: string;
	tokens: number;
	color: "accent" | "success" | "warning" | "customMessageLabel" | "muted" | "dim" | "error";
};

export type PreviewKey =
	| "systemPrompt"
	| "memoryFiles"
	| "skills"
	| "tools"
	| "toolResults"
	| "contextFiles";

export type ContextPreview = {
	key: PreviewKey;
	label: string;
	title: string;
	content: string;
};

const tokenEstimate = (value: unknown): number => {
	if (!value) return 0;
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return Math.max(0, Math.ceil(text.length / 4));
};

/** 只统计确实嵌进 system prompt 的片段，避免源文件预览把占用加两遍。 */
function embeddedTokens(prompt: string, chunk: string): number {
	if (!chunk || !prompt.includes(chunk)) return 0;
	return tokenEstimate(chunk);
}

export function capParts(parts: ContextPart[], target: number, fixedPrefix = 0): ContextPart[] {
	const fixed = parts.slice(0, fixedPrefix);
	const variable = parts.slice(fixedPrefix);
	const fixedTokens = fixed.reduce((sum, part) => sum + part.tokens, 0);
	const variableTarget = Math.max(0, target - fixedTokens);
	const estimated = variable.reduce((sum, part) => sum + part.tokens, 0);
	if (estimated <= variableTarget || estimated === 0) return parts;
	if (variableTarget === 0) {
		return [...fixed, ...variable.map((part) => ({ ...part, tokens: 0 }))];
	}

	let previous = 0;
	let cumulative = 0;
	const capped = variable.map((part, index) => {
		cumulative += part.tokens;
		const next =
			index === variable.length - 1
				? variableTarget
				: Math.round((cumulative / estimated) * variableTarget);
		const tokens = next - previous;
		previous = next;
		return { ...part, tokens };
	});
	return [...fixed, ...capped];
}

export function formatTokens(tokens: number): string {
	if (tokens < 1_000) return String(tokens);
	if (tokens < 100_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return `${Math.round(tokens / 1_000)}k`;
}

export function resolveUsedTokens(
	usage: { tokens: number | null; percent: number | null } | undefined,
	estimated: number,
	contextWindow: number,
): number {
	const reported = usage?.tokens;
	const percent = usage?.percent;
	const fromPercent =
		percent !== null && percent !== undefined && Number.isFinite(percent) && percent >= 0 &&
		Number.isFinite(contextWindow) && contextWindow > 0
			? Math.round((percent / 100) * contextWindow)
			: undefined;
	if (reported !== null && reported !== undefined && Number.isFinite(reported) && reported >= 0) {
		// 某些 Provider 会返回异常 totalTokens；与百分比明显矛盾时优先采用百分比。
		if (fromPercent !== undefined) {
			const tolerance = Math.max(32, Math.round(contextWindow * 0.001));
			if (Math.abs(reported - fromPercent) > tolerance) return fromPercent;
		}
		// 有效 usage 是权威值，不能被内容估算覆盖（图片等曾把估算吹大）。
		return reported;
	}
	return fromPercent ?? estimated;
}

export type ContextBreakdown = {
	/** Complete projected system state or a usable, projection-relative usage anchor. */
	hasReliablePiUsage: boolean;
	parts: ContextPart[];
	previews: Record<PreviewKey, string>;
};

function previewValue(value: unknown): string {
	if (typeof value === "string") return value;
	return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

/** 预览 message content：图片只展示有界元数据，绝不落入 base64。 */
function previewMessageContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value
			.map((block) => {
				if (!block || typeof block !== "object") return previewValue(block);
				const record = block as Record<string, unknown>;
				if (record.type === "text" && typeof record.text === "string") return record.text;
				if (record.type === "image") {
					const mimeType = typeof record.mimeType === "string" ? record.mimeType : "unknown";
					const data = typeof record.data === "string" ? record.data : "";
					return `[image ${mimeType}, ${data.length} base64 chars]`;
				}
				return previewValue(block);
			})
			.join("\n\n");
	}
	return previewValue(value);
}

/** 首条 system message 之后都是增量：在重放出的 prompt 后列出 sections 与工具变化。 */
function previewSystemUpdates(updates: readonly SystemMessage[]): string {
	return updates
		.slice(1)
		.map((message, index) => {
			const lines = [`## System update ${index + 2}`];
			const content = contentText(message.content).trim();
			if (content) lines.push("", content);
			const sections = Object.entries(message.sections ?? {}).map(([name, value]) =>
				value === null ? `${name} (removed)` : name,
			);
			if (sections.length > 0) lines.push("", `Sections: ${sections.join(", ")}`);
			const added = (message.toolsAdded ?? []).map((tool) => tool.name);
			const removed = (message.toolsRemoved ?? []).map((tool) => tool.name);
			if (added.length > 0) lines.push(`Tools added: ${added.join(", ")}`);
			if (removed.length > 0) lines.push(`Tools removed: ${removed.join(", ")}`);
			return lines.join("\n");
		})
		.join("\n\n");
}

/** 按真实请求的 systemPrompt、tools、messages 三部分同步组装计数与预览。 */
export function collectContextBreakdown(
	ctx: ExtensionCommandContext,
	allTools: ToolInfo[],
	projection: SessionProjection = ctx.sessionManager.buildSessionProjection(),
): ContextBreakdown {
	const options = (ctx.getSystemPromptOptions?.() ?? {}) as BuildSystemPromptOptions;
	// 0.87 起 provider context 以 SessionManager 投影为准：buildSessionProjection()
	// 会应用 context_edit（错误重试/长度恢复中废弃的消息不再计入），并且只有最新的
	// compaction 贡献快照。旧会话没有 system message 时回退到 getSystemPrompt()。
	const messages = projection.messages;
	const currentSystem = getCurrentSystemMessage(messages);
	const fallbackPrompt = typeof ctx.getSystemPrompt === "function" ? ctx.getSystemPrompt() : "";
	const systemPrompt = currentSystem ? getCurrentSystemPrompt(messages) : fallbackPrompt;
	const sections = currentSystem?.sections ?? {};
	const replayedTools = currentSystem ? getCurrentTools(messages) : [];
	const selectedTools = new Set(
		currentSystem
			? replayedTools.map((tool) => tool.name)
			: options.selectedTools ?? ["read", "bash", "edit", "write"],
	);
	const contextFiles = options.contextFiles ?? [];
	const skillFileReadTool = (["read", "bash"] as const).find((tool) => selectedTools.has(tool));

	// 转录里的 project_context / skills sections 是权威来源；旧会话按嵌入片段归属。
	const memoryTokens = currentSystem
		? tokenEstimate(sections.project_context)
		: contextFiles.reduce((sum, file) => sum + embeddedTokens(systemPrompt, file.content), 0);
	const renderedSkills = skillFileReadTool
		? formatSkillsForPrompt(options.skills ?? [], skillFileReadTool).trim()
		: "";
	const skillsTokens = currentSystem
		? tokenEstimate(sections.skills)
		: embeddedTokens(systemPrompt, renderedSkills);

	const memoryPreview: string[] = [];
	if (sections.project_context) {
		memoryPreview.push(sections.project_context);
	} else if (!currentSystem) {
		for (const file of contextFiles) {
			memoryPreview.push(`## ${file.path}\n\n${previewValue(file.content)}`);
		}
	}
	const skillsPreview = sections.skills ?? (currentSystem ? "" : renderedSkills);

	const toolDefinitionPreview: string[] = [];
	const toolResultPreview: string[] = [];
	const contextPreview: string[] = [];
	let toolDefinitionTokens = 0;
	let toolResultTokens = 0;
	let contextTokens = 0;

	const toolDefinitions = currentSystem
		? replayedTools
		: allTools.filter((tool) => selectedTools.has(tool.name));
	for (const tool of toolDefinitions) {
		const definition = {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		};
		toolDefinitionTokens += tokenEstimate(definition);
		toolDefinitionPreview.push(`## Definition: ${tool.name}\n\n${previewValue(definition)}`);
	}

	for (const message of messages) {
		if (message.role === "system") continue;
		if (message.role === "assistant") {
			contextTokens += estimateTokens(message);
			for (const block of message.content) {
				if (block.type === "toolCall") {
					contextPreview.push(`## Assistant tool call: ${block.name}\n\n${previewValue(block.arguments)}`);
				} else if (block.type === "text") {
					contextPreview.push(`## Assistant\n\n${block.text}`);
				} else if (block.type === "thinking") {
					contextPreview.push(`## Assistant thinking\n\n${block.thinking}`);
				}
			}
		} else if (message.role === "toolResult") {
			toolResultTokens += estimateTokens(message);
			toolResultPreview.push(
				`## Result: ${message.toolName}\n\n${previewMessageContent(message.content)}`,
			);
		} else if (message.role === "bashExecution") {
			toolResultTokens += estimateTokens(message);
			toolResultPreview.push(
				`## Bash\n\nCommand:\n\n${previewValue(message.command)}\n\nOutput:\n\n${previewValue(message.output)}`,
			);
		} else if (message.role === "branchSummary" || message.role === "compactionSummary") {
			contextTokens += estimateTokens(message);
			const label = message.role === "compactionSummary" ? "Compaction summary" : "Branch summary";
			contextPreview.push(`## ${label}\n\n${message.summary}`);
		} else if (message.role === "custom") {
			contextTokens += estimateTokens(message);
			contextPreview.push(`## Custom: ${message.customType}\n\n${previewMessageContent(message.content)}`);
		} else {
			contextTokens += estimateTokens(message);
			contextPreview.push(`## ${message.role}\n\n${previewMessageContent(message.content)}`);
		}
	}

	const systemTokens = Math.max(0, tokenEstimate(systemPrompt) - memoryTokens - skillsTokens);
	const systemUpdates = previewSystemUpdates(
		messages.filter((message): message is SystemMessage => message.role === "system"),
	);
	return {
		hasReliablePiUsage:
			messages.some((message) => message.role === "system") || hasContextUsageAnchor(projection, ctx.sessionManager.getBranch?.()),
		parts: [
			{ label: "System prompt", tokens: systemTokens, color: "accent" },
			{ label: "Memory", tokens: memoryTokens, color: "error" },
			{ label: "Skills", tokens: skillsTokens, color: "warning" },
			{ label: "Tools definition", tokens: toolDefinitionTokens, color: "success" },
			{ label: "Tool results", tokens: toolResultTokens, color: "customMessageLabel" },
			{ label: "Context", tokens: contextTokens, color: "warning" },
		] satisfies ContextPart[],
		previews: {
			systemPrompt: [systemPrompt, systemUpdates].filter(Boolean).join("\n\n") || "No system prompt.",
			memoryFiles: memoryPreview.join("\n\n") || "No memory files in context.",
			skills: skillsPreview || "No skills in context.",
			tools: toolDefinitionPreview.join("\n\n") || "No active tool definitions.",
			toolResults: toolResultPreview.join("\n\n") || "No tool results in the current context.",
			contextFiles: contextPreview.join("\n\n") || "No conversation context.",
		},
	};
}

export type ContextInspector = {
	snapshot: ContextSnapshot;
	breakdown: ContextBreakdown;
	parts: ContextPart[];
};

/** Category attribution is heuristic; the total/source follows active context, not billing. */
export function collectContextInspector(ctx: ExtensionCommandContext, tools: ToolInfo[]): ContextInspector {
	const projection = ctx.sessionManager.buildSessionProjection();
	const breakdown = collectContextBreakdown(ctx, tools, projection);
	const estimatedTokens = breakdown.parts.reduce((sum, part) => sum + part.tokens, 0);
	const snapshot = readContextSnapshot(ctx, { projection, estimatedTokens });
	const used = snapshot.tokens;
	const fixedTokens = breakdown.parts.slice(0, 4).reduce((sum, part) => sum + part.tokens, 0);
	const parts = used === undefined ? breakdown.parts : capParts(breakdown.parts, used, fixedTokens <= used ? 4 : 0);
	const attributed = parts.reduce((sum, part) => sum + part.tokens, 0);
	return {
		snapshot,
		breakdown,
		parts: [...parts,
			{ label: "Other", tokens: used === undefined ? 0 : Math.max(0, used - attributed), color: "muted" },
			{ label: "Free space", tokens: used === undefined ? 0 : Math.max(0, snapshot.contextWindow - used), color: "dim" },
		],
	};
}
