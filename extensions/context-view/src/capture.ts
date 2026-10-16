/**
 * Latest request capture state and conversion from pi event data to the
 * semantic model. Event registration remains in index.ts; this module is
 * independently unit-testable.
 */
import {
	type BuildSystemPromptOptions,
	type ContextEvent,
	estimateTokens,
	formatSize,
	type SlashCommandInfo,
	type SourceInfo,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";

import { analyzeSystemPrompt, type PromptOptionsSlice, textTokens, type ToolSlice } from "./measure.ts";
import { copySystemMessage, messageContentText, replaySystemMessages, systemMessageText } from "./transcript.ts";
import {
	AGGREGATE_SOURCE,
	buildSnapshot,
	type CaptureOrigin,
	type RequestSnapshot,
	type InjectionItem,
	type InjectionSource,
	type JsonSpan,
} from "./model.ts";
import type { PromptSourceSlice } from "./prompt-additions.ts";

/** Everything available when a context event finalizes the latest snapshot. */
export interface CaptureFinalization {
	systemPrompt: string;
	messages: ContextEvent["messages"];
	baselineMessages: ContextEvent["messages"];
	allTools: readonly ToolInfo[];
	activeToolNames: readonly string[];
	/** Loaded extension provenance, used only to guess who appended prompt text. */
	promptSources?: readonly PromptSourceSlice[];
	origin: CaptureOrigin;
	capturedAt?: Date;
	/** Session, branch leaf, and model the captured request was prepared for. */
	sessionId?: string;
	leafId?: string;
	modelKey?: string;
}

/** Session identity a capture describes; any missing part is not checked. */
export interface CaptureIdentity {
	readonly sessionId?: string;
	readonly leafId?: string;
	readonly modelKey?: string;
}

/** Inputs for an on-demand pi-native prompt/tool snapshot. */
export interface NativeSnapshotInput {
	systemPrompt: string;
	options: BuildSystemPromptOptions;
	allTools: readonly ToolInfo[];
	activeToolNames: readonly string[];
	/** Standalone tool declarations pi hid from this run's model. */
	hiddenToolNames?: readonly string[];
	/** Loaded extension provenance, used only to guess who appended prompt text. */
	promptSources?: readonly PromptSourceSlice[];
	capturedAt?: Date;
}

/** Owned structured inputs prepared before later extension handlers can mutate shared event data. */
interface CapturePreparation {
	readonly promptOptions: PromptOptionsSlice;
	readonly toolSnippets?: Readonly<Record<string, string>>;
	/** Standalone tool declarations pi hid from this run's model. */
	readonly hiddenToolNames: readonly string[];
	/** Prompt as of this extension's own handler, bounding later extensions' additions. */
	readonly promptAtHandler?: string;
}

/**
 * Latest-request capture state: every normal request replaces the previous
 * snapshot, so the views describe the context as it was last prepared rather
 * than the first turn. `prepare()` refreshes the structured options on every
 * run; `finalize()` either replaces the snapshot or discards it.
 */
export class LatestCaptureState {
	private pendingPreparation: CapturePreparation | undefined;
	private latestSnapshot: RequestSnapshot | undefined;
	private latestMessages: ContextEvent["messages"] | undefined;
	private captureIdentity: CaptureIdentity | undefined;

	/** The latest captured snapshot, or undefined until `finalize()` succeeds. */
	public get snapshot(): RequestSnapshot | undefined {
		return this.latestSnapshot;
	}

	/** Messages of the captured request, aligned with `snapshot`'s message items. */
	public get messages(): ContextEvent["messages"] | undefined {
		return this.latestMessages;
	}

	/** Session identity the snapshot describes; undefined when no capture exists. */
	public get identity(): CaptureIdentity | undefined {
		return this.captureIdentity;
	}

	/**
	 * Own the structured prompt inputs from `before_agent_start`, replacing any
	 * previous run's. `promptAtHandler` is the chained prompt as this extension
	 * observed it, which separates additions made before this extension loaded
	 * from those made after it.
	 */
	public prepare(options: BuildSystemPromptOptions, promptAtHandler?: string): void {
		this.pendingPreparation = {
			promptOptions: copyPromptOptions(options),
			toolSnippets: options.toolSnippets === undefined ? undefined : { ...options.toolSnippets },
			hiddenToolNames: [...(options.hiddenTools ?? [])],
			promptAtHandler,
		};
	}

	/**
	 * Replace the snapshot with this request's, or discard the previous one when
	 * the request could not be measured, so stale state never masquerades as the
	 * current request. Returns undefined when `prepare()` never ran.
	 */
	public finalize(buildInput: () => CaptureFinalization): RequestSnapshot | undefined {
		this.latestSnapshot = undefined;
		this.latestMessages = undefined;
		this.captureIdentity = undefined;
		if (this.pendingPreparation === undefined) return undefined;

		const input = buildInput();
		const preparation = this.pendingPreparation;
		const tools = captureActiveTools(input.allTools, input.activeToolNames, {
			toolSnippets: preparation.toolSnippets,
			hiddenToolNames: preparation.hiddenToolNames,
		});
		const items = [
			...analyzeSystemPrompt(input.systemPrompt, preparation.promptOptions, tools, {
				sources: input.promptSources,
				promptAtHandler: preparation.promptAtHandler,
			}),
			...measureInjectedMessages(input.messages, input.baselineMessages),
		];
		this.latestSnapshot = buildSnapshot(items, input.origin, input.capturedAt ?? new Date());
		this.latestMessages = input.messages;
		this.captureIdentity = { sessionId: input.sessionId, leafId: input.leafId, modelKey: input.modelKey };
		return this.latestSnapshot;
	}

	/** Drop captured content when its session ends. */
	public clear(): void {
		this.pendingPreparation = undefined;
		this.latestSnapshot = undefined;
		this.latestMessages = undefined;
		this.captureIdentity = undefined;
	}
}

/** Build a view-local pi-native snapshot without touching the main capture state. */
export function buildNativeSnapshot(input: NativeSnapshotInput): RequestSnapshot {
	const options = copyPromptOptions(input.options);
	const tools = captureActiveTools(input.allTools, input.activeToolNames, {
		toolSnippets: input.options.toolSnippets,
		hiddenToolNames: input.hiddenToolNames,
	});
	const items = analyzeSystemPrompt(input.systemPrompt, options, tools, { sources: input.promptSources });
	return buildSnapshot(items, "session-estimate", input.capturedAt ?? new Date());
}

/** Inputs for Usage's branch-local prompt/tool estimate when no capture exists. */
export interface UsageSnapshotInput extends NativeSnapshotInput {
	messages: ContextEvent["messages"];
}

/**
 * Use replayed transcript state instead of today's loader prompt/tools when
 * available: the branch's recorded system messages describe the prompt the
 * session carries, not the one the current configuration would render.
 */
export function buildUsageSnapshot(input: UsageSnapshotInput): RequestSnapshot {
	const state = replaySystemMessages(input.messages);
	if (state === undefined) return buildNativeSnapshot(input);
	const registered = new Map(input.allTools.map((tool) => [tool.name, tool]));
	const tools: ToolSlice[] = state.tools.map((tool) => {
		const metadata = registered.get(tool.name);
		const snippetLine = state.sections.tools?.split("\n").find((line) => line.startsWith(`- ${tool.name}: `));
		return {
			name: tool.name,
			description: tool.description,
			parametersJson: JSON.stringify(tool.parameters),
			snippet: snippetLine?.slice(`- ${tool.name}: `.length),
			guidelines: normalizeGuidelines(metadata?.promptGuidelines),
			source: metadata?.sourceInfo.source ?? "unattributed",
		};
	});
	const options = copyPromptOptions(input.options);
	const items = analyzeSystemPrompt(systemMessageText(state), {
		...options,
		// Current loader overrides are not evidence of what this branch recorded.
		customPrompt: undefined, appendSystemPrompt: undefined, sections: undefined,
	}, tools, { sources: input.promptSources });
	return buildSnapshot(items, "session-estimate", input.capturedAt ?? new Date());
}

/** Copy the prompt-options slice used by measurement, without shared nested references. */
export function copyPromptOptions(options: BuildSystemPromptOptions): PromptOptionsSlice {
	return {
		cwd: options.cwd,
		homeDir: process.env.HOME,
		customPrompt: options.customPrompt,
		appendSystemPrompt: options.appendSystemPrompt,
		sections: options.sections === undefined ? undefined : { ...options.sections },
		contextFilePaths: options.contextFiles?.map((file) => file.path),
		skills: options.skills
			?.filter((skill) => !skill.disableModelInvocation)
			.map((skill) => ({
				name: skill.name,
				description: skill.description,
				filePath: skill.filePath,
			})),
	};
}

/**
 * Collect the provenance of every loaded extension that registered a tool or a
 * command, together with the names it registered. It is the only extension
 * roster pi exposes, and it feeds attribution guesses alone: extensions
 * registering neither are invisible here.
 */
export function collectPromptSources(
	allTools: readonly ToolInfo[],
	commands: readonly SlashCommandInfo[],
): PromptSourceSlice[] {
	const sources = new Map<string, CollectedPromptSource>();
	for (const tool of allTools) addPromptSource(sources, tool.sourceInfo, tool.name);
	// Prompt text refers to a command the way a user types it, so keep its slash.
	for (const command of commands) {
		addPromptSource(sources, command.sourceInfo, command.name.startsWith("/") ? command.name : `/${command.name}`);
	}
	return [...sources.values()];
}

/** Slice under construction: its names arrive one tool or command at a time. */
interface CollectedPromptSource extends Omit<PromptSourceSlice, "names"> {
	readonly names: string[];
}

/** Record one registered name under its extension's provenance, skipping pi's own sources. */
function addPromptSource(
	sources: Map<string, CollectedPromptSource>,
	sourceInfo: SourceInfo,
	name: string,
): void {
	if (sourceInfo.source === "builtin" || sourceInfo.source === "sdk") return;
	const key = `${sourceInfo.source}\n${sourceInfo.path}`;
	let collected = sources.get(key);
	if (collected === undefined) {
		collected = {
			source: sourceInfo.source,
			path: sourceInfo.path,
			// A top-level extension's baseDir is a shared directory, not its own root.
			baseDir: sourceInfo.origin === "package" ? sourceInfo.baseDir : undefined,
			names: [],
		};
		sources.set(key, collected);
	}
	if (!collected.names.includes(name)) collected.names.push(name);
}

/**
 * Snapshot the final active tool set with provenance and payload definitions.
 * Keep pi's active-tool order: it decides which tool owns a guideline bullet
 * that several tools declare.
 */
export function captureActiveTools(
	allTools: readonly ToolInfo[],
	activeToolNames: readonly string[],
	options: {
		readonly toolSnippets?: Readonly<Record<string, string>>;
		readonly hiddenToolNames?: readonly string[];
	},
): ToolSlice[] {
	const byName = new Map(allTools.map((tool) => [tool.name, tool]));
	const hidden = new Set(options.hiddenToolNames ?? []);
	return [...new Set(activeToolNames)]
		.map((name) => byName.get(name))
		.filter((tool) => tool !== undefined)
		.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parametersJson: JSON.stringify(tool.parameters ?? {}),
			snippet: options.toolSnippets?.[tool.name],
			guidelines: normalizeGuidelines(tool.promptGuidelines),
			source: tool.sourceInfo.source,
			hidden: hidden.has(tool.name) || undefined,
		}));
}

