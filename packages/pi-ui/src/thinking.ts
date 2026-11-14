import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Container, Spacer, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { UiConfig } from "./config.js";

const DURATION_ENTRY_TYPE = "pi-ui-thinking-duration";
const MAX_DURATION_ENTRIES = 2048;
const PREVIEW_BUDGET_LIMIT = 16_000;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type ThinkingConfig = Pick<UiConfig, "useSummaryTitlesAsThinkingTitle" | "previewLines" | "animationIntervalMs">;

const fallbackConfig: ThinkingConfig = {
	useSummaryTitlesAsThinkingTitle: true,
	previewLines: 3,
	animationIntervalMs: 90,
};

type UpdateContent = (this: HostAssistant, message: AssistantMessage, isStreaming?: boolean) => void;
type SetHideThinkingBlock = (this: HostAssistant, hide: boolean) => void;

interface HostAssistant {
	contentContainer?: { children: unknown[] };
	hideThinkingBlock?: boolean;
	hiddenThinkingLabel?: string;
	outputPad?: number;
	thinkingVisibilityOverrides?: Map<number, boolean>;
}

interface PatchablePrototype {
	updateContent: UpdateContent;
	setHideThinkingBlock: SetHideThinkingBlock;
}

interface ThinkingServices {
	getConfig: () => ThinkingConfig;
	requestRender: () => void;
	getTheme: () => Theme;
}

interface ActiveRun {
	messageTimestamp: number;
	runStart: number;
	contentIndex: number;
	startedAt: number;
}

interface SummaryPart {
	title: string;
	body: string;
}

interface ThinkingRun {
	start: number;
	end: number;
	fullText: string;
	blocks: { contentIndex: number; text: string }[];
}

interface RunViewData {
	messageTimestamp: number;
	start: number;
	fullText: string;
	summary?: SummaryPart;
}

interface ViewState {
	live: boolean;
	durationMs: number | undefined;
	frame: number;
}

interface ThinkingReader {
	config(): ThinkingConfig;
	theme(): Theme | undefined;
	viewState(messageTimestamp: number, runStart: number): ViewState;
}

interface PreviewResult {
	lines: string[];
	truncated: boolean;
}

interface PreviewMemo extends PreviewResult {
	body: string;
	width: number;
	previewLines: number;
}

interface TitleMemo {
	source: string;
	width: number;
	text: string;
}

interface DurationData {
	messageTimestamp: number;
	contentIndex: number;
	durationMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

const RESIDUAL_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

function sanitizeThinkingText(text: string): string {
	return stripTerminalSequences(text).replace(RESIDUAL_CONTROL, "");
}

function isHostRegion(value: unknown): value is { child: Component } {
	if (!isRecord(value)) return false;
	return "child" in value && value["child"] !== undefined && typeof value["onMouse"] === "function";
}

function parseSummaryPartSanitized(text: string): SummaryPart | undefined {
	const match = /^\s*\*\*([^\n]+?)\*\*[ \t]*(?:\r?\n(?:\r?\n)?([\s\S]*))?\s*$/.exec(text);
	const title = match?.[1]?.trim();
	if (!title) return undefined;
	return { title, body: match?.[2]?.trim() ?? "" };
}

function parseSummaryPart(text: string): SummaryPart | undefined {
	return parseSummaryPartSanitized(sanitizeThinkingText(text));
}

function parseLatestStreamingSummarySanitized(text: string): SummaryPart | undefined {
	const pattern = /(?:^|\r?\n)\s*\*\*([^\n*]+?)\*\*[ \t]*(?:\r?\n)?/g;
	let last: RegExpExecArray | undefined;
	for (const match of text.matchAll(pattern)) last = match;
	if (!last) return parseSummaryPartSanitized(text);
	const title = last[1]?.trim();
	if (!title) return undefined;
	const bodyStart = (last.index ?? 0) + (last[0]?.length ?? 0);
	return { title, body: text.slice(bodyStart).trim() };
}

function getLatestOpenAiSummary(signature: string | undefined): SummaryPart | undefined {
	if (!signature) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(signature);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || parsed["type"] !== "reasoning" || !Array.isArray(parsed["summary"])) return undefined;
	const summary = parsed["summary"];
	for (let index = summary.length - 1; index >= 0; index -= 1) {
		const part = summary[index];
		if (!isRecord(part) || part["type"] !== "summary_text" || typeof part["text"] !== "string") continue;
		const parsedPart = parseSummaryPart(part["text"]);
		if (parsedPart) return parsedPart;
	}
	return undefined;
}

