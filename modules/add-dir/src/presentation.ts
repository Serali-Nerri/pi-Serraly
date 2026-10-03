import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ScopedDir } from "./directories.ts";

export const WIDGET_KEY = "add-dir";
export const PENDING_MESSAGE = "External skills changed. Run /reload to update them.";

export type NoticeLevel = "info" | "warning" | "error";

const DISPLAY_UNSAFE_SOURCE = "[\\p{Cc}\\u2028\\u2029\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]";
const DISPLAY_UNSAFE = new RegExp(DISPLAY_UNSAFE_SOURCE, "u");
const DISPLAY_UNSAFE_EVERYWHERE = new RegExp(DISPLAY_UNSAFE_SOURCE, "gu");

/**
 * The characters `sanitize` escapes: terminal controls, line separators and the invisible bidi
 * overrides that reorder a rendered line. Rendering sites that cannot escape must refuse them.
 */
export function hasUnsafeDisplayCharacters(text: string): boolean {
	return DISPLAY_UNSAFE.test(text);
}

/**
 * Nothing untrusted may reach the terminal unescaped: directory names, stored paths and
 * filesystem diagnostics can contain escape sequences. Shaped names — joined emoji, combining
 * marks, private-use glyphs — are untouched.
 */
export function sanitize(text: string): string {
	return text.replace(
		DISPLAY_UNSAFE_EVERYWHERE,
		(character) => `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
	);
}

/**
 * Non-UI modes have no notification channel; diagnostics go to stderr and the print/RPC
 * protocols stay clean.
 */
export function notify(ctx: ExtensionContext, message: string, level: NoticeLevel = "info"): void {
	const safe = sanitize(message);
	if (ctx.hasUI) ctx.ui.notify(safe, level);
	else if (level !== "info") console.error(`pi-add-dir: ${safe.slice(0, 1_000)}`);
}

export function warn(ctx: ExtensionContext, message: string): void {
	notify(ctx, message, "warning");
}

export function reportList(lines: readonly string[]): void {
	for (const line of lines) console.error(`pi-add-dir: ${sanitize(line).slice(0, 1_000)}`);
}

export function directoryChoices(dirs: readonly ScopedDir[]): string[] {
	const rendered = dirs.map((dir) =>
		sanitize(
			`[${dir.source}] ${dir.label} - ${dir.storedPath}${dir.inactiveReason ? ` (inactive: ${dir.inactiveReason})` : ""}`,
		),
	);
	// The host returns the selected string. Every row needs a distinct final suffix: escaping
	// can collide, and an unsuffixed path can itself end with another row's ordinal.
	return rendered.map((choice, index) => `${choice} [${index + 1}]`);
}

export function updateWidget(ctx: ExtensionContext, dirs: readonly ScopedDir[], pending: boolean): void {
	if (ctx.mode !== "tui" || !ctx.hasUI) return;
	if (dirs.length === 0) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}

	ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
		dispose() {},
		invalidate() {},
		render(width: number): string[] {
			const renderWidth = Math.max(1, width);
			const prefix = theme.fg("accent", "📂");
			const count = theme.fg("muted", ` ${dirs.length} external dir${dirs.length === 1 ? "" : "s"}`);
			const separator = theme.fg("dim", " | ");
			const suffix = theme.fg("dim", `${pending ? "  (/reload pending)" : ""}  (/dir-ls to manage)`);
			const labels = dirs.map((dir) => theme.fg("text", sanitize(dir.label))).join(theme.fg("dim", ", "));
			const fullLine = ` ${prefix}${count}${separator}${labels}${suffix}`;

			if (visibleWidth(fullLine) <= renderWidth) return [fullLine];
			const withoutLabels = ` ${prefix}${count}${separator}`;
			const available = renderWidth - visibleWidth(withoutLabels) - visibleWidth(suffix);
			if (available > 5) return [`${withoutLabels}${truncateToWidth(labels, available, "…")}${suffix}`];
			return [truncateToWidth(` ${prefix}${count}`, renderWidth, "…")];
		},
	}));
}