/**
 * Measure the messages this request carries beyond the saved session
 * projection: additions, replacements, and removals. Unchanged session history
 * is not reported; custom messages follow the same rule rather than being
 * assumed request-only.
 */
export function measureInjectedMessages(
	messages: ContextEvent["messages"],
	baselineMessages: ContextEvent["messages"],
): InjectionItem[] {
	const occurrences = new Map<string, number>();
	const items: InjectionItem[] = [];
	for (const delta of diffRequestMessages(messages, baselineMessages)) {
		const current = delta.current;
		const saved = delta.saved;
		const sample = current ?? saved;
		if (sample === undefined) continue;
		const identity = sample.role === "custom" ? sample.customType : sample.role;
		const occurrence = occurrences.get(identity) ?? 0;
		occurrences.set(identity, occurrence + 1);
		const savedPreview = saved === undefined ? undefined : messagePreview(saved);
		const currentPreview = current === undefined ? undefined : messagePreview(current);
		const preview = currentPreview ?? savedPreview ?? { text: "" };
		items.push({
			id: `message:${delta.kind}:${identity}:${occurrence}`,
			phase: "request",
			kind: "message",
			source: sample.role === "custom" ? messageSource(sample.customType) : AGGREGATE_SOURCE,
			label: sample.role === "custom" ? "message" : `${sample.role} message`,
			chars: preview.text.length,
			tokens: current === undefined
				? 0
				: current.role === "system" ? textTokens(systemMessageText(current)) : estimateTokens(current),
			text: preview.text,
			jsonSpan: preview.jsonSpan,
			change: { kind: delta.kind, before: savedPreview?.text ?? "", after: currentPreview?.text ?? "" },
			requestOnly: delta.kind === "added" || undefined,
			systemMessage: current?.role === "system" ? { message: copySystemMessage(current), index: delta.index } : undefined,
		});
	}
	return items;
}

