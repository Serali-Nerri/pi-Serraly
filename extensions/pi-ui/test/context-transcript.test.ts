// Adapted from pi-cc-extensions v0.8.69; see THIRD_PARTY_NOTICES.md.
// 0.86 会话转录用 system message 的 content/sections/toolsAdded/toolsRemoved
// 重放当前 prompt 与工具集；这里锁定 collectContextBreakdown 的归属与预览契约。
import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionProjection, formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import registerContext, { collectContextBreakdown, formatTokens, resolveUsedTokens } from "../src/config/context-command.ts";
import { config } from "../src/config/config.ts";

type TranscriptOptions = {
	selectedTools?: string[];
	contextFiles?: Array<{ path: string; content: string }>;
	skills?: unknown[];
	basePrompt?: string;
};

/** buildSessionProjection 沿 parentId 回溯；fixtures 默认都是 parentId: null，需要串成链。 */
function chain(entries: unknown[]): any[] {
	let parentId: string | null = null;
	return entries.map((entry) => {
		const source = entry as { id?: string };
		const chained = { ...(entry as Record<string, unknown>), parentId };
		parentId = source.id ?? parentId;
		return chained;
	});
}

function transcriptContext(entries: unknown[], options: TranscriptOptions = {}): any {
	const chained = chain(entries);
	return {
		getSystemPromptOptions: () => ({
			cwd: "/repo",
			selectedTools: options.selectedTools ?? [],
			contextFiles: options.contextFiles,
			skills: options.skills,
		}),
		getSystemPrompt: () => options.basePrompt ?? "",
		sessionManager: { buildSessionProjection: () => buildSessionProjection(chained) },
	} as any;
}

let entryId = 0;

function nextEntryId(prefix: string): string {
	entryId += 1;
	return `${prefix}-${entryId}`;
}

function systemEntry(message: Record<string, unknown>): unknown {
	return {
		type: "message",
		id: nextEntryId("system"),
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "system", content: "", timestamp: 1, ...message },
	};
}

function messageEntry(message: Record<string, unknown>): unknown {
	return {
		type: "message",
		id: nextEntryId("message"),
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { timestamp: 1, ...message },
	};
}

function customMessageEntry(customType: string, content: unknown): unknown {
	return {
		type: "custom_message",
		id: nextEntryId("custom"),
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		customType,
		content,
		display: true,
	};
}

function tool(name: string, description: string): Record<string, unknown> {
	return { name, description, parameters: { type: "object", properties: {} } };
}

function assistantEntry(tokens: number, stopReason = "stop"): unknown {
	return messageEntry({
		role: "assistant", content: [{ type: "text", text: "Fixture response" }], stopReason,
		usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens },
	});
}

async function commandOutput(ctx: any, tools: any[] = [], mode = "rpc"): Promise<string> {
	let handler: any;
	let output = "";
	registerContext({ registerCommand(_name: string, command: any) { handler = command.handler; },
		getAllTools: () => tools } as any);
	const enabled = config.enableContextCommand;
	config.enableContextCommand = true;
	try {
		await handler("", {
			...ctx, mode,
			ui: {
				notify(text: string) { output = text; },
				async custom(factory: any) {
					const identity = (_color: string, text: string) => text;
					const component = factory(
						{ terminal: { columns: 100, rows: 40 }, requestRender() {} },
						{ fg: identity, bg: identity, bold: (text: string) => text },
						{}, () => {},
					);
					output = component.render(64).join("\n");
				},
			},
		});
		return output;
	} finally {
		config.enableContextCommand = enabled;
	}
}

function definitionTokens(value: Record<string, unknown>): number {
	return Math.ceil(JSON.stringify(value).length / 4);
}

function partTokens(breakdown: any, label: string): number {
	return breakdown.parts.find((part: { label: string }) => part.label === label)?.tokens ?? -1;
}

