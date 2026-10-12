// Adapted from pi-cc-extensions v0.8.69; see THIRD_PARTY_NOTICES.md.
// Includes pi-compact-thinking (MIT), copyright (c) 2026 Tifan Dwi Avianto.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text, getKeybindings, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { isToolTuiFullscreen } from "./tool/show-more-hint.ts";
import type { CompactThinkingConfig } from "../state/thinking-controller.ts";
import { config as styleConfig } from "../config/config.ts";

const config: CompactThinkingConfig = {
	useSummaryTitlesAsThinkingTitle: true,
	previewLines: 3,
	animationIntervalMs: 90,
};

export function setThinkingPreviewConfig(next: CompactThinkingConfig): void {
	Object.assign(config, next);
}

export function clearThinkingExpansion(): void {
	expandedThinking.clear();
	clearThinkingPreviewCache();
}

type SummaryPart = { title: string; body: string };
export type DurationEntryData = { messageTimestamp: number; contentIndex: number; durationMs: number };
export const DURATION_ENTRY_TYPE = "claude-style-tools-thinking-duration";

export function restoreDurationEntries(
	entries: Array<{ type: string; customType?: string; data?: unknown }>,
	completedDurations: Map<number, Map<number, number>>,
) {
	completedDurations.clear();
	for (const entry of entries) {
		if (
			entry.type !== "custom" ||
			entry.customType !== DURATION_ENTRY_TYPE ||
			!entry.data ||
			typeof entry.data !== "object"
		) {
			continue;
		}

		const data = entry.data as Partial<DurationEntryData>;
		if (
			typeof data.messageTimestamp !== "number" ||
			!Number.isFinite(data.messageTimestamp) ||
			typeof data.contentIndex !== "number" ||
			!Number.isInteger(data.contentIndex) ||
			typeof data.durationMs !== "number" ||
			!Number.isFinite(data.durationMs) ||
			data.durationMs < 1
		) {
			continue;
		}

		let durations = completedDurations.get(data.messageTimestamp);
		if (!durations) {
			durations = new Map();
			completedDurations.set(data.messageTimestamp, durations);
		}
		durations.set(data.contentIndex, data.durationMs);
	}
}

function getThinkingToggleHint() {
	const keys = getKeybindings().getKeys("app.thinking.toggle");
	return keys.length > 0 ? `${keys.join("/")} to expand` : undefined;
}

function thinkingExpandAction(): string | undefined {
	return isToolTuiFullscreen() ? "click to show more" : getThinkingToggleHint();
}

// 只 wrap 尾部窗口；缓存未着色折行，着色放到取出时做，避免主题切换命中旧 ANSI。
type PreviewCacheEntry = { lines: string[]; hiddenBefore: number };
const previewCache = new Map<string, PreviewCacheEntry>();
export const THINKING_PREVIEW_CACHE_MAX = 2_048;
const PREVIEW_BUDGET_MIN_CHARS = 2_000;
const PREVIEW_BUDGET_SLACK_LINES = 2;

function getCachedPreview(key: string): PreviewCacheEntry | undefined {
	const entry = previewCache.get(key);
	if (!entry) return undefined;
	previewCache.delete(key);
	previewCache.set(key, entry);
	return entry;
}

function cachePreview(key: string, entry: PreviewCacheEntry): void {
	previewCache.delete(key);
	while (previewCache.size >= THINKING_PREVIEW_CACHE_MAX) {
		const oldest = previewCache.keys().next().value;
		if (oldest === undefined) break;
		previewCache.delete(oldest);
	}
	previewCache.set(key, entry);
}

export function clearThinkingPreviewCache(): void {
	previewCache.clear();
	expandedWrapCache.clear();
}

type ExpandedWrapEntry = { text: string; lines: string[] };
const expandedWrapCache = new Map<string, ExpandedWrapEntry>();
export const THINKING_EXPANDED_WRAP_CACHE_MAX = 64;

function expandedWrapKey(messageTimestamp: number, runStartIndex: number, width: number): string {
	return `${messageTimestamp}:${runStartIndex}:${width}`;
}