function collectThinkingRuns(content: AssistantMessage["content"]): ThinkingRun[] {
	const runs: ThinkingRun[] = [];
	for (let index = 0; index < content.length;) {
		if (content[index]?.type !== "thinking") {
			index += 1;
			continue;
		}
		const start = index;
		const blocks: string[] = [];
		const sanitizedBlocks: { contentIndex: number; text: string }[] = [];
		while (index < content.length && content[index]?.type === "thinking") {
			const block = content[index];
			if (block?.type === "thinking") {
				const text = sanitizeThinkingText(block.thinking).trim();
				if (text) {
					blocks.push(text);
					sanitizedBlocks.push({ contentIndex: index, text });
				}
			}
			index += 1;
		}
		if (blocks.length > 0) runs.push({ start, end: index - 1, fullText: blocks.join("\n\n"), blocks: sanitizedBlocks });
	}
	return runs;
}

function summarizeRun(
	content: AssistantMessage["content"],
	run: ThinkingRun,
	activeContentIndex: number | undefined,
): SummaryPart | undefined {
	let summary: SummaryPart | undefined;
	for (const block of run.blocks) {
		const live = parseLatestStreamingSummarySanitized(block.text);
		const source = content[block.contentIndex];
		const structured = source?.type === "thinking" ? getLatestOpenAiSummary(source.thinkingSignature) : undefined;
		if (block.contentIndex === activeContentIndex) summary = live ?? structured ?? summary;
		else summary = structured ?? live ?? summary;
	}
	return summary;
}

function assertHostShape(probe: unknown): void {
	if (!isRecord(probe)) throw new Error("pi-ui thinking: AssistantMessageComponent private shape is incompatible");
	const container = probe["contentContainer"];
	if (!isRecord(container) || !Array.isArray(container["children"])) {
		throw new Error("pi-ui thinking: AssistantMessageComponent private shape is incompatible (contentContainer.children)");
	}
	if (typeof probe["hideThinkingBlock"] !== "boolean") {
		throw new Error("pi-ui thinking: AssistantMessageComponent private shape is incompatible (hideThinkingBlock)");
	}
	if (typeof probe["hiddenThinkingLabel"] !== "string") {
		throw new Error("pi-ui thinking: AssistantMessageComponent private shape is incompatible (hiddenThinkingLabel)");
	}
	if (typeof probe["outputPad"] !== "number" || !Number.isFinite(probe["outputPad"])) {
		throw new Error("pi-ui thinking: AssistantMessageComponent private shape is incompatible (outputPad)");
	}
	if (!(probe["thinkingVisibilityOverrides"] instanceof Map)) {
		throw new Error("pi-ui thinking: AssistantMessageComponent private shape is incompatible (thinkingVisibilityOverrides)");
	}
}

function formatDuration(durationMs: number): string {
	if (durationMs < 1000) return `${Math.max(1, Math.round(durationMs))}ms`;
	const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes === 0) return `${seconds}s`;
	if (seconds === 0) return `${minutes}m`;
	return `${minutes}m ${seconds}s`;
}

function styleThinking(text: string, theme: Theme | undefined, bold: boolean): string {
	if (!theme) return text;
	let result = text;
	try {
		result = theme.fg("thinkingText", result);
		if (bold) result = theme.bold(result);
		result = theme.italic(result);
	} catch {
		return text;
	}
	return result;
}

function styleDim(text: string, theme: Theme | undefined): string {
	if (!theme) return text;
	try {
		return theme.fg("dim", text);
	} catch {
		return text;
	}
}

function animateThinking(text: string, theme: Theme | undefined, frame: number, baseBold: boolean): string {
	if (!theme || text.length === 0) return text;
	if (text.includes("\u001b")) return styleThinking(text, theme, baseBold);
	const graphemes = Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment);
	const highlightWidth = Math.max(1, Math.min(5, Math.ceil(graphemes.length * 0.28)));
	const start = (frame % (graphemes.length + highlightWidth)) - highlightWidth;
	const end = start + highlightWidth;
	let result = "";
	for (let index = 0; index < graphemes.length; index += 1) {
		const grapheme = graphemes[index] ?? "";
		const highlighted = index >= start && index < end;
		const styled = highlighted
			? theme.italic(theme.bold(theme.fg("text", grapheme)))
			: styleThinking(grapheme, theme, baseBold);
		result += styled;
	}
	return result;
}

