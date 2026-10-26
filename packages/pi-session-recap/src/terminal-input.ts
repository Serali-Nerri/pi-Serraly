import { matchesKey } from "@earendil-works/pi-tui";

/** Ignore wheel reports, but not keys delivered in the same terminal chunk. */
export function classifyInput(data: string, editorText: string): { activity: boolean; clear: boolean } {
	const remainder = data
		.replace(/\x1b\[<(\d+);\d+;\d+[mM]/g, (report, code: string) => {
			const button = Number(code) & ~28;
			return button >= 64 && button <= 67 ? "" : report;
		})
		.replace(/\x1b\[M([\s\S])[\s\S]{2}/g, (report, code: string) => {
			const button = (code.charCodeAt(0) - 32) & ~28;
			return button >= 64 && button <= 67 ? "" : report;
		});
	return {
		activity: remainder.length > 0,
		clear: matchesKey(remainder, "enter") && (!editorText.trim() || /^[/!]/.test(editorText.trimStart())),
	};
}