function wrapExpandedThinking(
	messageTimestamp: number,
	runStartIndex: number,
	text: string,
	width: number,
): string[] {
	const key = expandedWrapKey(messageTimestamp, runStartIndex, width);
	const hit = expandedWrapCache.get(key);
	if (hit && hit.text === text) {
		expandedWrapCache.delete(key);
		expandedWrapCache.set(key, hit);
		return hit.lines;
	}
	const lines = wrapTextWithAnsi(text.replace(/\t/g, "   "), Math.max(1, width));
	expandedWrapCache.delete(key);
	while (expandedWrapCache.size >= THINKING_EXPANDED_WRAP_CACHE_MAX) {
		const oldest = expandedWrapCache.keys().next().value;
		if (oldest === undefined) break;
		expandedWrapCache.delete(oldest);
	}
	expandedWrapCache.set(key, { text, lines });
	return lines;
}

function evictExpandedWraps(messageTimestamp: number, runStartIndex: number): void {
	for (const key of expandedWrapCache.keys()) {
		const [ts, run] = key.split(":");
		if (Number(ts) === messageTimestamp && Number(run) === runStartIndex) {
			expandedWrapCache.delete(key);
		}
	}
}

export function thinkingPreviewCacheSize(): number {
	return previewCache.size;
}

export function thinkingExpandedWrapCacheSize(): number {
	return expandedWrapCache.size;
}

/** 按可见宽度估算折行数，不走 Text 全量 wrap。无换行长段也能计到隐藏行。 */
function countWrappedLines(text: string, contentWidth: number): number {
	if (!text) return 0;
	const width = Math.max(1, contentWidth);
	let lines = 0;
	for (const raw of text.replace(/\t/g, "   ").split(/\r\n|\r|\n/)) {
		const w = visibleWidth(raw);
		lines += w === 0 ? 1 : Math.ceil(w / width);
	}
	return lines;
}

function padPreviewLine(line: string, width: number, padding: number): string {
	const left = padding > 0 ? " ".repeat(padding) : "";
	const right = padding > 0 ? " ".repeat(padding) : "";
	const withMargins = left + line + right;
	return withMargins + " ".repeat(Math.max(0, width - visibleWidth(withMargins)));
}

function layoutThinkingPreview(
	text: string,
	width: number,
	padding: number,
): { visible: string[]; hiddenLines: number } {
	if (!text || config.previewLines <= 0) return { visible: [], hiddenLines: 0 };
	const contentWidth = Math.max(1, width - padding * 2);
	const budget = Math.max(
		width * (config.previewLines + PREVIEW_BUDGET_SLACK_LINES),
		PREVIEW_BUDGET_MIN_CHARS,
	);
	let source = text;
	let cut = 0;
	if (source.length > budget) {
		const start = source.length - budget;
		const newline = source.indexOf("\n", start);
		cut = newline === -1 ? start : newline + 1;
		if (cut < source.length) source = source.slice(cut);
		else cut = 0;
	}
	const cacheKey = `${width}:${padding}:${cut}:${source}`;
	let entry = getCachedPreview(cacheKey);
	if (!entry) {
		entry = {
			lines: wrapTextWithAnsi(source.replace(/\t/g, "   "), contentWidth),
			hiddenBefore: cut > 0 ? countWrappedLines(text.slice(0, cut), contentWidth) : 0,
		};
		cachePreview(cacheKey, entry);
	}
	const hiddenLines = entry.hiddenBefore + Math.max(0, entry.lines.length - config.previewLines);
	const visible = hiddenLines > 0 ? entry.lines.slice(-config.previewLines) : entry.lines;
	return { visible, hiddenLines };
}

function hiddenPreviewHint(
	hiddenLines: number,
	forceExpandHint = false,
): { prefix: string; action: string; suffix: string } | undefined {
	const action = thinkingExpandAction() ?? "";
	if (hiddenLines > 0) {
		const noun = hiddenLines === 1 ? "line" : "lines";
		return {
			prefix: ` • (${hiddenLines} more ${noun}${action ? ", " : ""}`,
			action,
			suffix: ")",
		};
	}
	if (forceExpandHint && isToolTuiFullscreen()) {
		return { prefix: " • ", action: "click to show more", suffix: "" };
	}
	return undefined;
}

const expandedThinking = new Set<string>();