test("system prompt sections replay into memory/skills attribution and delta preview", () => {
	const memory = "Project memory line";
	const skills = [{ name: "ok", description: "A skill", filePath: "/skills/ok/SKILL.md" }];
	const skillsText = formatSkillsForPrompt(skills as any, "read").trim();
	const preamble = "<preamble>\nbase prompt\n</preamble>";
	const projectContext = `<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="AGENTS.md">\n${memory}\n</project_instructions>\n</project_context>`;
	const skillsSection = `<skills>\n${skillsText}\n</skills>`;
	const cwdSection = "<cwd>\n/repo\n</cwd>";
	const readTool = tool("read", "Read a file");
	const writeTool = tool("write", "Write a file");
	const editTool = tool("edit", "Edit a file");
	const entries = [
		systemEntry({
			sections: { preamble, project_context: projectContext, skills: skillsSection },
			toolsAdded: [readTool, writeTool],
		}),
		messageEntry({ role: "user", content: "hello", timestamp: 2 }),
		systemEntry({
			sections: { cwd: cwdSection },
			toolsAdded: [editTool],
			toolsRemoved: [{ name: "write" }],
		}),
	];

	const breakdown = collectContextBreakdown(transcriptContext(entries), []);
	const replay = [preamble, projectContext, skillsSection, cwdSection].join("\n\n");

	assert.ok(breakdown.previews.systemPrompt.startsWith(replay));
	assert.match(breakdown.previews.systemPrompt, /## System update 2/);
	assert.match(breakdown.previews.systemPrompt, /Sections: cwd/);
	assert.match(breakdown.previews.systemPrompt, /Tools added: edit/);
	assert.match(breakdown.previews.systemPrompt, /Tools removed: write/);
	assert.equal(partTokens(breakdown, "Memory"), Math.ceil(projectContext.length / 4));
	assert.equal(partTokens(breakdown, "Skills"), Math.ceil(skillsSection.length / 4));
	assert.equal(
		partTokens(breakdown, "System prompt") + partTokens(breakdown, "Memory") + partTokens(breakdown, "Skills"),
		Math.ceil(replay.length / 4),
	);
	assert.ok(partTokens(breakdown, "System prompt") > 0);
	assert.match(breakdown.previews.memoryFiles, /<project_instructions path="AGENTS\.md">/);
	assert.match(breakdown.previews.memoryFiles, new RegExp(memory));
	assert.match(breakdown.previews.skills, /<name>ok<\/name>/);
});

test("current tool definitions come from transcript deltas, not the registry", () => {
	const writeTool = tool("write", "Write a file");
	const entries = [
		systemEntry({
			sections: { preamble: "<preamble>\nbase\n</preamble>" },
			toolsAdded: [tool("read", "Read a file"), writeTool],
		}),
		systemEntry({ toolsAdded: [tool("edit", "Edit a file")], toolsRemoved: [{ name: "write" }] }),
	];
	const readTool = tool("read", "Read a file");
	const editTool = tool("edit", "Edit a file");
	// getAllTools() 仍列出 write；转录增量才是请求里的真实工具集。
	const allTools = [readTool, writeTool] as any;

	const breakdown = collectContextBreakdown(transcriptContext(entries), allTools);

	assert.equal(
		partTokens(breakdown, "Tools definition"),
		definitionTokens(readTool) + definitionTokens(editTool),
	);
	assert.match(breakdown.previews.tools, /## Definition: read/);
	assert.match(breakdown.previews.tools, /## Definition: edit/);
	assert.doesNotMatch(breakdown.previews.tools, /## Definition: write/);
});

test("section removals drop memory attribution and preview", () => {
	const projectContext = `<project_context>\n<project_instructions path="AGENTS.md">\nmemory\n</project_instructions>\n</project_context>`;
	const entries = [
		systemEntry({ sections: { preamble: "<preamble>\nbase\n</preamble>", project_context: projectContext } }),
		systemEntry({ sections: { project_context: null } }),
	];

	const breakdown = collectContextBreakdown(transcriptContext(entries, {
		contextFiles: [{ path: "AGENTS.md", content: "memory" }],
	}), []);

	assert.equal(partTokens(breakdown, "Memory"), 0);
	assert.doesNotMatch(breakdown.previews.systemPrompt, /memory/);
	assert.match(breakdown.previews.systemPrompt, /## System update 2/);
	assert.match(breakdown.previews.systemPrompt, /Sections: project_context \(removed\)/);
	assert.equal(breakdown.previews.memoryFiles, "No memory files in context.");
});

test("compaction snapshot is the replay base and later patches still apply", () => {
	const memory = "compacted memory";
	const skills = [{ name: "ok", description: "A skill", filePath: "/skills/ok/SKILL.md" }];
	const skillsText = formatSkillsForPrompt(skills as any, "read").trim();
	const preamble = "<preamble>\ncompacted base\n</preamble>";
	const projectContext = `<project_context>\n<project_instructions path="AGENTS.md">\n${memory}\n</project_instructions>\n</project_context>`;
	const skillsSection = `<skills>\n${skillsText}\n</skills>`;
	const entries = [
		{
			type: "compaction",
			id: "compaction-1",
			parentId: null,
			timestamp: "2026-01-01T00:01:00.000Z",
			summary: "old summary",
			firstKeptEntryId: "kept-1",
			tokensBefore: 5_000,
			systemMessage: {
				role: "system",
				content: "",
				sections: { preamble, project_context: projectContext },
				toolsAdded: [tool("read", "Read a file")],
				timestamp: 1,
			},
		},
		{ ...(messageEntry({ role: "user", content: "after compaction", timestamp: 2 }) as any), id: "kept-1" },
		systemEntry({ sections: { skills: skillsSection } }),
	];

	const breakdown = collectContextBreakdown(
		transcriptContext(entries, { basePrompt: "SHOULD NOT BE USED" }),
		[],
	);
	const replay = [preamble, projectContext, skillsSection].join("\n\n");

	assert.ok(breakdown.previews.systemPrompt.startsWith(replay));
	assert.doesNotMatch(breakdown.previews.systemPrompt, /SHOULD NOT BE USED/);
	assert.equal(partTokens(breakdown, "Memory"), Math.ceil(projectContext.length / 4));
	assert.equal(partTokens(breakdown, "Skills"), Math.ceil(skillsSection.length / 4));
	assert.match(breakdown.previews.systemPrompt, /## System update 2/);
	assert.match(breakdown.previews.contextFiles, /## Compaction summary/);
	assert.match(breakdown.previews.contextFiles, /after compaction/);
	assert.equal(partTokens(breakdown, "Tool results"), 0);
	assert.equal(partTokens(breakdown, "Context"), Math.ceil("after compaction".length / 4) + Math.ceil("old summary".length / 4));
});

test("compaction without a snapshot falls back to the rebuilt base prompt", () => {
	const entries = [
		{
			type: "compaction",
			id: "compaction-1",
			parentId: null,
			timestamp: "2026-01-01T00:01:00.000Z",
			summary: "old",
			firstKeptEntryId: "kept-1",
			tokensBefore: 100,
		},
		{ ...(messageEntry({ role: "user", content: "hi", timestamp: 2 }) as any), id: "kept-1" },
	];

	const breakdown = collectContextBreakdown(
		transcriptContext(entries, { basePrompt: "rebuilt base prompt", selectedTools: ["read"] }),
		[],
	);

	assert.equal(breakdown.previews.systemPrompt, "rebuilt base prompt");
	assert.equal(partTokens(breakdown, "System prompt"), Math.ceil("rebuilt base prompt".length / 4));
	assert.equal(partTokens(breakdown, "Context"), 1 + Math.ceil("old".length / 4));
	assert.doesNotMatch(breakdown.previews.systemPrompt, /## System update/);
});

test("null and missing message content are normalized instead of crashing or inflating", () => {
	const entries = [
		messageEntry({ role: "user", content: null, timestamp: 1 }),
		messageEntry({ role: "assistant", content: null, timestamp: 2 }),
		messageEntry({ role: "toolResult", toolCallId: "call-1", toolName: "read", content: null, isError: false, timestamp: 3 }),
		customMessageEntry("note", null),
	];

	const breakdown = collectContextBreakdown(transcriptContext(entries), []);

	assert.equal(partTokens(breakdown, "Context"), 0);
	assert.equal(partTokens(breakdown, "Tool results"), 0);
	assert.match(breakdown.previews.contextFiles, /## user/);
	assert.match(breakdown.previews.contextFiles, /## Custom: note/);
	assert.match(breakdown.previews.toolResults, /## Result: read/);
});

test("image content estimates bounded tokens and previews only metadata", () => {
	const png = "A".repeat(8_000);
	const entries = [
		messageEntry({
			role: "user",
			content: [
				{ type: "text", text: "look" },
				{ type: "image", data: png, mimeType: "image/png" },
			],
			timestamp: 1,
		}),
		customMessageEntry("screenshot", [{ type: "image", data: "B".repeat(400), mimeType: "image/jpeg" }]),
		messageEntry({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "image", data: png, mimeType: "image/png" }],
			isError: false,
			timestamp: 3,
		}),
	];

	const breakdown = collectContextBreakdown(transcriptContext(entries), []);

	// upstream estimateTokens：每张图片按 4800 字符折算，绝不按 base64 长度计算。
	assert.equal(partTokens(breakdown, "Context"), Math.ceil((4 + 4_800) / 4) + 1_200);
	assert.equal(partTokens(breakdown, "Tool results"), 1_200);
	assert.match(breakdown.previews.contextFiles, /\[image image\/png, 8000 base64 chars\]/);
	assert.match(breakdown.previews.contextFiles, /\[image image\/jpeg, 400 base64 chars\]/);
	assert.match(breakdown.previews.toolResults, /\[image image\/png, 8000 base64 chars\]/);
	assert.doesNotMatch(breakdown.previews.contextFiles, /AAAA/);
	assert.doesNotMatch(breakdown.previews.toolResults, /AAAA/);
});

for (const mode of ["rpc", "tui"]) {
	test(`fresh context command retains prompt, memory, skills and tools despite zero Pi usage (${mode})`, async () => {
		const memory = "Startup memory";
		const skills = [{ name: "review", description: "Review changes", filePath: "/skills/review/SKILL.md" }];
		const skillsText = formatSkillsForPrompt(skills as any, "read").trim();
		const ctx = {
			...transcriptContext([], {
				basePrompt: `Base instructions\n${memory}\n${skillsText}`,
				contextFiles: [{ path: "AGENTS.md", content: memory }], skills, selectedTools: ["read"],
			}),
			getContextUsage: () => ({ tokens: 0, percent: 0, contextWindow: 1_000_000 }),
		};
		const tools = [tool("read", "Read a file")];
		const breakdown = collectContextBreakdown(ctx, tools as any);
		const output = await commandOutput(ctx, tools, mode);
		for (const part of breakdown.parts.slice(0, 4)) {
			assert.ok(part.tokens > 0);
			assert.match(output, new RegExp(`${part.label}:?\\s+${formatTokens(part.tokens)}\\b`));
		}
		if (mode === "tui") {
			const estimated = breakdown.parts.reduce((sum, part) => sum + part.tokens, 0);
			assert.ok(output.includes(`${formatTokens(estimated)} / 1000k tokens`));
		}
	});
}

for (const entries of [
	[customMessageEntry("startup", "Startup note")],
	[messageEntry({ role: "user", content: "Pending prompt" }), assistantEntry(0)],
	[assistantEntry(100, "error")],
	[assistantEntry(100, "aborted")],
]) {
	test(`context command uses complete estimates without a projected system prompt (${(entries.at(-1) as any).message?.stopReason ?? "custom"})`, async () => {
		const output = await commandOutput({
			...transcriptContext(entries, { basePrompt: "x".repeat(400) }),
			// 投影里没有 system message 时 Pi 只估算消息内容，不能作为完整上下文使用。
			getContextUsage: () => ({ tokens: 4, percent: 0.4, contextWindow: 1_000 }),
		});
		assert.match(output, /System prompt: 100 tokens/);
		assert.doesNotMatch(output, /Context: 0 tokens/);
	});
}

test("context command keeps reported usage even below fixed category estimates", async () => {
	// 旧会话没有 system message，但有效 assistant usage 仍让 Pi 的用量可信。
	const output = await commandOutput({
		...transcriptContext([assistantEntry(100)], { basePrompt: "x".repeat(40_000) }),
		getContextUsage: () => ({ tokens: 100, percent: 10, contextWindow: 1_000 }),
	});
	assert.match(output, /System prompt: 100 tokens/);
	assert.match(output, /Free space: 900 tokens/);
});

test("context command falls back after compaction invalidates earlier assistant usage", async () => {
	const output = await commandOutput({
		...transcriptContext([assistantEntry(100)], { basePrompt: "x".repeat(400) }),
		getContextUsage: () => ({ tokens: null, percent: null, contextWindow: 1_000 }),
	});
	assert.match(output, /System prompt: 100 tokens/);
	assert.match(output, /Context: 4 tokens/);
	assert.match(output, /Free space: 896 tokens/);
});

test("invalid context percentages fall back to finite estimates", () => {
	for (const percent of [NaN, Infinity, -1]) {
		assert.equal(resolveUsedTokens({ tokens: null, percent }, 1200, 200_000), 1200);
		assert.equal(resolveUsedTokens({ tokens: 500, percent }, 1200, 200_000), 500);
	}
});

test("valid image-heavy usage is not replaced by inflated content estimates", () => {
	const entries = [
		messageEntry({
			role: "user",
			content: [{ type: "image", data: "C".repeat(40_000), mimeType: "image/png" }],
			timestamp: 1,
		}),
	];

	const breakdown = collectContextBreakdown(transcriptContext(entries), []);
	const estimated = breakdown.parts.reduce((sum, part) => sum + part.tokens, 0);
	assert.equal(estimated, 1_200);
	assert.equal(resolveUsedTokens({ tokens: 2_000, percent: (2_000 / 272_000) * 100 }, estimated, 272_000), 2_000);
});

test("fallback skills prompt follows the selected read/bash tool", () => {
	const skills = [{ name: "ok", description: "desc", filePath: "/v" }];
	const baseSkills = formatSkillsForPrompt(skills as any, "bash").trim();
	const basePrompt = `base\n<skills>\n${baseSkills}\n</skills>`;

	const bashBreakdown = collectContextBreakdown(
		transcriptContext([], { selectedTools: ["bash"], skills, basePrompt }),
		[],
	);
	assert.match(bashBreakdown.previews.skills, /Use bash to load a skill's file/);
	assert.doesNotMatch(bashBreakdown.previews.skills, /read tool/);
	assert.equal(partTokens(bashBreakdown, "Skills"), Math.ceil(baseSkills.length / 4));

	// read/bash 都未选中时上游根本不渲染 skills section，这里也不能归属 tokens。
	const readSkills = formatSkillsForPrompt(skills as any, "read").trim();
	const noneBreakdown = collectContextBreakdown(
		transcriptContext([], {
			selectedTools: ["grep"],
			skills,
			basePrompt: `base\n<skills>\n${readSkills}\n</skills>`,
		}),
		[],
	);
	assert.equal(partTokens(noneBreakdown, "Skills"), 0);
	assert.equal(noneBreakdown.previews.skills, "No skills in context.");
});

test("context edits omit abandoned assistant turns from context attribution", () => {
	const entries = [
		systemEntry({ sections: { preamble: "<preamble>\nbase\n</preamble>" } }),
		messageEntry({ role: "user", content: "keep me", timestamp: 2 }),
		{ ...(assistantEntry(100) as any), id: "abandoned-assistant" },
		{
			type: "context_edit",
			id: "edit-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:03.000Z",
			targetId: "abandoned-assistant",
			replacement: null,
		},
		messageEntry({ role: "user", content: "real prompt", timestamp: 4 }),
	];

	const breakdown = collectContextBreakdown(transcriptContext(entries), []);

	assert.doesNotMatch(breakdown.previews.contextFiles, /Fixture response/);
	assert.match(breakdown.previews.contextFiles, /keep me/);
	assert.match(breakdown.previews.contextFiles, /real prompt/);
});

test("context edits omit abandoned tool results from tool-result attribution", () => {
	const entries = [
		systemEntry({ sections: { preamble: "<preamble>\nbase\n</preamble>" } }),
		messageEntry({
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a" } }],
			timestamp: 2,
		}),
		{
			...(messageEntry({
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: "discarded output",
				isError: false,
				timestamp: 3,
			}) as any),
			id: "abandoned-tool-result",
		},
		{
			type: "context_edit",
			id: "edit-2",
			parentId: null,
			timestamp: "2026-01-01T00:00:04.000Z",
			targetId: "abandoned-tool-result",
			replacement: null,
		},
		messageEntry({ role: "user", content: "after", timestamp: 5 }),
	];

	const breakdown = collectContextBreakdown(transcriptContext(entries), []);

	assert.equal(partTokens(breakdown, "Tool results"), 0);
	assert.doesNotMatch(breakdown.previews.toolResults, /discarded output/);
});

test("context edit replacements replace the target content in previews", () => {
	const entries = [
		systemEntry({ sections: { preamble: "<preamble>\nbase\n</preamble>" } }),
		{ ...(messageEntry({ role: "user", content: "original content", timestamp: 2 }) as any), id: "editable-user" },
		{
			type: "context_edit",
			id: "edit-3",
			parentId: null,
			timestamp: "2026-01-01T00:00:03.000Z",
			targetId: "editable-user",
			replacement: { content: [{ type: "text", text: "[trimmed]" }] },
		},
	];

	const breakdown = collectContextBreakdown(transcriptContext(entries), []);

	assert.match(breakdown.previews.contextFiles, /\[trimmed\]/);
	assert.doesNotMatch(breakdown.previews.contextFiles, /original content/);
});

test("retained older compaction snapshots no longer contribute to context", () => {
	const entries = [
		systemEntry({ sections: { preamble: "<preamble>\nbase\n</preamble>" } }),
		{
			type: "compaction",
			id: "compaction-old",
			parentId: null,
			timestamp: "2026-01-01T00:01:00.000Z",
			summary: "old summary",
			firstKeptEntryId: "kept-user",
			tokensBefore: 100,
		},
		{ ...(messageEntry({ role: "user", content: "kept message", timestamp: 2 }) as any), id: "kept-user" },
		{
			type: "compaction",
			id: "compaction-new",
			parentId: null,
			timestamp: "2026-01-01T00:02:00.000Z",
			summary: "new summary",
			firstKeptEntryId: "compaction-old",
			tokensBefore: 200,
		},
		messageEntry({ role: "user", content: "after", timestamp: 4 }),
	];

	const breakdown = collectContextBreakdown(transcriptContext(entries), []);

	assert.match(breakdown.previews.contextFiles, /new summary/);
	assert.doesNotMatch(breakdown.previews.contextFiles, /old summary/);
	assert.match(breakdown.previews.contextFiles, /kept message/);
});

for (const [kind, entries, usage, label] of [
	["actual", [assistantEntry(100)], { tokens: 100, percent: 10, contextWindow: 1_000 }, "Actual"],
	["mixed", [assistantEntry(100), messageEntry({ role: "user", content: "12345678" })], { tokens: 102, percent: 10.2, contextWindow: 1_000 }, "Mixed (actual + estimated)"],
	["estimated", [messageEntry({ role: "user", content: "12345678" })], { tokens: 2, percent: 0.2, contextWindow: 1_000 }, "Estimated"],
	["unknown", [], { tokens: null, percent: null, contextWindow: 1_000 }, "Unknown"],
] as const) {
	for (const mode of ["rpc", "tui"]) {
		test(`context command source label is ${kind} (${mode})`, async () => {
			const output = await commandOutput({ ...transcriptContext([...entries]), getContextUsage: () => usage }, [], mode);
			assert.ok(output.includes(`Source: ${label}`), output);
			if (kind === "unknown" && mode === "tui") assert.ok(output.includes("? / 1.0k tokens (?%)"), output);
		});
	}
}
