// Adapted from pi-Serraly c3e3585 state/activity-completion.ts; see UPSTREAM.md.
import type { EntryRenderer, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type ActivityCompletion = { durationMs: number; completedAt: number };
const ENTRY_TYPE = "pi-ui-activity-completion";

function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1_000);
	if (seconds < 1) return "<1s";
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`;
}

function endTime(timestamp: number): string {
	const end = new Date(timestamp);
	const pad = (value: number) => String(value).padStart(2, "0");
	const time = `${pad(end.getHours())}:${pad(end.getMinutes())}:${pad(end.getSeconds())}`;
	const date = (value: Date) => `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
	return date(end) === date(new Date()) ? time : `${date(end)} ${time}`;
}

const renderCompletion: EntryRenderer<ActivityCompletion> = (entry, _options, theme) => {
	const data = entry.data;
	if (!data || !Number.isFinite(data.durationMs) || data.durationMs < 0
		|| !Number.isFinite(data.completedAt) || !Number.isFinite(new Date(data.completedAt).getTime())) return;
	return {
		render(width) {
			const columns = Math.max(0, Math.floor(width));
			if (columns === 0) return [];
			const line = truncateToWidth(`Worked for ${formatDuration(data.durationMs)} · ${endTime(data.completedAt)}`, columns, "…");
			return [" ".repeat(Math.max(0, columns - visibleWidth(line))) + theme.fg("dim", line)];
		},
		invalidate() {},
	};
};

/** Register the stateless renderer once; subscribe only during a TUI session. */
export function registerActivityCompletion(pi: ExtensionAPI): { start(): void; stop(): void } {
	pi.registerEntryRenderer(ENTRY_TYPE, renderCompletion);
	const subscriptions: Array<() => void> = [];
	let startedAt: number | undefined;
	let pausedAt: number | undefined;
	let pausedMs = 0;
	let prompts = 0;
	const reset = (): void => { startedAt = pausedAt = undefined; pausedMs = prompts = 0; };
	const stop = (): void => {
		reset();
		for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
	};
	return {
		start() {
			stop();
			subscriptions.push(pi.on("session_tree", reset));
			subscriptions.push(pi.on("agent_start", () => { startedAt ??= Date.now(); }));
			subscriptions.push(pi.on("ui_prompt_start", () => {
				if (startedAt !== undefined && prompts++ === 0) pausedAt = Date.now();
			}));
			subscriptions.push(pi.on("ui_prompt_end", () => {
				if (prompts > 0 && --prompts === 0) {
					pausedMs += Math.max(0, Date.now() - pausedAt!);
					pausedAt = undefined;
				}
			}));
			subscriptions.push(pi.on("agent_settled", () => {
				if (startedAt === undefined) return;
				const completedAt = Date.now();
				const durationMs = Math.max(0, (pausedAt ?? completedAt) - startedAt - pausedMs);
				reset();
				pi.appendEntry<ActivityCompletion>(ENTRY_TYPE, { durationMs, completedAt });
			}));
		},
		stop,
	};
}