/** 折叠预览 + 展开全文。fullscreen 点击 hint 展开、双击整块收起，对齐工具卡。 */
export class ThinkingPreviewBlock implements Component {
	private heading: string;
	private text: string;
	private padding: number;
	readonly messageTimestamp: number;
	readonly runStartIndex: number;
	private style: (text: string) => string;
	private theme: Theme | undefined;
	private _expanded: boolean;
	private hintHovered = false;
	private actionRow: number | undefined;
	private titleWidths: number[] = [];
	private collapsedMemo:
		| {
				width: number;
				previewLines: number;
				hintHovered: boolean;
				expandAction: string | undefined;
				lines: string[];
		  }
		| undefined;

	constructor(
		heading: string,
		text: string,
		padding: number,
		messageTimestamp: number,
		style: (text: string) => string,
		theme?: Theme,
		runStartIndex = 0,
	) {
		this.heading = heading;
		this.text = text;
		this.padding = padding;
		this.messageTimestamp = messageTimestamp;
		this.runStartIndex = runStartIndex;
		this.style = style;
		this.theme = theme;
		this._expanded = expandedThinking.has(`${messageTimestamp}:${runStartIndex}`);
	}

	private paint(color: string, text: string): string {
		return this.theme && typeof this.theme.fg === "function"
			? this.theme.fg(color as never, text)
			: text;
	}

	get expanded(): boolean {
		return this._expanded;
	}

	setExpanded(expanded: boolean): void {
		if (this._expanded !== expanded) this.collapsedMemo = undefined;
		this._expanded = expanded;
		if (expanded) expandedThinking.add(`${this.messageTimestamp}:${this.runStartIndex}`);
		else {
			expandedThinking.delete(`${this.messageTimestamp}:${this.runStartIndex}`);
			evictExpandedWraps(this.messageTimestamp, this.runStartIndex);
		}
	}

	actionAtRow(row: number): "expand" | undefined {
		return !this._expanded && row === this.actionRow ? "expand" : undefined;
	}

	actionAtPoint(row: number, x: number): "expand" | undefined {
		const width = this.titleWidths[row] ?? 0;
		return !this._expanded && x >= this.padding && x < this.padding + width ? "expand" : undefined;
	}

	setHintHovered(hovered: boolean): void {
		if (this.hintHovered !== hovered) this.collapsedMemo = undefined;
		this.hintHovered = hovered;
	}

	private headingLines(width: number, hiddenLines: number, padding: number): string[] {
		const hint = this._expanded
			? undefined
			: hiddenPreviewHint(hiddenLines, Boolean(this.text) && config.previewLines <= 0);
		this.actionRow = undefined;
		this.titleWidths = [];
		if (!hint) {
			const lines = new Text(this.heading, padding, 0).render(width);
			this.titleWidths = lines.map((line) =>
				Math.max(0, visibleWidth(line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trimEnd()) - padding));
			return lines;
		}
		const rawHint = hint.prefix + hint.action + hint.suffix;
		const contentWidth = Math.max(1, width - padding * 2);
		const headingBudget = Math.max(0, contentWidth - visibleWidth(rawHint));
		const clipped =
			visibleWidth(this.heading) > headingBudget
				? truncateToWidth(this.heading, headingBudget, "")
				: this.heading;
		this.titleWidths = [visibleWidth(clipped)];
		const action = this.paint(this.hintHovered ? "text" : "dim", hint.action);
		const lines = new Text(
			clipped + this.paint("dim", hint.prefix) + action + this.paint("dim", hint.suffix),
			padding,
			0,
		).render(width);
		if (hint.action && lines.at(-1)?.includes(hint.action)) this.actionRow = lines.length - 1;
		return lines;
	}

	private bodyLines(width: number, padding: number): { lines: string[]; hiddenLines: number } {
		if (!this.text || (config.previewLines <= 0 && !this._expanded)) {
			return { lines: [], hiddenLines: 0 };
		}
		if (this._expanded) {
			return {
				lines: wrapExpandedThinking(this.messageTimestamp, this.runStartIndex, this.text, width),
				hiddenLines: 0,
			};
		}
		const preview = layoutThinkingPreview(this.text, width, padding);
		return { lines: preview.visible, hiddenLines: preview.hiddenLines };
	}