/** One request message's relationship to the saved session projection. */
interface MessageDelta {
	readonly kind: "added" | "modified" | "removed";
	/** Request message for additions and replacements; undefined for removals. */
	readonly current?: ContextEvent["messages"][number];
	/** Saved projection message for replacements and removals; undefined for additions. */
	readonly saved?: ContextEvent["messages"][number];
	/** Index in the request messages for additions and replacements, else in the saved projection. */
	readonly index: number;
}

/**
 * Classify each request message against the saved session projection with an
 * order-preserving common-subsequence alignment, so an insertion or removal
 * does not misattribute every later message.
 */
export function diffRequestMessages(
	messages: ContextEvent["messages"],
	baselineMessages: ContextEvent["messages"],
): MessageDelta[] {
	const pairs = commonSubsequencePairs(
		messages.map(messageFingerprint),
		baselineMessages.map(messageFingerprint),
	);
	const deltas: MessageDelta[] = [];
	let requestCursor = 0;
	let baselineCursor = 0;
	const emitGap = (requestEnd: number, baselineEnd: number): void => {
		const requestGap = messages.slice(requestCursor, requestEnd);
		const baselineGap = baselineMessages.slice(baselineCursor, baselineEnd);
		let paired = 0;
		// A same-role pair inside one gap is the same turn edited or re-emitted.
		while (
			paired < requestGap.length && paired < baselineGap.length
			&& requestGap[paired]?.role === baselineGap[paired]?.role
		) {
			deltas.push({
				kind: "modified",
				current: requestGap[paired],
				saved: baselineGap[paired],
				index: requestCursor + paired,
			});
			paired++;
		}
		for (let index = paired; index < baselineGap.length; index++) {
			deltas.push({ kind: "removed", saved: baselineGap[index], index: baselineCursor + index });
		}
		for (let index = paired; index < requestGap.length; index++) {
			deltas.push({ kind: "added", current: requestGap[index], index: requestCursor + index });
		}
	};
	for (const [requestIndex, baselineIndex] of pairs) {
		emitGap(requestIndex, baselineIndex);
		requestCursor = requestIndex + 1;
		baselineCursor = baselineIndex + 1;
	}
	emitGap(messages.length, baselineMessages.length);
	return deltas;
}

