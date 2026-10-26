import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { Recap } from "./prompt.ts";

function boundedLines(text: string, width: number, limit: number): string[] {
	const lines = wrapTextWithAnsi(text, width);
	if (lines.length <= limit) return lines;
	const kept = lines.slice(0, limit);
	kept[limit - 1] = truncateToWidth(`${kept[limit - 1]}…`, width, "…");
	return kept;
}

/** Recompute on render so both terminal width and live theme changes apply. */
export function recapWidget(recap: Recap, getTheme: () => Theme): Component {
	const summary = stripTerminalSequences(recap.summary).replace(/\s+/gu, " ");
	const next = recap.next_action && stripTerminalSequences(recap.next_action).replace(/\s+/gu, " ");
	return {
		render(width) {
			const columns = Math.max(0, Math.floor(width));
			if (!columns) return [];
			const theme = getTheme();
			const nextLines = next ? boundedLines(`${theme.bold("Next:")} ${next}`, columns, 3) : [];
			return [
				...boundedLines(`Recap: ${summary}`, columns, 10 - nextLines.length)
					.map(line => theme.style(line, { fg: "dim", italic: true })),
				...nextLines,
			];
		},
		invalidate() {},
	};
}