function durationKey(messageTimestamp: number, runStart: number): string {
	return `${messageTimestamp}:${runStart}`;
}

function readDurationData(value: unknown): DurationData | undefined {
	if (!isRecord(value)) return undefined;
	const messageTimestamp = value["messageTimestamp"];
	const contentIndex = value["contentIndex"];
	const durationMs = value["durationMs"];
	if (typeof messageTimestamp !== "number" || !Number.isFinite(messageTimestamp)) return undefined;
	if (typeof contentIndex !== "number" || !Number.isInteger(contentIndex) || contentIndex < 0) return undefined;
	if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 1) return undefined;
	return { messageTimestamp, contentIndex, durationMs };
}

function fitLine(line: string, width: number, inset: number, available: number): string {
	const clipped = truncateToWidth(line, available);
	const padding = Math.max(0, width - inset - visibleWidth(clipped));
	return `${" ".repeat(inset)}${clipped}${" ".repeat(padding)}`;
}

class ThinkingView implements Component {
	private readonly data: RunViewData;
	private readonly hidden: boolean;
	private readonly nativeBody: Component;
	private readonly padding: number;
	private readonly hiddenLabel: string;
	private readonly reader: ThinkingReader;
	private previewMemo: PreviewMemo | undefined;
	private titleMemo: TitleMemo | undefined;

	constructor(data: RunViewData, hidden: boolean, nativeBody: Component, padding: number, hiddenLabel: string, reader: ThinkingReader) {
		this.data = data;
		this.hidden = hidden;
		this.nativeBody = nativeBody;
		this.padding = padding;
		this.hiddenLabel = sanitizeThinkingText(hiddenLabel).trim() || "Thinking...";
		this.reader = reader;
		this.previewMemo = undefined;
		this.titleMemo = undefined;
	}

	invalidate(): void {
		this.previewMemo = undefined;
		this.titleMemo = undefined;
		this.nativeBody.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const inset = Math.min(this.padding, Math.max(0, Math.floor((safeWidth - 1) / 2)));
		const available = Math.max(1, safeWidth - inset * 2);
		const config = this.reader.config();
		const useTitles = config.useSummaryTitlesAsThinkingTitle;
		const selectedSummary = useTitles ? this.data.summary : undefined;
		const title = selectedSummary?.title;
		const body = selectedSummary ? selectedSummary.body : this.data.fullText;
		const previewLines = Number.isFinite(config.previewLines)
			? Math.max(0, Math.min(20, Math.round(config.previewLines)))
			: 3;
		const state = this.reader.viewState(this.data.messageTimestamp, this.data.start);
		const theme = this.reader.theme();
		const preview = this.hidden ? this.preview(body, available, previewLines) : undefined;
		const heading = this.renderHeading(title, theme, state, inset, available, safeWidth, this.hidden && preview?.truncated === true);
		const bodyLines = this.hidden
			? (preview?.lines ?? []).map((line) => fitLine(styleThinking(line, theme, false), safeWidth, inset, available))
			: this.nativeBody.render(safeWidth);
		return [...heading, ...bodyLines];
	}

	private renderHeading(
		title: string | undefined,
		theme: Theme | undefined,
		state: ViewState,
		inset: number,
		available: number,
		width: number,
		truncated: boolean,
	): string[] {
		let heading: string;
		const duration = state.durationMs === undefined ? undefined : formatDuration(state.durationMs);
		if (state.live) {
			const liveText = title ?? (this.hiddenLabel || "Thinking...");
			const clippedTitle = this.clipTitle(liveText, available);
			heading = animateThinking(clippedTitle, theme, state.frame, title !== undefined);
			if (duration) heading += styleDim(` · ${duration}`, theme);
		} else if (title) {
			heading = styleThinking(this.clipTitle(title, available), theme, true);
			if (duration) heading += styleDim(` · ${duration}`, theme);
		} else if (duration) {
			heading = styleThinking(`Thought for ${duration}`, theme, false);
		} else {
			heading = styleThinking("Thought", theme, false);
		}
		if (truncated) heading += styleDim(" • click to expand", theme);
		const wrapped = wrapTextWithAnsi(heading, available);
		return wrapped.map((line) => fitLine(line, width, inset, available));
	}