	render(width: number) {
		if (this._expanded) {
			const innerWidth = Math.max(1, width - 2);
			const body = this.bodyLines(innerWidth, 0);
			const heading = this.headingLines(innerWidth, 0, 0);
			const inner = body.lines.length
				? [...heading, ...body.lines.map((line) => this.style(line))]
				: heading;
			const bgFn =
				this.theme && typeof this.theme.bg === "function"
					? (text: string) => this.theme!.bg(styleConfig.expandedCardBackground, text)
					: undefined;
			const box = new Box(1, 1, bgFn);
			box.addChild({
				render: () => inner,
				invalidate() {},
			});
			return box.render(width);
		}

		const expandAction = thinkingExpandAction();
		if (
			this.collapsedMemo?.width === width &&
			this.collapsedMemo.previewLines === config.previewLines &&
			this.collapsedMemo.hintHovered === this.hintHovered &&
			this.collapsedMemo.expandAction === expandAction
		) {
			return this.collapsedMemo.lines;
		}

		const body = this.bodyLines(width, this.padding);
		const heading = this.headingLines(width, body.hiddenLines, this.padding);
		const lines = body.lines.length
			? [
					...heading,
					...body.lines.map((line) => padPreviewLine(this.style(line), width, this.padding)),
				]
			: heading;
		this.collapsedMemo = {
			width,
			previewLines: config.previewLines,
			hintHovered: this.hintHovered,
			expandAction,
			lines,
		};
		return lines;
	}

	invalidate() {
		this.collapsedMemo = undefined;
	}
}

function parseSummaryPart(text: string): SummaryPart | undefined {
	const match = /^\s*\*\*([^\n]+?)\*\*[ \t]*(?:\r?\n(?:\r?\n)?([\s\S]*))?\s*$/.exec(text);
	if (!match) return undefined;
	return { title: match[1].trim(), body: (match[2] ?? "").trim() };
}

function parseLatestStreamingSummary(text: string): SummaryPart | undefined {
	// Providers do not consistently insert a blank line between streamed
	// summary parts, so accept a bold title at the start of any source line.
	const titlePattern = /(?:^|\r?\n)\s*\*\*([^\n*]+?)\*\*[ \t]*(?:\r?\n)?/g;
	let latest: RegExpExecArray | undefined;
	let match: RegExpExecArray | null;
	while ((match = titlePattern.exec(text))) latest = match;
	if (!latest) return parseSummaryPart(text);

	return {
		title: latest[1].trim(),
		body: text.slice(latest.index + latest[0].length).trim(),
	};
}

function isOpenAiResponsesMessage(message: AssistantMessage) {
	return (
		message.api === "openai-responses" ||
		message.api === "openai-codex-responses" ||
		message.api === "azure-openai-responses"
	);
}

function getLatestOpenAiSummary(thinkingSignature: string | undefined): SummaryPart | undefined {
	if (!thinkingSignature) return undefined;

	try {
		const item = JSON.parse(thinkingSignature) as {
			type?: unknown;
			summary?: Array<{ type?: unknown; text?: unknown }>;
		};
		if (item.type !== "reasoning" || !Array.isArray(item.summary)) {
			return undefined;
		}

		for (let i = item.summary.length - 1; i >= 0; i--) {
			const part = item.summary[i];
			if (part.type !== "summary_text" || typeof part.text !== "string") {
				continue;
			}
			const parsed = parseSummaryPart(part.text);
			if (parsed) return parsed;
		}
	} catch {
		// Invalid or provider-specific signatures use the generic fallback.
	}
	return undefined;
}

/** Latest summary in a contiguous thinking run; live text wins while streaming. */
export function thinkingRunSummary(
	message: AssistantMessage,
	start: number,
	end: number,
	activeContentIndex: number | undefined,
	useTitles: boolean,
): { text: string; summary: SummaryPart | undefined } {
	const blocks: string[] = [];
	let summary: SummaryPart | undefined;
	for (let index = start; index <= end; index++) {
		const block = message.content[index];
		if (block.type !== "thinking" || !block.thinking.trim()) continue;
		const thinking = block.thinking.trim();
		blocks.push(thinking);
		if (!useTitles || !isOpenAiResponsesMessage(message)) continue;
		const live = parseLatestStreamingSummary(thinking);
		const structured = getLatestOpenAiSummary(block.thinkingSignature);
		summary = index === activeContentIndex ? live ?? structured ?? summary : structured ?? live ?? summary;
	}
	return { text: (summary?.body ?? blocks.join("\n\n")).trim(), summary };
}
