// Adapted from pi-cc-extensions v0.8.69; see THIRD_PARTY_NOTICES.md.
// Includes pi-compact-thinking (MIT), copyright (c) 2026 Tifan Dwi Avianto.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { installThinkingPatch, type ThinkingPatch, type ThinkingRun } from "../compat/thinking.ts";
import type { UiScheduler } from "../scheduler.ts";
import { animateCompactThinkingText, formatThoughtDuration, styleCompactThinkingText } from "../compat/compact-mode.ts";
import { refreshMountedTranscript } from "../compat/transcript-refresh.ts";
import { COMPACT_THINKING_OWNER, patchRegistry } from "../compat/patch-keys.ts";
import { clearThinkingExpansion, DURATION_ENTRY_TYPE, restoreDurationEntries, setThinkingPreviewConfig, ThinkingPreviewBlock, thinkingRunSummary, type DurationEntryData } from "../transcript/thinking.ts";

export { clearThinkingPreviewCache, thinkingPreviewCacheSize, thinkingExpandedWrapCacheSize, THINKING_PREVIEW_CACHE_MAX, THINKING_EXPANDED_WRAP_CACHE_MAX, ThinkingPreviewBlock } from "../transcript/thinking.ts";

export type CompactThinkingConfig = {
	useSummaryTitlesAsThinkingTitle: boolean;
	previewLines: number;
	animationIntervalMs: number;
};
export type CompactThinkingServices = {
	/** Lifecycle-owned LOCAL router, not the Pi ExtensionAPI itself. */
	events: Pick<ExtensionAPI, "on">;
	scheduler: UiScheduler;
	getTui: () => TUI | undefined;
};
export type CompactThinkingController = {
	updateConfig(next: CompactThinkingConfig): void;
	onBeforeShutdown(handler: () => void): void;
	getMessageThinkingDurationMs(messageTimestamp: number): number | undefined;
	isMessageThinkingActive(messageTimestamp: number): boolean;
	getThinkingAnimationFrame(): number;
	setCompactSummaryActive(active: boolean): void;
	dispose(): void;
};

type ActiveThinking = { messageTimestamp: number; contentIndex: number; startedAt: number };
type ThinkingOwner = { stop(): void };
/** Owned-slot shape: only a branded thinking owner is stopped or handed over. */
const isThinkingOwner = (value: unknown): value is ThinkingOwner =>
	typeof value === "object" && value !== null && typeof (value as ThinkingOwner).stop === "function";
let nextControllerId = 0;

