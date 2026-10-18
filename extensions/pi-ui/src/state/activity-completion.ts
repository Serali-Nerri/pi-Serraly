import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatDuration } from "../utils/format.ts";

type ActivityCompletion = { durationMs: number; completedAt: number };
const ENTRY_TYPE = "pi-ui-activity-completion";

function endTime(timestamp: number): string {
	const end = new Date(timestamp);
	const pad = (value: number) => String(value).padStart(2, "0");
	const time = `${pad(end.getHours())}:${pad(end.getMinutes())}:${pad(end.getSeconds())}`;
	const date = (value: Date) => `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
	return date(end) === date(new Date()) ? time : `${date(end)} ${time}`;
}

/** A completed activity is display-only session data, never assistant content. */
export function installActivityCompletion(pi: ExtensionAPI, events: Pick<ExtensionAPI, "on">): { reset(): void } {
	let startedAt: number | undefined;
	let pausedAt: number | undefined;
	let pausedMs = 0;
	let prompts = 0;
	const reset = () => { startedAt = pausedAt = undefined; pausedMs = prompts = 0; };

	pi.registerEntryRenderer<ActivityCompletion>(ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		if (!data || !Number.isFinite(data.durationMs) || data.durationMs < 0 ||
			!Number.isFinite(data.completedAt) || !Number.isFinite(new Date(data.completedAt).getTime())) return;
		return {
			render: (width) => [theme.fg("dim", truncateToWidth(
				`${formatDuration(data.durationMs) || "<1s"} · ${endTime(data.completedAt)}`,
				width, "…",
			))],
			invalidate() {},
		};
	});
	events.on("agent_start", () => { startedAt ??= Date.now(); });
	events.on("ui_prompt_start", () => {
		if (startedAt !== undefined && prompts++ === 0) pausedAt = Date.now();
	});
	events.on("ui_prompt_end", () => {
		if (prompts > 0 && --prompts === 0) {
			pausedMs += Math.max(0, Date.now() - pausedAt!);
			pausedAt = undefined;
		}
	});
	events.on("agent_settled", () => {
		if (startedAt === undefined) return;
		const completedAt = Date.now();
		const durationMs = Math.max(0, (pausedAt ?? completedAt) - startedAt - pausedMs);
		reset();
		pi.appendEntry<ActivityCompletion>(ENTRY_TYPE, { durationMs, completedAt });
	});
	events.on("session_tree", reset);
	return { reset };
}