	private clipTitle(text: string, available: number): string {
		const cached = this.titleMemo;
		if (cached && cached.source === text && cached.width === available) return cached.text;
		const clipped = stripTerminalSequences(truncateToWidth(text, Math.max(1, available)));
		this.titleMemo = { source: text, width: available, text: clipped };
		return clipped;
	}

	private preview(body: string, available: number, previewLines: number): PreviewResult {
		const cached = this.previewMemo;
		if (cached && cached.body === body && cached.width === available && cached.previewLines === previewLines) return cached;
		if (!body || previewLines === 0) {
			const result: PreviewMemo = { body, width: available, previewLines, lines: [], truncated: body.length > 0 };
			this.previewMemo = result;
			return result;
		}
		const budget = Math.min(PREVIEW_BUDGET_LIMIT, Math.max(2000, available * (previewLines + 2)));
		let source = body;
		let cut = 0;
		if (source.length > budget) {
			cut = source.length - budget;
			const newline = source.indexOf("\n", cut);
			source = newline === -1 ? source.slice(cut) : source.slice(newline + 1);
		}
		source = source.replace(/\t/g, "   ");
		const wrapped = source.length > 0 ? wrapTextWithAnsi(source, available) : [];
		const truncated = cut > 0 || wrapped.length > previewLines;
		const lines = previewLines > 0 ? wrapped.slice(-previewLines) : [];
		const result: PreviewMemo = { body, width: available, previewLines, lines, truncated };
		this.previewMemo = result;
		return result;
	}
}

class ThinkingControllerImpl implements ThinkingReader {
	private pi: ExtensionAPI | undefined;
	private services: ThinkingServices | undefined;
	private active: ActiveRun | undefined;
	private readonly durations = new Map<string, number>();
	private readonly unsubscribe: (() => void)[] = [];
	private timer: ReturnType<typeof setInterval> | undefined;
	private timerInterval = 0;
	private frame = 0;
	private disposed = false;
	private restorePatch: (() => void) | undefined;

	constructor(pi: ExtensionAPI, services: ThinkingServices) {
		this.pi = pi;
		this.services = services;
		this.install();
	}

	isDisposed(): boolean {
		return this.disposed;
	}

	config(): ThinkingConfig {
		return this.services?.getConfig() ?? fallbackConfig;
	}

	theme(): Theme | undefined {
		return this.services?.getTheme();
	}

	viewState(messageTimestamp: number, runStart: number): ViewState {
		const active = this.active;
		const live = !this.disposed && active?.messageTimestamp === messageTimestamp && active.runStart === runStart;
		const durationMs = live && active
			? Math.max(1, Date.now() - active.startedAt)
			: this.durations.get(durationKey(messageTimestamp, runStart));
		return { live, durationMs, frame: this.frame };
	}