/** Cheap content fingerprint; a collision only risks reporting a real change as unchanged. */
function messageFingerprint(message: ContextEvent["messages"][number]): number {
	const text = JSON.stringify(message);
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash;
}

/**
 * Order-preserving index pairs of equal fingerprints. Hirschberg recursion
 * keeps memory linear in the shorter sequence instead of allocating the full
 * comparison table for long sessions.
 */
function commonSubsequencePairs(left: readonly number[], right: readonly number[]): Array<readonly [number, number]> {
	const pairs: Array<readonly [number, number]> = [];
	collectPairs(left, 0, left.length, right, 0, right.length, pairs);
	return pairs;
}

function collectPairs(
	left: readonly number[],
	leftStart: number,
	leftEnd: number,
	right: readonly number[],
	rightStart: number,
	rightEnd: number,
	pairs: Array<readonly [number, number]>,
): void {
	if (leftStart >= leftEnd || rightStart >= rightEnd) return;
	if (leftEnd - leftStart === 1) {
		for (let index = rightStart; index < rightEnd; index++) {
			if (right[index] === left[leftStart]) {
				pairs.push([leftStart, index]);
				return;
			}
		}
		return;
	}
	const middle = Math.floor((leftStart + leftEnd) / 2);
	const prefix = commonPrefixLengths(left, leftStart, middle, right, rightStart, rightEnd);
	const suffix = commonSuffixLengths(left, middle, leftEnd, right, rightStart, rightEnd);
	const total = rightEnd - rightStart;
	let split = 0;
	let best = -1;
	for (let count = 0; count <= total; count++) {
		const score = (prefix[count] ?? 0) + (suffix[count] ?? 0);
		if (score > best) {
			best = score;
			split = count;
		}
	}
	collectPairs(left, leftStart, middle, right, rightStart, rightStart + split, pairs);
	collectPairs(left, middle, leftEnd, right, rightStart + split, rightEnd, pairs);
}