/** No host subscriptions, patches or timers until a routed TUI session_start. */
export function installCompactThinking(
	persistence: Pick<ExtensionAPI, "appendEntry">,
	initialConfig: CompactThinkingConfig,
	{ events, scheduler, getTui }: CompactThinkingServices,
): CompactThinkingController {
	let config = { ...initialConfig };
	let theme: Theme | undefined;
	let active = false;
	let disposed = false;
	let thinking: ActiveThinking | undefined;
	let frame = 0;
	let summaryActive = false;
	let scheduled = false;
	let patch: ThinkingPatch | undefined;
	let beforeShutdown: (() => void) | undefined;
	const durations = new Map<number, Map<number, number>>();
	const jobKey = `thinking:${++nextControllerId}`;
	const owner: ThinkingOwner = { stop };

	const isActive = (timestamp: number) => thinking?.messageTimestamp === timestamp;
	const isActiveRun = (timestamp: number, start: number, end: number) =>
		isActive(timestamp) && thinking!.contentIndex >= start && thinking!.contentIndex <= end;
	const style = (text: string) => styleCompactThinkingText(text, theme);

	function preview(message: AssistantMessage, run: ThinkingRun): ThinkingPreviewBlock {
		const live = isActiveRun(message.timestamp, run.start, run.end);
		const { text, summary } = thinkingRunSummary(message, run.start, run.end,
			isActive(message.timestamp) ? thinking?.contentIndex : undefined, config.useSummaryTitlesAsThinkingTitle);
		let durationMs = live ? Math.max(1, Date.now() - thinking!.startedAt) : undefined;
		if (!live) {
			for (let index = run.end; index >= run.start; index--) {
				durationMs = durations.get(message.timestamp)?.get(index);
				if (durationMs !== undefined) break;
			}
		}
		const duration = durationMs === undefined ? undefined : formatThoughtDuration(durationMs);
		const heading = live
			? animateCompactThinkingText(summary?.title ?? (run.hiddenLabel || "Thinking..."), theme, frame, Boolean(summary)) + (duration ? style(` · ${duration}`) : "")
			: style(duration ? `Thought for ${duration}` : summary?.title ?? "Thought");
		return new ThinkingPreviewBlock(heading, text, run.padding, message.timestamp, style, theme, run.start);
	}

	function ensureAnimation(): void {
		if (!active || scheduled || (!thinking && !summaryActive)) return;
		scheduled = true;
		scheduler.schedule(jobKey, config.animationIntervalMs, () => {
			frame++;
			patch?.refreshActive();
			scheduler.request();
		}, true);
	}
	function cancelAnimation(): void {
		scheduler.cancel(jobKey);
		scheduled = false;
	}
	/** Consume the live run without calling mounted components or requesting render. */
	function finalizeDuration(): void {
		if (!thinking) return;
		const completedThinking = thinking;
		thinking = undefined;
		const data: DurationEntryData = {
			messageTimestamp: completedThinking.messageTimestamp,
			contentIndex: completedThinking.contentIndex,
			durationMs: Math.max(1, Date.now() - completedThinking.startedAt),
		};
		let completed = durations.get(data.messageTimestamp);
		if (!completed) durations.set(data.messageTimestamp, completed = new Map());
		completed.set(data.contentIndex, data.durationMs);
		// Shutdown/session replacement can invalidate persistence before display
		// resources finish releasing. Never let a failed append retain patches.
		try { persistence.appendEntry(DURATION_ENTRY_TYPE, data); } catch { /* In-memory duration remains available until stop. */ }
	}
	function finish(): void {
		if (!thinking) return;
		try {
			finalizeDuration();
			patch?.refreshActive();
		} finally {
			if (!summaryActive) cancelAnimation();
			patch?.clearActive();
		}
		scheduler.request();
	}
	function start(message: AssistantMessage, contentIndex: number): void {
		if (thinking && thinking.messageTimestamp !== message.timestamp) finish();
		if (thinking) {
			thinking.contentIndex = contentIndex;
			return;
		}
		thinking = { messageTimestamp: message.timestamp, contentIndex, startedAt: Date.now() };
		frame = 0;
		patch?.clearActive();
		patch?.refreshActive(message);
		cancelAnimation();
		ensureAnimation();
		scheduler.request();
	}
	function restore(ctx: ExtensionContext): void {
		// Display durations belong to full history, not context or the active branch.
		restoreDurationEntries(ctx.sessionManager.getEntries(), durations);
		refreshMountedTranscript(getTui());
		scheduler.request(true);
	}
	function stop(): void {
		if (!active) return;
		active = false;
		summaryActive = false;
		try {
			beforeShutdown?.(); // outer compact render patch must be removed first
		} finally {
			try {
				// Shutdown must never re-enter a foreign updateContent/render wrapper.
				finalizeDuration();
			} finally {
				try {
					cancelAnimation();
				} finally {
					const ownedPatch = patch;
					patch = undefined;
					theme = undefined;
					durations.clear();
					try {
						ownedPatch?.dispose();
					} finally {
						try { clearThinkingExpansion(); }
						finally { patchRegistry.dispose(COMPACT_THINKING_OWNER, owner); }
					}
				}
			}
		}
	}

	const subscriptions = [
		events.on("session_start", (_event, ctx) => {
			if (disposed || ctx.mode !== "tui" || !ctx.hasUI) return;
			patchRegistry.getOwned(COMPACT_THINKING_OWNER, isThinkingOwner)?.stop();
			active = true;
			theme = ctx.ui.theme;
			setThinkingPreviewConfig(config);
			patch = installThinkingPatch({ isActive, isActiveRun, preview });
			patchRegistry.installOwned(COMPACT_THINKING_OWNER, owner);
			restore(ctx);
		}),
		events.on("message_update", (event) => {
			if (!active || event.message.role !== "assistant") return;
			const update = event.assistantMessageEvent;
			if (update.type === "thinking_start" || update.type === "thinking_delta") start(event.message, update.contentIndex);
			else if (update.type === "text_start" || update.type === "toolcall_start" || update.type === "toolcall_delta") finish();
			// thinking_end may be followed immediately by another Responses summary;
			// text/tool/message boundaries end the contiguous visible run instead.
		}),
		events.on("message_end", (event) => { if (active && event.message.role === "assistant") finish(); }),
		events.on("tool_execution_start", () => { if (active) finish(); }),
		events.on("session_tree", (_event, ctx) => { if (active) restore(ctx); }),
		events.on("session_compact", (_event, ctx) => { if (active) restore(ctx); }),
		events.on("session_shutdown", () => stop()),
	];

	return {
		onBeforeShutdown(handler) { beforeShutdown = handler; },
		updateConfig(next) {
			config = { ...next };
			if (active || !patchRegistry.get(COMPACT_THINKING_OWNER)) setThinkingPreviewConfig(config);
			if (active) {
				cancelAnimation();
				ensureAnimation();
				refreshMountedTranscript(getTui());
				scheduler.request(true);
			}
		},
		getMessageThinkingDurationMs(timestamp) {
			let total = 0;
			for (const duration of durations.get(timestamp)?.values() ?? []) total += duration;
			if (isActive(timestamp)) total += Math.max(1, Date.now() - thinking!.startedAt);
			return total > 0 ? total : undefined;
		},
		isMessageThinkingActive: isActive,
		getThinkingAnimationFrame: () => frame,
		setCompactSummaryActive(next) {
			if (!active) return;
			summaryActive = next;
			if (next) ensureAnimation();
			else if (!thinking) cancelAnimation();
			scheduler.request();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			try { stop(); }
			finally {
				beforeShutdown = undefined;
				for (const unsubscribe of subscriptions) unsubscribe();
			}
		},
	};
}