	restore(entries: readonly SessionEntry[]): void {
		if (this.disposed) return;
		this.active = undefined;
		this.clearTimer();
		this.durations.clear();
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== DURATION_ENTRY_TYPE) continue;
			const data = readDurationData(entry.data);
			if (!data) continue;
			const key = durationKey(data.messageTimestamp, data.contentIndex);
			if (!this.durations.has(key) && this.durations.size >= MAX_DURATION_ENTRIES) {
				const oldest = this.durations.keys().next().value;
				if (oldest !== undefined) this.durations.delete(oldest);
			}
			this.durations.set(key, data.durationMs);
		}
		this.requestRender();
	}

	refresh(): void {
		if (this.disposed) return;
		if (this.active) this.ensureTimer(true);
		this.requestRender();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.clearTimer();
		this.active = undefined;
		this.frame = 0;
		this.durations.clear();
		for (const unsubscribe of this.unsubscribe.splice(0)) {
			try { unsubscribe(); } catch { /* Best effort during host teardown. */ }
		}
		try { this.restorePatch?.(); } catch { /* The host is already going away. */ }
		this.restorePatch = undefined;
		this.services = undefined;
		this.pi = undefined;
	}

	decorate(host: HostAssistant, nativeUpdate: UpdateContent, message: AssistantMessage, isStreaming: boolean | undefined): void {
		if (this.disposed || (host.hiddenThinkingLabel ?? "") === "") {
			nativeUpdate.call(host, message, isStreaming);
			return;
		}
		const runs = collectThinkingRuns(message.content);
		nativeUpdate.call(host, message, isStreaming);
		if (this.disposed) return;
		const container = host.contentContainer;
		if (!container || !Array.isArray(container.children)) return;
		const active = this.active?.messageTimestamp === message.timestamp ? this.active : undefined;
		const overrides = host.thinkingVisibilityOverrides;
		const padding = Math.max(0, Math.trunc(host.outputPad ?? 0));
		const label = host.hiddenThinkingLabel || "Thinking...";
		let runIndex = 0;
		for (const child of container.children) {
			if (!isHostRegion(child)) continue;
			const run = runs[runIndex];
			if (!run) break;
			const hidden = overrides?.get(runIndex) ?? host.hideThinkingBlock ?? false;
			const summary = summarizeRun(message.content, run, active?.contentIndex);
			const data: RunViewData = summary === undefined
				? { messageTimestamp: message.timestamp, start: run.start, fullText: run.fullText }
				: { messageTimestamp: message.timestamp, start: run.start, fullText: run.fullText, summary };
			child.child = new ThinkingView(data, hidden, child.child, padding, label, this);
			runIndex += 1;
		}
		if (active && !runs.some((run) => run.start === active.runStart)) {
			// The host omits empty thinking blocks, but thinking_start already starts the live run.
			const data: RunViewData = { messageTimestamp: message.timestamp, start: active.runStart, fullText: "" };
			container.children.push(
				new Spacer(1),
				new ThinkingView(data, host.hideThinkingBlock ?? false, new Container(), padding, label, this),
			);
		}
	}

	private install(): void {
		const prototype = AssistantMessageComponent.prototype as unknown as PatchablePrototype;
		const nativeUpdate = prototype.updateContent;
		const nativeSetHide = prototype.setHideThinkingBlock;
		if (typeof nativeUpdate !== "function") throw new Error("pi-ui thinking: AssistantMessageComponent.updateContent is unavailable");
		if (typeof nativeSetHide !== "function") throw new Error("pi-ui thinking: AssistantMessageComponent.setHideThinkingBlock is unavailable");
		const pi = this.pi;
		if (!pi) throw new Error("pi-ui thinking: extension API is unavailable");
		try {
			assertHostShape(new AssistantMessageComponent());
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("pi-ui thinking:")) throw error;
			throw new Error("pi-ui thinking: AssistantMessageComponent cannot be probed", { cause: error });
		}
		const controller = this;
		const updateWrapper: UpdateContent = function (message, isStreaming) {
			if (controller.isDisposed()) {
				nativeUpdate.call(this, message, isStreaming);
				return;
			}
			try {
				controller.decorate(this, nativeUpdate, message, isStreaming);
			} catch {
				nativeUpdate.call(this, message, isStreaming);
			}
		};
		const hideWrapper: SetHideThinkingBlock = function (hide) {
			if (!controller.isDisposed() && this.hideThinkingBlock === hide) return;
			nativeSetHide.call(this, hide);
		};
		try {
			prototype.updateContent = updateWrapper;
			prototype.setHideThinkingBlock = hideWrapper;
			this.restorePatch = () => {
				if (prototype.updateContent === updateWrapper) prototype.updateContent = nativeUpdate;
				if (prototype.setHideThinkingBlock === hideWrapper) prototype.setHideThinkingBlock = nativeSetHide;
			};
			this.unsubscribe.push(pi.on("message_update", (event) => this.handleMessageUpdate(event)));
			this.unsubscribe.push(pi.on("message_end", (event) => this.handleMessageEnd(event)));
			this.unsubscribe.push(pi.on("tool_execution_start", () => this.finishActive()));
			this.unsubscribe.push(pi.on("agent_settled", () => this.finishActive()));
		} catch (error) {
			for (const unsubscribe of this.unsubscribe.splice(0)) {
				try { unsubscribe(); } catch { /* Installing failed; clean up what exists. */ }
			}
			if (prototype.updateContent === updateWrapper) prototype.updateContent = nativeUpdate;
			if (prototype.setHideThinkingBlock === hideWrapper) prototype.setHideThinkingBlock = nativeSetHide;
			this.restorePatch = undefined;
			throw error;
		}
	}

	private handleMessageUpdate(event: { message: unknown; assistantMessageEvent: { type: string; contentIndex?: number } }): void {
		const message = asAssistantMessage(event.message);
		if (!message) return;
		const update = event.assistantMessageEvent;
		switch (update.type) {
			case "thinking_start":
			case "thinking_delta":
				if (typeof update.contentIndex === "number") this.startThinking(message, update.contentIndex);
				return;
			case "text_start":
			case "text_delta":
			case "text_end":
			case "toolcall_start":
			case "toolcall_delta":
				this.finishActive();
				return;
			default:
				// thinking_end closes one block; another contiguous summary may follow.
				// Text/tool/message boundaries finish the visible run instead.
				return;
		}
	}

	private handleMessageEnd(event: { message: unknown }): void {
		const message = asAssistantMessage(event.message);
		if (!message) return;
		this.finishActive();
	}

	private startThinking(message: AssistantMessage, contentIndex: number): void {
		const runStart = thinkingRunStart(message.content, contentIndex);
		if (runStart === undefined) return;
		const active = this.active;
		if (active && active.messageTimestamp === message.timestamp && active.runStart === runStart) {
			active.contentIndex = contentIndex;
			this.ensureTimer(false);
			return;
		}
		if (active) this.finishActive();
		this.frame = 0;
		this.active = { messageTimestamp: message.timestamp, runStart, contentIndex, startedAt: Date.now() };
		this.ensureTimer(true);
		this.requestRender();
	}

	private finishActive(): void {
		const active = this.active;
		if (!active) return;
		const durationMs = Math.max(1, Date.now() - active.startedAt);
		const key = durationKey(active.messageTimestamp, active.runStart);
		this.durations.delete(key);
		this.durations.set(key, durationMs);
		while (this.durations.size > MAX_DURATION_ENTRIES) {
			const oldest = this.durations.keys().next().value;
			if (oldest === undefined) break;
			this.durations.delete(oldest);
		}
		try {
			this.pi?.appendEntry(DURATION_ENTRY_TYPE, {
				messageTimestamp: active.messageTimestamp,
				contentIndex: active.runStart,
				durationMs,
			});
		} catch { /* Timing is presentation metadata; a closed session must not break the turn. */ }
		this.active = undefined;
		this.clearTimer();
		this.requestRender();
	}

	private ensureTimer(force: boolean): void {
		if (this.disposed || !this.active) return;
		const interval = Number.isFinite(this.config().animationIntervalMs)
			? Math.max(1, Math.round(this.config().animationIntervalMs))
			: 90;
		if (!force && this.timer !== undefined && this.timerInterval === interval) return;
		this.clearTimer();
		this.timerInterval = interval;
		const timer = setInterval(() => {
			if (this.disposed || !this.active) {
				this.clearTimer();
				return;
			}
			this.frame = (this.frame + 1) >>> 0;
			this.requestRender();
		}, interval);
		this.timer = timer;
		const unref = (timer as unknown as { unref?: () => void }).unref;
		if (typeof unref === "function") unref.call(timer);
	}

	private clearTimer(): void {
		if (this.timer !== undefined) clearInterval(this.timer);
		this.timer = undefined;
		this.timerInterval = 0;
	}

	private requestRender(): void {
		if (this.disposed) return;
		this.services?.requestRender();
	}
}

function thinkingRunStart(content: AssistantMessage["content"], index: number): number | undefined {
	if (!Number.isInteger(index) || index < 0 || index >= content.length) return undefined;
	if (content[index]?.type !== "thinking") return undefined;
	let start = index;
	while (start > 0 && content[start - 1]?.type === "thinking") start -= 1;
	return start;
}

function asAssistantMessage(value: unknown): AssistantMessage | undefined {
	if (!isRecord(value)) return undefined;
	if (value["role"] !== "assistant" || typeof value["timestamp"] !== "number" || !Array.isArray(value["content"])) return undefined;
	return value as unknown as AssistantMessage;
}

export interface ThinkingController {
	restore(entries: readonly SessionEntry[]): void;
	refresh(): void;
	dispose(): void;
}

export function installThinking(
	pi: ExtensionAPI,
	options: { getConfig: () => ThinkingConfig; requestRender: () => void; getTheme: () => Theme },
): ThinkingController {
	const controller = new ThinkingControllerImpl(pi, {
		getConfig: options.getConfig,
		requestRender: options.requestRender,
		getTheme: options.getTheme,
	});
	return {
		restore: (entries) => controller.restore(entries),
		refresh: () => controller.refresh(),
		dispose: () => controller.dispose(),
	};
}