/** LCS lengths of one left slice against every prefix of the right slice. */
function commonPrefixLengths(
	left: readonly number[],
	leftStart: number,
	leftEnd: number,
	right: readonly number[],
	rightStart: number,
	rightEnd: number,
): Uint32Array {
	const length = rightEnd - rightStart;
	const previous = new Uint32Array(length + 1);
	const current = new Uint32Array(length + 1);
	for (let i = leftStart; i < leftEnd; i++) {
		for (let j = 0; j < length; j++) {
			current[j + 1] = left[i] === right[rightStart + j]
				? (previous[j] ?? 0) + 1
				: Math.max(previous[j + 1] ?? 0, current[j] ?? 0);
		}
		previous.set(current);
	}
	return previous;
}

/** LCS lengths of one left slice against every suffix of the right slice. */
function commonSuffixLengths(
	left: readonly number[],
	leftStart: number,
	leftEnd: number,
	right: readonly number[],
	rightStart: number,
	rightEnd: number,
): Uint32Array {
	const length = rightEnd - rightStart;
	const previous = new Uint32Array(length + 1);
	const current = new Uint32Array(length + 1);
	for (let i = leftEnd - 1; i >= leftStart; i--) {
		for (let j = length - 1; j >= 0; j--) {
			current[j] = left[i] === right[rightStart + j]
				? (previous[j + 1] ?? 0) + 1
				: Math.max(previous[j] ?? 0, current[j + 1] ?? 0);
		}
		previous.set(current);
	}
	return previous;
}

/** Provider-bound message content for raw preview, with any serialization marked as JSON. */
interface MessagePreview {
	readonly text: string;
	readonly jsonSpan?: JsonSpan;
}

/** Extract content-only previews without raw image payloads or opaque assistant signatures. */
function messagePreview(message: ContextEvent["messages"][number]): MessagePreview {
	if (message.role === "system") return { text: systemMessageText(message) };
	if (message.role === "branchSummary" || message.role === "compactionSummary") {
		return { text: message.summary };
	}
	if (message.role === "bashExecution") {
		return { text: messageContentText(message) };
	}
	if (typeof message.content === "string") return { text: message.content };
	if (message.role === "assistant") {
		const content = message.content.map((block) => {
			if (block.type === "text") {
				const { textSignature, ...preview } = block;
				return preview;
			}
			if (block.type === "thinking") {
				const { thinkingSignature, ...preview } = block;
				return preview;
			}
			if (block.type === "toolCall") {
				const { thoughtSignature, ...preview } = block;
				return preview;
			}
			return block;
		});
		return serializedPreview(JSON.stringify(content));
	}
	return serializedPreview(JSON.stringify(message.content.map(imagePreviewBlock)));
}

/**
 * Replace a captured image payload with the size it occupied, so a preview
 * reports what the message carried without retaining or rendering its bytes.
 * Sizes measure the base64 text as captured, not the decoded image.
 */
function imagePreviewBlock<Block extends { readonly type: string }>(block: Block): Block {
	if (block.type !== "image") return block;
	const data = (block as { readonly data?: unknown }).data;
	if (typeof data !== "string") return block;
	return { ...block, data: `<${formatSize(data.length)} omitted>` };
}

/** Preview whose whole text is one serialized JSON document. */
function serializedPreview(text: string): MessagePreview {
	return { text, jsonSpan: { start: 0, end: text.length } };
}

/** Attribute a custom-role message to its customType; the actual injector is unknowable. */
function messageSource(customType: string): InjectionSource {
	return { id: `message-type:${customType}`, label: customType, native: false };
}

/** Normalize the string-or-array promptGuidelines field to an owned array. */
function normalizeGuidelines(guidelines: string | string[] | undefined): string[] {
	if (guidelines === undefined) return [];
	return Array.isArray(guidelines) ? [...guidelines] : [guidelines];
}
