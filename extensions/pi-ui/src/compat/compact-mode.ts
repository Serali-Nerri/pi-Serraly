// Adapted from pi-cc-extensions v0.8.69; see THIRD_PARTY_NOTICES.md.
/**
 * Compact mode：工作组尾端呈现中性、单行语义汇总；
 * edit/write/apply_patch 和 dedicated 工具保留独立渲染。
 * 展开过程视图后，工具和 Thinking 按消息顺序呈现，子项支持独立展开。
 *
 * 汇总包含所有捕获的调用，按记录的对象字符串去重；展示所有权与统计独立。
 * 时长 = 回合流逝挂钟；进行中 Running...，结束 Ran for。
 * abort/error/length 状态行挂在摘要外层，避免被折叠吞掉。
 *
 * 补丁生命周期遵循仓库既有模式：Symbol 所有权、dispose 仅恢复仍由本安装持有的
 * 方法、重入守卫防止 /reload 后残留闭包递归。
 */
import {
	AssistantMessageComponent,
	UserMessageComponent,
	ToolExecutionComponent,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, MouseRegion, Spacer, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { config } from "../config/config.ts";
import { getUiScheduler } from "../scheduler.ts";
import { resolveRendererPolicy } from "./policy.ts";
import { captureMethod, installMethodStep, nativeMethod } from "./method-pipeline.ts";
import { requireReplaceableMethod } from "./host-capabilities.ts";
import { WorkSummaryObservations, summarizeOperations, type RecordedOperation, type WorkToolEvent } from "../state/work-summary.ts";
import { refreshTranscriptComponent } from "./transcript-refresh.ts";
import { getMessageDisplayTheme } from "./message-display.ts";
import { getToolMouseTui } from "../overlays/mouse-state.ts";
import { showMoreHintText } from "../transcript/tool/show-more-hint.ts";
import { scheduleAnimation } from "../transcript/tool/result.ts";
import { ThinkingPreviewBlock } from "../transcript/thinking.ts";
import { stripBackgroundAnsi } from "../utils/ansi-text.ts";
import { walkComponentTree } from "./component-tree.ts";
import {
	ASSISTANT_REENTRY_KEY,
	ASSISTANT_SET_EXPANDED_KEY,
	ASSISTANT_TOGGLE_ROUND_KEY,
	COMPACT_MODE_PATCH_KEY,
	COMPACT_THINKING_PATCH_KEY,
	patchRegistry,
	PROTOTYPE_ORIGINAL_KEY,
} from "./patch-keys.ts";

/** compact 渲染层对 compact-thinking 的只读查询面（不建第二套计时器）。 */
export type CompactThinkingQuery = {
	getMessageThinkingDurationMs(messageTimestamp: number): number | undefined;
	isMessageThinkingActive?(messageTimestamp: number): boolean;
	getThinkingAnimationFrame?(): number;
	setCompactSummaryActive?(active: boolean): void;
};

export const COMPACT_ROUND_PARENT = Symbol.for("claude-style-tools.compact-round-parent");
export const COMPACT_LOCAL_EXPANSION = Symbol.for("claude-style-tools.compact-local-expansion");
/** 卡片已放进所属消息的内容槽，独立槽位不再重复渲染。 */
export const COMPACT_EMBEDDED = Symbol.for("claude-style-tools.compact-embedded");

type CompactThinkingTheme = Pick<Theme, "fg" | "italic" | "bold">;

/** 与 compact-thinking 主渲染器共用的静态文字样式。 */
export function styleCompactThinkingText(
	text: string,
	theme: CompactThinkingTheme | undefined,
	bold = false,
): string {
	if (!theme) return text;
	const color = "thinkingText";
	const colored = typeof theme.fg === "function" ? theme.fg(color, text) : text;
	const weighted = bold && typeof theme.bold === "function" ? theme.bold(colored) : colored;
	return typeof theme.italic === "function" ? theme.italic(weighted) : weighted;
}

/** 与 compact-thinking 主渲染器共用的活动思考扫光动画。 */
export function animateCompactThinkingText(
	text: string,
	theme: CompactThinkingTheme | undefined,
	animationFrame: number,
	boldBase = false,
): string {
	if (!theme) return text;
	const characters = Array.from(text);
	if (characters.length === 0) return "";
	const highlightWidth = Math.max(1, Math.min(5, Math.ceil(characters.length * 0.28)));
	const start = (animationFrame % (characters.length + highlightWidth)) - highlightWidth;
	const end = start + highlightWidth;
	const before = characters.slice(0, Math.max(0, start)).join("");
	const highlighted = characters
		.slice(Math.max(0, start), Math.min(characters.length, end))
		.join("");
	const after = characters.slice(Math.max(0, end)).join("");
	const highlightedColored =
		highlighted && typeof theme.fg === "function" ? theme.fg("text", highlighted) : highlighted;
	const highlightedWeighted =
		highlightedColored && typeof theme.bold === "function"
			? theme.bold(highlightedColored)
			: highlightedColored;
	const highlightedText =
		highlightedWeighted && typeof theme.italic === "function"
			? theme.italic(highlightedWeighted)
			: highlightedWeighted;

	return (
		styleCompactThinkingText(before, theme, boldBase) +
		highlightedText +
		styleCompactThinkingText(after, theme, boldBase)
	);
}

function formatThoughtDuration(durationMs: number) {
	if (durationMs < 1_000) {
		return `${Math.max(1, Math.round(durationMs))}ms`;
	}

	const totalSeconds = Math.max(1, Math.round(durationMs / 1_000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes === 0) return `${seconds}s`;
	return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export { formatThoughtDuration };

/** assistant stopReason → 外层状态文案（与 Pi 原生口径对齐）。 */
export function messageStopStatus(message: any): string | undefined {
	const reason = message?.stopReason;
	if (reason === "aborted") {
		return message.errorMessage && message.errorMessage !== "Request was aborted"
			? String(message.errorMessage)
			: "Operation aborted";
	}
	if (reason === "error") {
		return `Error: ${message.errorMessage || "Unknown error"}`;
	}
	if (reason === "length") {
		return "Response was truncated before completion.";
	}
	return undefined;
}

function roundStopStatus(messages: Iterable<any>): string | undefined {
	for (const message of messages) {
		const status = messageStopStatus(message);
		if (status) return status;
	}
	return undefined;
}

/**
 * 逐条 assistant message 的摘要文本（无工具计数时可为空串）：
 * 当前时长取工作组挂钟；无挂钟的历史保留已有 thinking query；read 路径去重。
 */
function buildMessagesSummary(
	messages: Iterable<any>,
	query?: CompactThinkingQuery,
	runningActiveOverride?: boolean,
	workDurationMs?: number,
	aborted = false,
	nested?: { operations: RecordedOperation[]; partial: boolean },
): string {
	const parts: string[] = [];
	const operations: RecordedOperation[] = [];
	const durationTimestamps = new Set<number>();
	let durationMs = 0;
	let runningActive = false;
	let thoughts = 0;

	for (const message of messages) {
		if (typeof message?.timestamp === "number" && !durationTimestamps.has(message.timestamp)) {
			durationTimestamps.add(message.timestamp);
			if (query?.isMessageThinkingActive?.(message.timestamp)) runningActive = true;
			const value = query?.getMessageThinkingDurationMs(message.timestamp);
			if (typeof value === "number" && Number.isFinite(value) && value > 0) durationMs += value;
		}
		const content = Array.isArray(message?.content) ? message.content : [];
		for (const item of content) {
			if (item?.type === "thinking" && typeof item.thinking === "string" && item.thinking.trim()) thoughts++;
			if (item?.type !== "toolCall") continue;
			operations.push({
				id: item.id,
				name: typeof item.name === "string" ? item.name : "tool",
				arguments: item.arguments ?? item.args,
			});
		}
	}

	if (
		typeof workDurationMs === "number" &&
		Number.isFinite(workDurationMs) &&
		workDurationMs >= 0
	) {
		durationMs = workDurationMs;
	}

	runningActive = runningActiveOverride ?? runningActive;
	if (runningActive) {
		parts.push(durationMs > 0 ? `Running... · ${formatThoughtDuration(durationMs)}` : "Running...");
	} else if (aborted) {
		parts.push(durationMs > 0 ? `Cancelled after ${formatThoughtDuration(durationMs)}` : "Cancelled");
	} else if (durationMs > 0) parts.push(`Ran for ${formatThoughtDuration(durationMs)}`);
	if (thoughts) parts.push(`Thought ${thoughts} ${thoughts === 1 ? "time" : "times"}`);
	parts.push(...summarizeOperations([...operations, ...nested?.operations ?? []]));
	if (nested?.partial) parts.push("partial records");
	return parts.join(", ");
}

export function buildMessageSummary(
	message: any,
	query?: CompactThinkingQuery,
	workDurationMs?: number,
	aborted = false,
): string {
	return buildMessagesSummary([message], query, undefined, workDurationMs, aborted);
}

function fallbackTheme(): any {
	return {
		fg: (_color: string, text: string) => text,
		italic: (text: string) => text,
		bold: (text: string) => text,
	};
}

function themeOf(): any {
	return getMessageDisplayTheme() ?? fallbackTheme();
}

/** Background only: native columns, rows and input routing remain unchanged. */
function processBackgroundLines(lines: string[], width: number): string[] {
	const theme = themeOf();
	const slot = config.expandedCardBackground;
	const bg = theme.getBgAnsi?.(slot) ?? "";
	return lines.map((line) => {
		const text = stripBackgroundAnsi(line);
		const row = text + " ".repeat(Math.max(0, width - visibleWidth(text)));
		return bg ? `${bg}${row.replace(/\x1b\[(?:0)?m/g, (reset) => reset + bg)}\x1b[49m` : theme.bg?.(slot, row) ?? row;
	});
}

function isAssistantComponent(value: any): boolean {
	return value instanceof AssistantMessageComponent && !summaryComponents.has(value);
}

function isToolComponent(value: any): boolean {
	return value instanceof ToolExecutionComponent;
}

function detachAssistantExpansion(component: any): void {
	if (
		typeof component?.[ASSISTANT_SET_EXPANDED_KEY] !== "function" ||
		component.setExpanded !== component[ASSISTANT_SET_EXPANDED_KEY]
	) {
		return;
	}
	delete component.setExpanded;
	delete component[ASSISTANT_SET_EXPANDED_KEY];
	delete component[ASSISTANT_TOGGLE_ROUND_KEY];
	delete component[ASSISTANT_REENTRY_KEY];
}

/** 供 mouse-interaction 识别可点击的 compact assistant 行（仅 compact 模式下生效）。 */
export function isCompactAssistantComponent(value: unknown): boolean {
	if (config.mode !== "compact" || !value || typeof value !== "object") return false;
	const component = value as any;
	return (
		typeof component[ASSISTANT_SET_EXPANDED_KEY] === "function" &&
		component.setExpanded === component[ASSISTANT_SET_EXPANDED_KEY]
	);
}

/** Display-only native shell, never a persisted transcript identity. */
export function isCompactSummaryComponent(value: unknown): boolean {
	return typeof value === "object" && value !== null && summaryComponents.has(value);
}

export type CompactModeHooks = {
	/** Public tool observations, including calls nested under a recorded parent. */
	observeToolExecution(event: WorkToolEvent): void;
	/** Saved toolResult.nestedCalls on message_end; also restored by sync. */
	observeMessage(message: any): void;
	/** Reconcile owned summary displays after the host mounts/rebuilds transcript. */
	reconcile(root: unknown): void;
	activityStart(): void;
	activitySettled(aborted?: boolean): void;
	groupBoundary(): void;
	userWait(waiting: boolean): void;
	/** 会话事件后同步：所有权、全局展开状态、已挂载组件。 */
	sync(ctx: any): void;
	/** 只做廉价状态同步（不重绘已跟踪组件），用于 transcript 即将重建的 session_compact。 */
	syncState(ctx: any): void;
	/** 重绘所有被跟踪的 assistant/tool 组件（模式切换用）。 */
	refresh(): void;
	/** compact 模式下重新认领 assistant patch（位于 compact-thinking 之上）。 */
	assertOwnership(): void;
	/** 重新渲染包含指定 toolCallId 的 assistant 消息（思考收尾时刷新）。 */
	refreshToolCallMessage(toolCallId: string | undefined): void;
	shutdown(): void;
};

type CompactModeInstallDeps = {
	query?: CompactThinkingQuery;
};

type CompactModePatch = {
	active: boolean;
	prototype: any;
	assistantInstalled: (...args: any[]) => any;
	assistantOriginal: (...args: any[]) => any;
	assistantNative: (...args: any[]) => any;
	toolInstalledRender: (width: number) => string[];
	toolInstalledUpdateDisplay: () => void;
	toolOriginalRender: (width: number) => string[];
	toolOriginalUpdateDisplay: () => void;
	assertAssistantOwnership: () => void;
	dispose: () => void;
};

/** Owned-slot shape: only a branded compact patch for the same prototypes is reused. */
function isCompactModePatch(value: unknown, prototype: object): value is CompactModePatch {
	if (typeof value !== "object" || value === null) return false;
	const patch = value as CompactModePatch;
	return patch.prototype === prototype && typeof patch.assertAssistantOwnership === "function" && typeof patch.dispose === "function";
}

const trackedAssistantComponents = new Set<any>();
const trackedToolComponents = new Set<any>();
const summaryComponents = new WeakSet<object>();
const knownTranscriptComponents = new WeakSet<object>();
let hoveredAssistantComponent: any;

export function setHoveredCompactAssistant(component: any): boolean {
	if (hoveredAssistantComponent === component) return false;
	hoveredAssistantComponent = component;
	return true;
}

function compactAssistantLineComponent(
	component: any,
	/** 静态串或每次 render 重算（Running 时长需逐步跳动）。 */
	summary: string | (() => string),
	query?: CompactThinkingQuery,
	options: { hint?: boolean; leadingBlank?: boolean; pad?: number } = {},
): any {
	const self = component as any;
	let hintVisible = false;
	return {
		render(width: number): string[] {
			const theme = themeOf();
			const pad = Math.max(0, options.pad ?? (Number(self.outputPad) || 0));
			const available = Math.max(0, width - pad);
			const hintText = options.hint === false ? "" : ` • ${showMoreHintText()}`;
			hintVisible = Boolean(hintText) && available >= visibleWidth(hintText);
			const summaryWidth = Math.max(0, available - visibleWidth(hintText));
			const resolved = typeof summary === "function" ? summary() : summary;
			const runningActive = resolved.startsWith("Running...");
			const plainText = truncateToWidth(resolved, summaryWidth, "…");
			let text = theme.fg("muted", plainText);
			if (runningActive || plainText.startsWith("Ran for ")) {
				const separator = plainText.indexOf(", ");
				const heading = separator < 0 ? plainText : plainText.slice(0, separator);
				const tools = separator < 0 ? "" : plainText.slice(separator);
				if (runningActive) {
					const durationSeparator = heading.indexOf(" · ");
					const label = durationSeparator < 0 ? heading : heading.slice(0, durationSeparator);
					const duration = durationSeparator < 0 ? "" : heading.slice(durationSeparator);
					text = `${animateCompactThinkingText(
						label,
						theme,
						query?.getThinkingAnimationFrame?.() ?? 0,
					)}${styleCompactThinkingText(duration, theme)}${theme.fg("muted", tools)}`;
				} else {
					text = `${styleCompactThinkingText(heading, theme)}${theme.fg("muted", tools)}`;
				}
			}
			const hintColor = hoveredAssistantComponent === component ? "text" : "dim";
			const line = `${text}${hintText ? theme.fg(hintColor, hintText) : ""}`;
			const rendered = `${" ".repeat(pad)}${truncateToWidth(line, available, "")}`;
			return options.leadingBlank === false ? [rendered] : ["", rendered];
		},
		actionAtRow(row: number) {
			return hintVisible && row === (options.leadingBlank === false ? 0 : 1) ? "expand" : undefined;
		},
		invalidate() {},
	};
}

function compactStopStatusLine(status: string, pad = 0): any {
	return {
		render(width: number): string[] {
			const theme = themeOf();
			const prefix = " ".repeat(Math.max(0, pad));
			const line = `${prefix}${theme.fg("error", status)}`;
			return ["", truncateToWidth(line, width, "")];
		},
		invalidate() {},
	};
}

function compactAssistantLine(
	component: any,
	summary: string | (() => string),
	query?: CompactThinkingQuery,
): void {
	// 空静态串跳过；getter 留给 render 判断（Running 可能稍后才有时长）。
	if (typeof summary === "string" && !summary) return;
	component.contentContainer.addChild(compactAssistantLineComponent(component, summary, query));
}

function appendStopStatus(component: any, status: string | undefined): void {
	if (!status || !component?.contentContainer?.addChild) return;
	component.contentContainer.addChild(
		compactStopStatusLine(status, Number(component.outputPad) || 0),
	);
}

function ensureAssistantSetExpanded(component: any): void {
	if (
		typeof component[ASSISTANT_SET_EXPANDED_KEY] === "function" &&
		component.setExpanded === component[ASSISTANT_SET_EXPANDED_KEY]
	) {
		return;
	}
	if (typeof component.setExpanded === "function") {
		detachAssistantExpansion(component);
		if (typeof component.setExpanded === "function") return;
	}
	const installed = function (this: any, expanded: boolean) {
		if (config.mode !== "compact") {
			detachAssistantExpansion(this);
			return;
		}
		const toggleRound = this[ASSISTANT_TOGGLE_ROUND_KEY];
		if (typeof toggleRound === "function") {
			toggleRound(expanded);
			return;
		}
		this.expanded = expanded;
		if (typeof this.updateContent === "function" && this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	};
	component[ASSISTANT_SET_EXPANDED_KEY] = installed;
	component.setExpanded = installed;
}

function collectMountedComponents(root: any): void {
	if (!root || typeof root !== "object") return;
	const assistants = new Set<any>();
	const tools = new Set<any>();
	walkComponentTree(root, (value: any) => {
		if (isAssistantComponent(value)) {
			assistants.add(value);
			// 仅在 compact 模式给实例装 setExpanded，避免 on/off 下 Ctrl+O/mouse 回归。
			if (config.mode === "compact") ensureAssistantSetExpanded(value);
		} else if (isToolComponent(value)) {
			tools.add(value);
		}
	});
	// 扫到组件才替换跟踪表。面板/custom UI 打开时 root 往往扫不到 transcript，
	// 若此时清空会丢掉 live updateContent/updateDisplay 已登记的实例，
	// /ccstyle 切换就只能靠 /reload 重建。
	if (assistants.size > 0 || tools.size > 0) {
		trackedAssistantComponents.clear();
		trackedToolComponents.clear();
		for (const component of assistants) trackedAssistantComponents.add(component);
		for (const component of tools) trackedToolComponents.add(component);
	} else if (config.mode === "compact") {
		for (const component of trackedAssistantComponents) ensureAssistantSetExpanded(component);
	}
}

export function installCompactMode(deps: CompactModeInstallDeps): CompactModeHooks {
	const assistantPrototype = AssistantMessageComponent.prototype as any;
	const toolPrototype = ToolExecutionComponent.prototype as any;
	const previous = patchRegistry.getOwned(COMPACT_MODE_PATCH_KEY, (value): value is CompactModePatch => isCompactModePatch(value, assistantPrototype));
	if (previous) previous.dispose();
	for (const [owner, proto, name] of [
		["AssistantMessageComponent", assistantPrototype, "updateContent"],
		["ToolExecutionComponent", toolPrototype, "render"],
		["ToolExecutionComponent", toolPrototype, "updateDisplay"],
		["Container", Container.prototype, "addChild"],
	] as const) requireReplaceableMethod(owner, proto, name);
	const steps: Array<ReturnType<typeof installMethodStep>> = [];
	const patch: CompactModePatch = {
		active: true,
		prototype: assistantPrototype,
		assistantInstalled: undefined as any,
		assistantOriginal: captureMethod(assistantPrototype, "updateContent"),
		assistantNative: nativeMethod(assistantPrototype, "updateContent"),
		toolInstalledRender: undefined as any,
		toolInstalledUpdateDisplay: undefined as any,
		toolOriginalRender: captureMethod(toolPrototype, "render"),
		toolOriginalUpdateDisplay: captureMethod(toolPrototype, "updateDisplay"),
		assertAssistantOwnership: () => {},
		dispose: () => {},
	};

	const passThroughAssistant = (component: any, message: any, isStreaming?: boolean): any => {
		const self = component as any;
		if (self[ASSISTANT_REENTRY_KEY] === patch)
			return patch.assistantNative.call(component, message, isStreaming);
		self[ASSISTANT_REENTRY_KEY] = patch;
		try {
			return patch.assistantOriginal.call(component, message, isStreaming);
		} finally {
			delete self[ASSISTANT_REENTRY_KEY];
		}
	};

	type WorkClock = {
		startedAt: number;
		activityGeneration: number;
		endedAt?: number;
		waitingSince?: number;
		pausedMs?: number;
	};
	type CompactRound = {
		anchor: any;
		messages: Map<any, any>;
		proseMessages: Map<any, any>;
		active: boolean;
		clock?: WorkClock;
		/** 收尾时记录中止结局，保证重绘结论稳定。 */
		settledAborted?: boolean;
		summaryComponent?: any;
		summaryParent?: { children: any[] };
	};
	const observations = new WorkSummaryObservations();
	let activeRound: CompactRound | undefined;
	let activityActive = false;
	let activityGeneration = 0;
	let activityStartedAt = 0;
	let waitingDepth = 0;
	let activityClock: WorkClock | undefined;
	const unfinishedClocks = new Set<WorkClock>();
	let componentClocks = new WeakMap<object, WorkClock>();
	let messageClocks = new WeakMap<object, WorkClock>();
	let roundByComponent = new WeakMap<object, CompactRound>();
	const rounds = new Set<CompactRound>();
	let uiRef: { requestRender?: (force?: boolean) => void } | undefined;
	let cancelRoundTick: (() => void) | undefined;

	const rememberClock = (component: object, message: object, clock: WorkClock): void => {
		componentClocks.set(component, clock);
		messageClocks.set(message, clock);
	};
	const createClock = (startedAt: number): WorkClock => {
		const clock: WorkClock = { startedAt, activityGeneration };
		if (waitingDepth > 0) clock.waitingSince = Date.now();
		unfinishedClocks.add(clock);
		return clock;
	};
	const clockFor = (component: object, message: any): WorkClock | undefined => {
		const timestamp = message.timestamp;
		const previous = componentClocks.get(component) ?? messageClocks.get(message);
		if (previous) { rememberClock(component, message, previous); return previous; }
		const thinkingActive = deps.query?.isMessageThinkingActive?.(timestamp) === true;
		if (!activityActive && !thinkingActive) return undefined;
		if (activityActive && timestamp < activityStartedAt) return undefined;
		if (!activityClock || activityClock.endedAt !== undefined) activityClock = createClock(Date.now());
		const clock = activityClock;
		rememberClock(component, message, clock);
		return clock;
	};
	const roundToJoin = (component: object, message: object): CompactRound | undefined => {
		const retained = componentClocks.get(component) ?? messageClocks.get(message);
		if (retained) return [...rounds].find((round) => round.clock === retained);
		if (activeRound) {
			let mounted = false;
			walkComponentTree(getToolMouseTui(), (value) => { if (value === activeRound?.anchor) mounted = true; });
			if (!mounted) return undefined;
		}
		return !activityActive || activeRound?.active ? activeRound : undefined;
	};

	const roundWallMs = (round: CompactRound): number | undefined => {
		const clock = round.clock;
		if (!clock) return undefined;
		const end = round.active ? (clock.waitingSince ?? Date.now()) : (clock.endedAt ?? Date.now());
		return Math.max(1, end - clock.startedAt - (clock.pausedMs ?? 0));
	};

	const resumeClock = (clock: WorkClock): void => {
		if (clock.waitingSince === undefined) return;
		clock.pausedMs = (clock.pausedMs ?? 0) + Math.max(0, Date.now() - clock.waitingSince);
		delete clock.waitingSince;
	};
	const finishClock = (clock: WorkClock): void => {
		if (clock.endedAt === undefined) {
			resumeClock(clock);
			clock.endedAt = Date.now();
		}
		unfinishedClocks.delete(clock);
	};

	const summarize = (messages: Iterable<any>, runningActive?: boolean, round?: CompactRound) =>
		buildMessagesSummary(
			messages,
			deps.query,
			runningActive,
			round ? roundWallMs(round) : undefined,
			round?.settledAborted === true,
			round ? observations.forCalls(roundToolCallIds(round)) : undefined,
		);

	const stopRoundTick = (): void => {
		cancelRoundTick?.();
		cancelRoundTick = undefined;
	};

	// 自备 tick：getter 在 render 重算挂钟；兼驱动 Running 扫光（setCompactSummaryActive）。
	const ensureRoundTick = (): void => {
		const scheduler = getUiScheduler();
		if (cancelRoundTick || !scheduler) return;
		cancelRoundTick = scheduler.schedule("compact-round", 250, () => {
			if (!patch.active || !activeRound?.active) {
				stopRoundTick();
				return;
			}
			try {
				// 非 force：保留 fullscreen 布局缓存和差分绘制。
				scheduler.request();
			} catch {
				/* 无 UI */
			}
		}, true);
	};

	/** 结束回合活动态；可选立即重绘。 */
	const endRound = (round: CompactRound, render = false): void => {
		round.active = false;
		if (round.clock) finishClock(round.clock);
		if (activeRound === round) {
			activeRound = undefined;
			deps.query?.setCompactSummaryActive?.(false);
			stopRoundTick();
		}
		if (render) renderRound(round);
	};

	const renderAssistantWithoutThinking = (
		component: any,
		message: any,
		isStreaming?: boolean,
	): any => {
		const content = Array.isArray(message?.content) ? message.content : [];
		const result = passThroughAssistant(
			component,
			{
				...message,
				content: content.filter((item: any) => item?.type !== "thinking"),
			},
			isStreaming,
		);
		component.lastMessage = message;
		return result;
	};

	const roundMessages = (round: CompactRound): any[] => [...round.messages.values()];

	const roundToolCallIds = (round: CompactRound): Set<string> => {
		const ids = new Set<string>();
		for (const message of roundMessages(round)) {
			for (const item of Array.isArray(message?.content) ? message.content : []) {
				if (item?.type === "toolCall" && typeof item.id === "string") ids.add(item.id);
			}
		}
		return ids;
	};

	const unmountSummary = (round: CompactRound): void => {
		const children = round.summaryParent?.children;
		const index = children?.indexOf(round.summaryComponent) ?? -1;
		if (index >= 0) children!.splice(index, 1);
		round.summaryParent = undefined;
	};

	const summaryComponent = (round: CompactRound): any => {
		if (round.summaryComponent) return round.summaryComponent;
		// A display-only native shell shares keyboard/mouse behavior, but has no
		// message identity, persistence or updateContent lifecycle of its own.
		const view = new AssistantMessageComponent(undefined as any, true) as any;
		summaryComponents.add(view);
		view.hasToolCalls = true;
		view.outputPad = round.anchor.outputPad;
		// The proxy only opens the group; it never becomes another expanded card
		// that the native single-card mouse policy could collapse behind a child.
		view.expanded = false;
		const setExpanded = (expanded: boolean) => round.anchor.setExpanded?.(expanded);
		view.setExpanded = setExpanded;
		view[ASSISTANT_SET_EXPANDED_KEY] = setExpanded;
		const line = compactAssistantLineComponent(view,
			() => summarize(roundMessages(round), round.active, round), deps.query);
		view.actionAtRow = (row: number) => round.anchor.expanded === true ? undefined : line.actionAtRow(row);
		view.contentContainer.addChild({
			render(width: number) {
				if (!patch.active || config.mode !== "compact" || round.anchor.expanded === true) return [];
				const lines = line.render(width);
				const status = roundStopStatus(roundMessages(round));
				if (status) lines.push(...compactStopStatusLine(status, Number(view.outputPad) || 0).render(width));
				return lines;
			},
			invalidate() {},
		});
		round.summaryComponent = view;
		return view;
	};

	const reconcile = (root: unknown): void => {
		if (!patch.active || config.mode !== "compact") return;
		for (const round of rounds) {
			let parent: { children: any[] } | undefined;
			walkComponentTree(root, (value) => {
				if (Array.isArray(value.children) && value.children.includes(round.anchor)) parent = value;
			});
			if (!parent) { unmountSummary(round); continue; }
			const view = summaryComponent(round);
			if (round.summaryParent !== parent) {
				unmountSummary(round);
				const ids = roundToolCallIds(round);
				let last = parent.children.indexOf(round.anchor);
				for (let i = last + 1; i < parent.children.length; i++) {
					const child = parent.children[i];
					if (round.messages.has(child) || ids.has(child.toolCallId)) last = i;
				}
				parent.children.splice(round.active ? parent.children.length : last + 1, 0, view);
				round.summaryParent = parent;
				renderRound(round);
			} else if (round.active && parent.children.at(-1) !== view) {
				unmountSummary(round);
				parent.children.push(view);
				round.summaryParent = parent;
			}
		}
	};

	// The round owns its stop status outside the card. Suppress only the inner
	// display copy, retaining the original message for subsequent renders.
	const withoutStopStatus = (message: any): any =>
		messageStopStatus(message) ? { ...message, stopReason: "toolUse" } : message;

	/** Thinking keeps the process background exactly as when it renders standalone. */
	const backgroundize = (child: any, anchor: any): any => {
		if (!(child instanceof ThinkingPreviewBlock) && !(child.child && typeof child.onMouse === "function")) return child;
		if (child instanceof ThinkingPreviewBlock) (child as any)[COMPACT_ROUND_PARENT] = anchor;
		const view = new MouseRegion(child, () => undefined);
		view.render = (width) => processBackgroundLines(child.render(width), width);
		return view;
	};

	/** A placed card renders through its own native renderer; the group only hosts it. */
	const placeToolView = (tool: any): any => ({
		render(width: number) {
			const lines = patch.toolOriginalRender.call(tool, width);
			return resolveRendererPolicy(tool).compactable ? processBackgroundLines(lines, width) : lines;
		},
		handleMouse(event: any) {
			return typeof tool.handleMouse === "function" ? tool.handleMouse(event) : undefined;
		},
		invalidate() {},
	});

	/**
	 * Place a message's own cards at their recorded content indices. Native text
	 * and Thinking order stays untouched; only the card slots between them move.
	 */
	const placeMessageContent = (
		component: any,
		message: any,
		anchor: any,
		toolsById: Map<string, any>,
	): void => {
		const container = component?.contentContainer;
		if (!container || !Array.isArray(container.children)) return;
		const natives = [...container.children];
		const placed = new Set<string>();
		const output: any[] = [];
		const cursor = { i: 0 };
		const takeNative = (): void => {
			while (cursor.i < natives.length && natives[cursor.i] instanceof Spacer) output.push(natives[cursor.i++]);
			if (cursor.i < natives.length) output.push(backgroundize(natives[cursor.i++], anchor));
		};
		let inThinkingRun = false;
		for (const item of Array.isArray(message?.content) ? message.content : []) {
			if (item?.type === "thinking") {
				if (!String(item.thinking ?? "").trim()) continue;
				if (!inThinkingRun) { takeNative(); inThinkingRun = true; }
				continue;
			}
			inThinkingRun = false;
			if (item?.type === "text" && String(item.text ?? "").trim()) { takeNative(); continue; }
			if (item?.type !== "toolCall" || typeof item.id !== "string" || placed.has(item.id)) continue;
			const tool = toolsById.get(item.id);
			// Only managed cards join the group; dedicated/excluded renderers stay native.
			if (!tool || !resolveRendererPolicy(tool).managed) continue;
			placed.add(item.id);
			tool[COMPACT_EMBEDDED] = true;
			output.push(placeToolView(tool));
		}
		while (cursor.i < natives.length) output.push(backgroundize(natives[cursor.i++], anchor));
		container.children = output;
	};

	const renderRound = (round: CompactRound): void => {
		const messages = roundMessages(round);
		const stopStatus = roundStopStatus(messages);
		if (stopStatus && (!activityActive || !round.active)) endRound(round);
		// Running 时每次 render 重算时长（含挂钟下限）；结束后固定。
		const getSummary = () => summarize(roundMessages(round), round.active, round);
		const summary = getSummary();
		for (const [component, message] of round.messages) {
			component.lastMessage = round.proseMessages.get(component) ?? message;
			ensureAssistantSetExpanded(component);
			// Members share a logical expansion owner, not a physical panel.
			component.expanded = round.anchor.expanded === true;
			component[COMPACT_ROUND_PARENT] = round.anchor;
			component[ASSISTANT_TOGGLE_ROUND_KEY] = (expanded: boolean) => {
				round.anchor.expanded = expanded;
				renderRound(round);
			};
		}
		const ids = roundToolCallIds(round);
		for (const tool of trackedToolComponents) {
			if (!ids.has(tool.toolCallId)) continue;
			delete tool[COMPACT_EMBEDDED];
			tool[COMPACT_ROUND_PARENT] = round.anchor;
		}

		if (round.anchor.expanded === true) {
			const toolsById = new Map<string, any>();
			for (const tool of trackedToolComponents) {
				if (typeof tool?.toolCallId === "string") toolsById.set(tool.toolCallId, tool);
			}
			for (const [component, message] of round.messages) {
				const original = round.proseMessages.get(component) ?? message;
				passThroughAssistant(component, withoutStopStatus(original));
				component.lastMessage = original;
				placeMessageContent(component, original, round.anchor, toolsById);
			}
			for (const tool of trackedToolComponents) {
				if (!ids.has(tool.toolCallId) || !resolveRendererPolicy(tool).compactable) continue;
				// Opening the group does not recursively open long tool output.
				if (tool.expanded !== true || tool[COMPACT_LOCAL_EXPANSION] === true) continue;
				if (typeof tool.setExpanded === "function") tool.setExpanded(false);
				else {
					tool.expanded = false;
					tool.updateDisplay?.();
				}
			}
			const last = [...round.messages.keys()].at(-1);
			appendStopStatus(last, stopStatus);
			return;
		}

		for (const [component, message] of round.messages) {
			const original = round.proseMessages.get(component) ?? message;
			renderAssistantWithoutThinking(component, withoutStopStatus(original));
			component.lastMessage = original;
			if (component !== round.anchor) continue;
			// 空摘要不挂行（getter 在 Running 启动瞬间也可能短暂为空）
			if (!round.summaryParent && (summary || round.active)) compactAssistantLine(component, getSummary, deps.query);
			// 折叠时工具行被隐藏：abort/error/length 必须挂在摘要外层。
			if (!round.summaryParent) appendStopStatus(component, stopStatus);
		}
	};

	const activateRound = (round: CompactRound): void => {
		rounds.add(round);
		round.active = Boolean(round.clock && round.clock.endedAt === undefined &&
			round.clock.activityGeneration === activityGeneration && (activityActive || activityGeneration === 0));
		if (round.active && waitingDepth > 0 && round.clock) round.clock.waitingSince ??= Date.now();
		if (round.active || !activeRound?.active) activeRound = round;
		deps.query?.setCompactSummaryActive?.(activeRound?.active === true);
		if (round.active) ensureRoundTick();
	};

	const finishRound = (round: CompactRound): void => endRound(round, true);

	const resetRounds = (): void => {
		for (const round of rounds) unmountSummary(round);
		rounds.clear();
		for (const tool of trackedToolComponents) {
			delete tool[COMPACT_ROUND_PARENT];
			delete tool[COMPACT_LOCAL_EXPANSION];
			delete tool[COMPACT_EMBEDDED];
		}
		for (const component of trackedAssistantComponents) delete component[COMPACT_ROUND_PARENT];
		activeRound = undefined;
		deps.query?.setCompactSummaryActive?.(false);
		stopRoundTick();
	};

	patch.assistantInstalled = function (this: any, message: any, isStreaming?: boolean) {
		if (!patch.active) return passThroughAssistant(this, message, isStreaming);
		// Only a mounted-tree reconciliation can reclaim a previously owned
		// instance. A late callback is not permission to join another installation.
		if (knownTranscriptComponents.has(this) && !trackedAssistantComponents.has(this)) {
			return patch.assistantNative.call(this, message, isStreaming);
		}
		knownTranscriptComponents.add(this);
		const self = this as any;
		// 同 compact-thinking：isStreaming 丢失 → mermaid 流式误渲染来回闪。
		if (isStreaming !== undefined) self.isStreaming = isStreaming;
		if (self[ASSISTANT_REENTRY_KEY] === patch) {
			return patch.assistantNative.call(this, message, isStreaming);
		}
		self.lastMessage = message;
		trackedAssistantComponents.add(this);
		if (config.mode !== "compact") {
			if (activityActive && Array.isArray(message?.content) &&
				message.content.some((item: any) => item?.type === "thinking" || item?.type === "toolCall")) {
				clockFor(this, message);
			}
			return passThroughAssistant(this, message, isStreaming);
		}
		if (!self.contentContainer || typeof self.contentContainer.clear !== "function") {
			return passThroughAssistant(this, message, isStreaming);
		}

		const content = Array.isArray(message?.content) ? message.content : [];
		const hasToolCalls = content.some((item: any) => item?.type === "toolCall");
		const hasThinking = content.some((item: any) => item?.type === "thinking");
		const hasText = content.some(
			(item: any) => item?.type === "text" && typeof item.text === "string" && item.text.trim(),
		);
		self.hasToolCalls = hasToolCalls;

		if (hasToolCalls || hasThinking) {
			const retained = componentClocks.get(this) ?? messageClocks.get(message);
			let round = roundByComponent.get(this) ?? (retained ? roundToJoin(this, message) : undefined);
			if (hasToolCalls && hasText && !round) {
				if (activeRound && !retained) finishRound(activeRound);
				round = {
					anchor: this,
					messages: new Map(),
					proseMessages: new Map(),
					active: true,
					clock: clockFor(this, message),
				};
				roundByComponent.set(this, round);
				activateRound(round);
			} else if (!round) {
				round = roundToJoin(this, message) ?? {
					anchor: this,
					messages: new Map(),
					proseMessages: new Map(),
					active: true,
					clock: clockFor(this, message),
				};
				roundByComponent.set(this, round);
			}
			roundByComponent.set(this, round);
			if (!rounds.has(round)) activateRound(round);
			if (hasText && !hasToolCalls) {
				round.proseMessages.set(this, message);
				round.messages.set(this, { ...message, content: content.filter((item: any) => item?.type !== "text") });
			} else {
				round.proseMessages.delete(this);
				round.messages.set(this, message);
			}
			if (round.clock) rememberClock(this, message, round.clock);
			renderRound(round);
			return undefined;
		}

		if (hasText) {
			const round = roundByComponent.get(this);
			if (round) {
				round.proseMessages.set(this, message);
				round.messages.set(this, { ...message, content: content.filter((item: any) => item?.type !== "text") });
				if (!rounds.has(round)) activateRound(round);
				renderRound(round);
				return undefined;
			}
			if (activeRound && (!activityActive || !activeRound.active)) finishRound(activeRound);
			return renderAssistantWithoutThinking(this, message);
		}

		// A per-response status remains visible, but does not settle an activity
		// that can still automatically retry or continue.
		const loneStatus = messageStopStatus(message);
		if (loneStatus) {
			if (activeRound && !activityActive) finishRound(activeRound);
			self.contentContainer.clear();
			appendStopStatus(this, loneStatus);
			return undefined;
		}

		self.contentContainer.clear();
		return undefined;
	};

	patch.toolInstalledRender = function (this: any, width: number) {
		if (!patch.active || config.mode !== "compact") {
			return patch.toolOriginalRender.call(this, width);
		}
		if (!resolveRendererPolicy(this).managed) return patch.toolOriginalRender.call(this, width);
		// The group paints this card in its recorded message slot.
		if (this[COMPACT_EMBEDDED] === true) return [];
		if (!resolveRendererPolicy(this).compactable) return patch.toolOriginalRender.call(this, width);
		// The shared policy governs grouped process rendering, not semantic counting.
		if (this[COMPACT_ROUND_PARENT]?.expanded === true) {
			return processBackgroundLines(patch.toolOriginalRender.call(this, width), width);
		}
		// 普通工具折叠时不显示独立行（摘要行已统计），独立展开走原 renderer。
		if (this.expanded === true && !this[COMPACT_ROUND_PARENT]) {
			return patch.toolOriginalRender.call(this, width);
		}
		return [];
	};

	patch.toolInstalledUpdateDisplay = function (this: any) {
		if (knownTranscriptComponents.has(this) && !trackedToolComponents.has(this)) {
			return nativeMethod(toolPrototype, "updateDisplay").call(this);
		}
		if (
			patch.active &&
			config.mode === "compact" &&
			resolveRendererPolicy(this).compactable &&
			this[COMPACT_ROUND_PARENT]?.expanded === true && this[COMPACT_LOCAL_EXPANSION] !== true
		) {
			this.expanded = false;
		}
		const result = patch.toolOriginalUpdateDisplay.call(this);
		if (!patch.active) return result;
		knownTranscriptComponents.add(this);
		trackedToolComponents.add(this);
		if (config.mode === "compact") {
			for (const round of rounds) {
				if (!roundToolCallIds(round).has(this.toolCallId)) continue;
				this[COMPACT_ROUND_PARENT] = round.anchor;
				// A card mounted after expansion still needs its recorded slot.
				if (round.anchor.expanded === true && this[COMPACT_EMBEDDED] !== true) renderRound(round);
				break;
			}
		}
		return result;
	};

	// The shared method pipeline installs Thinking first, compact second.
	// Foreign wrappers retain ownership; no prototype re-claiming is necessary.
	patch.assertAssistantOwnership = () => {};

	(patch.assistantInstalled as any)[PROTOTYPE_ORIGINAL_KEY] = patch.assistantNative;

	patch.dispose = () => {
		if (!patch.active) return;
		patch.active = false;
		activityActive = false;
		for (const step of steps.reverse()) step.dispose();
		patchRegistry.dispose(COMPACT_MODE_PATCH_KEY, patch);
		for (const component of trackedAssistantComponents) detachAssistantExpansion(component);
		resetRounds();
		trackedAssistantComponents.clear();
		trackedToolComponents.clear();
		hoveredAssistantComponent = undefined;
		roundByComponent = new WeakMap();
		for (const clock of unfinishedClocks) finishClock(clock);
		activityClock = undefined;
		componentClocks = new WeakMap();
		messageClocks = new WeakMap();
	};

	function groupBoundary(): void {
		if (activeRound) endRound(activeRound, true);
		for (const clock of unfinishedClocks) finishClock(clock);
		activityClock = activityActive ? createClock(Date.now()) : undefined;
		activeRound = undefined;
	}

	try {
		steps.push(installMethodStep(assistantPrototype, "updateContent", () => patch.assistantInstalled));
		steps.push(installMethodStep(toolPrototype, "render", () => patch.toolInstalledRender));
		steps.push(installMethodStep(toolPrototype, "updateDisplay", () => patch.toolInstalledUpdateDisplay));
		// Reconcile on real transcript mounting, before the first host paint.
		// Waiting for the editor widget would leave one stale historical frame.
		steps.push(installMethodStep(Container.prototype as any, "addChild", (downstream) => function (this: any, child: any) {
			const result = downstream.call(this, child);
			if (patch.active && config.mode === "compact" && child instanceof UserMessageComponent) {
				groupBoundary();
			}
			if (patch.active && config.mode === "compact" && (isAssistantComponent(child) || isToolComponent(child) ||
				this.children.some((value: object) => summaryComponents.has(value)))) {
				reconcile(getToolMouseTui() ?? this);
			}
			return result;
		}));
		patchRegistry.installOwned(COMPACT_MODE_PATCH_KEY, patch);
	} catch (error) {
		patch.dispose();
		throw error;
	}

	const syncGlobalExpanded = (ctx: any): void => {
		let globalExpanded = false;
		try {
			globalExpanded = ctx?.ui?.getToolsExpanded?.() === true;
		} catch {
			// 测试或无 UI 上下文时保持折叠。
		}
		for (const component of trackedAssistantComponents) component.expanded = globalExpanded;
		for (const component of trackedToolComponents) component.expanded = globalExpanded;
	};

	const applyStateSync = (ctx: any): boolean => {
		if (!patch.active) return false;
		uiRef = ctx?.ui;
		const messages = ctx?.sessionManager?.buildSessionProjection?.().messages;
		observations.restoreMessages(messages ?? []);
		resetRounds();
		// 始终保持补丁在链上：mode=on/off 走 passThrough，仍写入 lastMessage
		// 与 tracked 集合，这样 /ccstyle 切回 compact 时不必 /reload。
		patch.assertAssistantOwnership();
		if (config.mode === "compact") syncGlobalExpanded(ctx);
		else hoveredAssistantComponent = undefined;
		return true;
	};

	const refreshObservedCall = (id: string): void => {
		for (const round of rounds) {
			const roots = roundToolCallIds(round);
			if (roots.has(id) || observations.forCalls(roots).operations.some((operation) => operation.id === id)) {
				renderRound(round);
			}
		}
	};

	return {
		observeToolExecution(event) {
			if (!patch.active) return;
			observations.observeExecution(event);
			refreshObservedCall(event.toolCallId);
		},
		observeMessage(message) {
			if (!patch.active) return;
			observations.observeMessage(message);
			if (typeof message?.toolCallId === "string") refreshObservedCall(message.toolCallId);
		},
		reconcile,
		activityStart() {
			if (!patch.active || activityActive) return;
			if (activeRound) finishRound(activeRound);
			activityActive = true;
			activityGeneration++;
			activityStartedAt = Date.now();
			waitingDepth = 0;
			activityClock = createClock(activityStartedAt);
		},
		activitySettled(aborted = false) {
			if (!patch.active) return;
			activityActive = false;
			if (activeRound) {
				if (aborted) activeRound.settledAborted = true;
				finishRound(activeRound);
			}
			for (const clock of unfinishedClocks) finishClock(clock);
			waitingDepth = 0;
		},
		groupBoundary,
		userWait(waiting) {
			if (!patch.active || !activityActive) return;
			waitingDepth = Math.max(0, waitingDepth + (waiting ? 1 : -1));
			for (const clock of unfinishedClocks) {
				if (waitingDepth > 0) clock.waitingSince ??= Date.now();
				else resumeClock(clock);
			}
		},
		sync(ctx: any) {
			if (!applyStateSync(ctx)) return;
			refreshTrackedComponents();
		},
		syncState(ctx: any) {
			applyStateSync(ctx);
		},
		refresh() {
			if (!patch.active) return;
			resetRounds();
			patch.assertAssistantOwnership();
			if (config.mode !== "compact") hoveredAssistantComponent = undefined;
			refreshTrackedComponents();
		},
		assertOwnership() {
			if (!patch.active) return;
			patch.assertAssistantOwnership();
		},
		refreshToolCallMessage(toolCallId: string | undefined) {
			if (!patch.active || typeof toolCallId !== "string" || !toolCallId) return;
			for (const component of [...trackedAssistantComponents]) {
				const message = component.lastMessage;
				const contains =
					Array.isArray(message?.content) &&
					message.content.some((item: any) => item?.type === "toolCall" && item.id === toolCallId);
				if (!contains) continue;
				try {
					component.updateContent?.(message);
				} catch {
					trackedAssistantComponents.delete(component);
				}
			}
		},
		shutdown() {
			patch.dispose();
		},
	};
}

function refreshTrackedComponents(): void {
	for (const component of [...trackedAssistantComponents]) {
		try {
			if (config.mode !== "compact") detachAssistantExpansion(component);
			refreshTranscriptComponent(component);
		} catch {
			trackedAssistantComponents.delete(component);
		}
	}
	for (const component of [...trackedToolComponents]) {
		try {
			// 共享实现负责 updateDisplay；invalidate 属于 compact-mode 的跟踪语义。
			refreshTranscriptComponent(component);
			component.invalidate?.();
		} catch {
			trackedToolComponents.delete(component);
		}
	}
}

/** 供 renderer/index.ts 在 session 事件后收集 /reload 重建的组件。 */
export function refreshCompactModeComponents(root: any): void {
	collectMountedComponents(root);
}
