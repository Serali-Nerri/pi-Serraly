// Adapted from pi-cc-extensions v0.8.69; see THIRD_PARTY_NOTICES.md.
/**
 * Compact mode：每条含 toolCall 的 assistant message 折叠为一条逐步累加的摘要行
 * （`Ran for 8s, bash×2, read×2`），edit/write/apply_patch 保留独立的本地文件渲染。
 * 展开过程视图后，工具和 Thinking 按消息顺序呈现，子项支持独立展开。
 *
 * 工具计数：read 按非空路径去重、其余按调用计数（首次出现顺序）；edit/write/apply_patch 不进摘要。
 * 时长 = 回合流逝挂钟；进行中 Running...，结束 Ran for。
 * abort/error/length 状态行挂在摘要外层，避免被折叠吞掉。
 *
 * 补丁生命周期遵循仓库既有模式：Symbol 所有权、dispose 仅恢复仍由本安装持有的
 * 方法、重入守卫防止 /reload 后残留闭包递归。
 */
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, MouseRegion, truncateToWidth, visibleWidth, Spacer, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { config } from "../config/config.ts";
import { getUiScheduler } from "../scheduler.ts";
import { resolveRendererPolicy } from "./policy.ts";
import { captureMethod, installMethodStep, nativeMethod } from "./method-pipeline.ts";
import { requireReplaceableMethod } from "./host-capabilities.ts";
import { sanitizeToolResultText } from "../utils/tool-result-sanitize.ts";
import { refreshTranscriptComponent } from "./transcript-refresh.ts";
import { getMessageDisplayTheme } from "./message-display.ts";
import { getToolMouseTui } from "../overlays/mouse-state.ts";
import { showMoreHintText } from "../transcript/tool/show-more-hint.ts";
import { scheduleAnimation } from "../transcript/tool/result.ts";
import { paddedBackgroundRow } from "./grouping.ts";
import { hasVisibleText, stripBackgroundAnsi } from "../utils/ansi-text.ts";
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
): string {
	const parts: string[] = [];
	const counts = new Map<string, number>();
	const readPaths = new Set<string>();
	const durationTimestamps = new Set<number>();
	let durationMs = 0;
	let runningActive = false;

	for (const message of messages) {
		if (typeof message?.timestamp === "number" && !durationTimestamps.has(message.timestamp)) {
			durationTimestamps.add(message.timestamp);
			if (query?.isMessageThinkingActive?.(message.timestamp)) runningActive = true;
			const value = query?.getMessageThinkingDurationMs(message.timestamp);
			if (typeof value === "number" && Number.isFinite(value) && value > 0) durationMs += value;
		}
		const content = Array.isArray(message?.content) ? message.content : [];
		for (const item of content) {
			if (item?.type !== "toolCall") continue;
			const rawName = typeof item.name === "string" ? item.name : "tool";
			if (!resolveRendererPolicy(rawName).compactable) continue;
			const name = sanitizeToolResultText(rawName);
			if (rawName.split(".").pop() === "read") {
				const args = item.arguments ?? item.args ?? {};
				const path = args.path ?? args.file_path ?? args.file;
				if (typeof path === "string" && path.length > 0) {
					if (readPaths.has(path)) continue;
					readPaths.add(path);
				}
			}
			counts.set(name, (counts.get(name) ?? 0) + 1);
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
	for (const [name, count] of counts) parts.push(`${name}×${count}`);
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

/** RGB → HSL（h∈[0,1), l/s∈[0,1]）。 */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
	r /= 255;
	g /= 255;
	b /= 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	if (max === min) return [0, 0, l];
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h: number;
	switch (max) {
		case r:
			h = (g - b) / d + (g < b ? 6 : 0);
			break;
		case g:
			h = (b - r) / d + 2;
			break;
		default:
			h = (r - g) / d + 4;
	}
	return [h / 6, l, s];
}

/** HSL → RGB（h∈[0,1)，l/s∈[0,1]）。 */
function hslToRgb(h: number, l: number, s: number): [number, number, number] {
	if (s === 0) {
		const v = Math.round(l * 255);
		return [v, v, v];
	}
	const hue2rgb = (p: number, q: number, t: number): number => {
		if (t < 0) t += 1;
		if (t > 1) t -= 1;
		if (t < 1 / 6) return p + (q - p) * 6 * t;
		if (t < 1 / 2) return q;
		if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
		return p;
	};
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	return [
		Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
		Math.round(hue2rgb(p, q, h) * 255),
		Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
	];
}

/** 内部 tool call card 背景：在所选语义背景基础上按 HSL 变暗（l×0.7），
 *  与外卡片形成嵌套层次；非 RGB 色或已足够暗时原样返回。 */
function darkenBgAnsi(theme: any, slot: string): string {
	const prefix = typeof theme?.getBgAnsi === "function" ? String(theme.getBgAnsi(slot)) : "";
	const m = prefix.match(/48;2;(\d+);(\d+);(\d+)/);
	if (!m) return prefix;
	const [h, l, s] = rgbToHsl(Number(m[1]), Number(m[2]), Number(m[3]));
	if (l <= 0.05) return prefix; // 已足够暗，不再变暗
	const [r, g, b] = hslToRgb(h, l * 0.7, s);
	return `\x1b[48;2;${r};${g};${b}m`;
}

/** 工具卡深色行：左右内缩（左 2 右 3 格，含工具卡自身 padding），背景只到内容区，
 *  修复行尾 reset 截断。 */
function toolCardBgRow(
	theme: any,
	slot: string,
	bgAnsi: string,
	line: string,
	width: number,
): string {
	const leftInset = 2;
	const rightInset = 3;
	const contentWidth = Math.max(0, width - leftInset - rightInset);
	// 深色块内左右各 1 格内部 padding；去掉行首原有空格后重新对齐
	const text = stripBackgroundAnsi(line).replace(/^ +/, "");
	const innerPad = 2;
	const clipped = truncateToWidth(text, Math.max(0, contentWidth - innerPad), "");
	const pad = Math.max(0, contentWidth - innerPad - visibleWidth(clipped));
	const body = ` ${clipped}${" ".repeat(pad)} `;
	const stable = body.replace(/\x1b\[(?:0)?m/g, (reset) => reset + bgAnsi);
	const outerBg = typeof theme?.getBgAnsi === "function" ? String(theme.getBgAnsi(slot)) : "";
	const inset = (n: number) => (outerBg ? `${outerBg}${" ".repeat(n)}\x1b[49m` : " ".repeat(n));
	return `${inset(leftInset)}${bgAnsi}${stable}\x1b[49m${inset(rightInset)}`;
}

/** compact 展开卡：外卡片保持所选语义背景原色；内部 tool call card
 *  背景更深一层且只覆盖内容区（左右内缩、上下限首尾文本行），形成嵌套层次。
 *  hits：非工具子卡（thinking）的行区间，供展开后点击 hint。 */
function layoutExpandedToolCard(
	theme: any,
	children: any[],
	width: number,
): { lines: string[]; hits: Array<{ child: any; start: number; end: number; sourceRow: number; inset: number }> } {
	const slot = config.expandedCardBackground;
	const toolBgAnsi = darkenBgAnsi(theme, slot);
	const innerWidth = Math.max(0, width - 2);
	const lines: string[] = [];
	const hits: Array<{ child: any; start: number; end: number; sourceRow: number; inset: number }> = [];
	const isThinkingPreview = (child: any) => typeof child?.setHintHovered === "function";
	lines.push(paddedBackgroundRow(theme, slot, "", width));
	// 展开不再显示摘要行：跳过第一个 child 的首行空白，避免白占一行
	let skipLeadingBlank = true;
	for (const child of children) {
		const childLines = child.render(innerWidth);
		// 展开的 thinking 与 tool 一样走嵌套深色卡，避免贴在外卡同色底上看不见。
		const nest = child.__ccToolCard || (isThinkingPreview(child) && child.expanded === true);
		if (!nest) {
			let start = 0;
			if (skipLeadingBlank) {
				while (start < childLines.length && !hasVisibleText(childLines[start])) start++;
				skipLeadingBlank = false;
			}
			for (let i = start; i < childLines.length; i++) {
				hits.push({ child, start: lines.length, end: lines.length + 1, sourceRow: i, inset: 1 });
				lines.push(paddedBackgroundRow(theme, slot, childLines[i], width));
			}
			continue;
		}
		// 工具卡：前导 1 空行 + 首尾文本行之间的内容区（深色）；不保留尾随，
		// 相邻工具卡之间正好 1 空行，底部由卡片 padding 收尾。
		skipLeadingBlank = false;
		let first = -1;
		let last = -1;
		for (let i = 0; i < childLines.length; i++) {
			if (hasVisibleText(childLines[i])) {
				if (first < 0) first = i;
				last = i;
			}
		}
		if (first < 0) {
			for (const line of childLines) {
				lines.push(paddedBackgroundRow(theme, slot, line, width));
			}
			continue;
		}
		lines.push(paddedBackgroundRow(theme, slot, "", width));
		// 子卡片内部上下各 1 行深色 padding
		lines.push(toolCardBgRow(theme, slot, toolBgAnsi, "", width));
		for (let i = first; i <= last; i++) {
			hits.push({ child, start: lines.length, end: lines.length + 1, sourceRow: i,
				inset: 3 - (stripBackgroundAnsi(childLines[i]).match(/^ */)?.[0].length ?? 0) });
			lines.push(toolCardBgRow(theme, slot, toolBgAnsi, childLines[i], width));
		}
		lines.push(toolCardBgRow(theme, slot, toolBgAnsi, "", width));
	}
	lines.push(paddedBackgroundRow(theme, slot, "", width));
	return { lines, hits };
}

function compactRoundCard(
	cardItems: Array<{ child?: any; tool?: any }>,
	toolRender: (tool: any, width: number) => string[],
): any {
	const children: any[] = [];
	for (const item of cardItems) {
		if (item.child) children.push(item.child);
		else if (item.tool) {
			const tool = item.tool;
			children.push({
				__ccToolCard: true,
				handleMouse: (event: TuiMouseEvent) => tool.handleMouse?.(event),
				render: (innerWidth: number) => toolRender(tool, innerWidth),
				invalidate: () => tool.invalidate?.(),
			});
		}
	}
	let layout: ReturnType<typeof layoutExpandedToolCard> | undefined;
	return {
		children,
		render(width: number): string[] {
			layout = layoutExpandedToolCard(themeOf(), children, width);
			return ["", ...layout.lines];
		},
		handleMouse(event: TuiMouseEvent) {
			const hit = layout?.hits.find((hit) => event.y - 1 >= hit.start && event.y - 1 < hit.end);
			if (!hit) return undefined;
			return new MouseRegion(hit.child, () => undefined).handleMouse({ ...event,
				x: event.x - hit.inset, y: hit.sourceRow, width: Math.max(1, event.width - 2),
			});
		},
		childAtRow(localRow: number, width: number) {
			if (localRow < 1) return null;
			const row = localRow - 1;
			const { hits } = layoutExpandedToolCard(themeOf(), children, width);
			for (const hit of hits) {
				if (row >= hit.start && row < hit.end) return hit.child;
			}
			return null;
		},
		invalidate() {
			for (const child of children) child.invalidate?.();
		},
	};
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
		suppressedToolIds: Set<string>;
		clock?: WorkClock;
		/** 收尾时记录中止结局，保证重绘结论稳定。 */
		settledAborted?: boolean;
		summaryComponent?: any;
		summaryParent?: { children: any[] };
	};
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
	const expandedRoundToolIds = new Set<string>();
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

	const renderRound = (round: CompactRound): void => {
		const messages = roundMessages(round);
		const stopStatus = roundStopStatus(messages);
		if (stopStatus && (!activityActive || !round.active)) endRound(round);
		// Running 时每次 render 重算时长（含挂钟下限）；结束后固定。
		const getSummary = () => summarize(roundMessages(round), round.active, round);
		const summary = getSummary();
		for (const id of round.suppressedToolIds) expandedRoundToolIds.delete(id);
		round.suppressedToolIds.clear();

		for (const [component, message] of round.messages) {
			component.lastMessage = round.proseMessages.get(component) ?? message;
			ensureAssistantSetExpanded(component);
			component[ASSISTANT_TOGGLE_ROUND_KEY] = (expanded: boolean) => {
				for (const member of round.messages.keys()) member.expanded = expanded;
				if (!expanded) {
					for (const id of round.suppressedToolIds) expandedRoundToolIds.delete(id);
					round.suppressedToolIds.clear();
				}
				renderRound(round);
			};
		}

		if (round.anchor.expanded === true) {
			const toolsById = new Map<string, any>();
			for (const tool of trackedToolComponents) {
				if (typeof tool?.toolCallId === "string") toolsById.set(tool.toolCallId, tool);
			}
			const cardItems: Array<{ child?: any; tool?: any }> = [];
			const placedToolIds = new Set<string>();
			const takeAssistantRun = (kids: any[], cursor: { i: number }) => {
				while (cursor.i < kids.length && kids[cursor.i] instanceof Spacer) {
					cardItems.push({ child: kids[cursor.i++] });
				}
				if (cursor.i < kids.length) cardItems.push({ child: kids[cursor.i++] });
			};
			const placeTool = (id: string, fallbackName?: string) => {
				const tool = toolsById.get(id);
				if (!tool || !resolveRendererPolicy(tool).compactable) return;
				if (placedToolIds.has(id)) return;
				placedToolIds.add(id);
				tool[COMPACT_ROUND_PARENT] = round.anchor;
				cardItems.push({ tool });
			};
			for (const [component, message] of round.messages) {
				passThroughAssistant(component, withoutStopStatus(message));
				component.lastMessage = round.proseMessages.get(component) ?? message;
				const kids = Array.isArray(component.contentContainer?.children)
					? [...component.contentContainer.children]
					: [];
				component.contentContainer?.clear?.();
				const cursor = { i: 0 };
				let inThinkingRun = false;
				for (const item of Array.isArray(message?.content) ? message.content : []) {
					if (item?.type === "thinking") {
						if (!String(item.thinking ?? "").trim()) continue;
						if (!inThinkingRun) {
							takeAssistantRun(kids, cursor);
							inThinkingRun = true;
						}
						continue;
					}
					inThinkingRun = false;
					if (item?.type === "text" && String(item.text ?? "").trim()) {
						takeAssistantRun(kids, cursor);
						continue;
					}
					if (item?.type === "toolCall" && typeof item.id === "string") {
						placeTool(item.id, item.name);
					}
				}
				while (cursor.i < kids.length) cardItems.push({ child: kids[cursor.i++] });
			}
			const ids = new Set([...roundToolCallIds(round)].filter((id) => {
				const tool = toolsById.get(id);
				return tool && resolveRendererPolicy(tool).compactable;
			}));
			for (const id of ids) {
				round.suppressedToolIds.add(id);
				expandedRoundToolIds.add(id);
				if (!placedToolIds.has(id)) placeTool(id);
			}
			// Round 展开只打开外层卡片。普通工具保持折叠，避免长输出递归撑满屏幕。
			for (const tool of trackedToolComponents) {
				if (
					!ids.has(tool.toolCallId) ||
					tool.expanded !== true || tool[COMPACT_LOCAL_EXPANSION] === true
				) {
					continue;
				}
				if (typeof tool.setExpanded === "function") tool.setExpanded(false);
				else {
					tool.expanded = false;
					tool.updateDisplay?.();
				}
			}
			// Native prose stays outside the process card, including when the
			// thinking anchor itself becomes the final response.
			for (const [component, message] of round.proseMessages) renderAssistantWithoutThinking(component, message);
			round.anchor.contentContainer.addChild(
				compactRoundCard(cardItems, (tool, innerWidth) =>
					patch.toolOriginalRender.call(tool, innerWidth),
				),
			);
			// 展开卡内工具会显示 error，外层仍挂 abort/length，避免只藏在折叠工具里。
			appendStopStatus(round.anchor, stopStatus);
			return;
		}

		for (const [component, message] of round.messages) {
			if (component === round.anchor) {
				const prose = round.proseMessages.get(component);
				renderAssistantWithoutThinking(component, prose ?? withoutStopStatus(message));
				component.lastMessage = prose ?? message;
				// 空摘要不挂行（getter 在 Running 启动瞬间也可能短暂为空）
				if (!round.summaryParent && (summary || round.active)) compactAssistantLine(component, getSummary, deps.query);
				// 折叠时工具行被隐藏：abort/error/length 必须挂在摘要外层。
				if (!round.summaryParent) appendStopStatus(component, stopStatus);
			} else {
				const prose = round.proseMessages.get(component);
				if (prose) renderAssistantWithoutThinking(component, prose);
				else component.contentContainer?.clear?.();
			}
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
		}
		activeRound = undefined;
		expandedRoundToolIds.clear();
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
		const hasText = content.some(
			(item: any) => item?.type === "text" && typeof item.text === "string" && item.text.trim(),
		);
		self.hasToolCalls = hasToolCalls;

		if (hasToolCalls) {
			const retained = componentClocks.get(this) ?? messageClocks.get(message);
			let round = roundByComponent.get(this) ?? (retained ? roundToJoin(this, message) : undefined);
			if (hasText && !round) {
				if (activeRound && !retained) finishRound(activeRound);
				round = {
					anchor: this,
					messages: new Map(),
					proseMessages: new Map(),
					active: true,
					suppressedToolIds: new Set(),
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
					suppressedToolIds: new Set(),
					clock: clockFor(this, message),
				};
				roundByComponent.set(this, round);
			}
			roundByComponent.set(this, round);
			if (!rounds.has(round)) activateRound(round);
			round.proseMessages.delete(this);
			round.messages.set(this, message);
			if (round.clock) rememberClock(this, message, round.clock);
			renderRound(round);
			return undefined;
		}

		if (hasText) {
			const round = roundByComponent.get(this);
			if (round) {
				round.proseMessages.set(this, message);
				if (!rounds.has(round)) activateRound(round);
				renderRound(round);
				return undefined;
			}
			if (activeRound && (!activityActive || !activeRound.active)) finishRound(activeRound);
			return renderAssistantWithoutThinking(this, message);
		}

		const hasThinking = content.some((item: any) => item?.type === "thinking");
		if (hasThinking) {
			let round = roundByComponent.get(this);
			if (!round) {
				round = roundToJoin(this, message) ?? {
					anchor: this,
					messages: new Map(),
					proseMessages: new Map(),
					active: true,
					suppressedToolIds: new Set(),
					clock: clockFor(this, message),
				};
				roundByComponent.set(this, round);
			}
			if (!rounds.has(round)) activateRound(round);
			round.proseMessages.delete(this);
			round.messages.set(this, message);
			if (round.clock) rememberClock(this, message, round.clock);
			renderRound(round);
			return undefined;
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
		if (!resolveRendererPolicy(this).compactable) return patch.toolOriginalRender.call(this, width);
		// Only tools approved by the shared policy join the round summary.
		if (expandedRoundToolIds.has(String(this.toolCallId ?? ""))) return [];
		// 普通工具折叠时不显示独立行（摘要行已统计），独立展开走原 renderer。
		if (this.expanded === true) {
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
			expandedRoundToolIds.has(String(this.toolCallId ?? "")) && this[COMPACT_LOCAL_EXPANSION] !== true
		) {
			this.expanded = false;
		}
		const result = patch.toolOriginalUpdateDisplay.call(this);
		if (!patch.active) return result;
		knownTranscriptComponents.add(this);
		trackedToolComponents.add(this);
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
		trackedAssistantComponents.clear();
		trackedToolComponents.clear();
		hoveredAssistantComponent = undefined;
		resetRounds();
		roundByComponent = new WeakMap();
		for (const clock of unfinishedClocks) finishClock(clock);
		activityClock = undefined;
		componentClocks = new WeakMap();
		messageClocks = new WeakMap();
	};

	try {
		steps.push(installMethodStep(assistantPrototype, "updateContent", () => patch.assistantInstalled));
		steps.push(installMethodStep(toolPrototype, "render", () => patch.toolInstalledRender));
		steps.push(installMethodStep(toolPrototype, "updateDisplay", () => patch.toolInstalledUpdateDisplay));
		// Reconcile on real transcript mounting, before the first host paint.
		// Waiting for the editor widget would leave one stale historical frame.
		steps.push(installMethodStep(Container.prototype as any, "addChild", (downstream) => function (this: any, child: any) {
			const result = downstream.call(this, child);
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
		resetRounds();
		// 始终保持补丁在链上：mode=on/off 走 passThrough，仍写入 lastMessage
		// 与 tracked 集合，这样 /ccstyle 切回 compact 时不必 /reload。
		patch.assertAssistantOwnership();
		if (config.mode === "compact") syncGlobalExpanded(ctx);
		else hoveredAssistantComponent = undefined;
		return true;
	};

	return {
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
		groupBoundary() {
			if (activeRound) endRound(activeRound, true);
			for (const clock of unfinishedClocks) finishClock(clock);
			activityClock = activityActive ? createClock(Date.now()) : undefined;
			activeRound = undefined;
		},
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
