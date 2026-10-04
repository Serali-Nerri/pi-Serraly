import { truncateToWidth } from "@earendil-works/pi-tui";

/** The semantic state of a tool card; it selects the theme role, never the text. */
export type ToolCardState = "running" | "success" | "error" | "cancelled" | "neutral";

/** Theme roles the shared card syntax uses. Pi's `Theme` satisfies this shape. */
export type ToolCardColor = "toolTitle" | "muted" | "dim" | "accent" | "success" | "error" | "warning";

/** The public slice of Pi's theme that card rendering needs. */
export interface ToolCardTheme {
	fg(color: ToolCardColor, text: string): string;
	bold(text: string): string;
}

export interface ToolCardHeader {
	title: string;
	/** Absent or `undefined` both render no summary. */
	summary?: string | undefined;
	state?: ToolCardState;
	/**
	 * The leading glyph. The owning renderer passes its own animation frame here;
	 * the library never runs a timer and never caches a frame.
	 */
	glyph?: string | undefined;
}

export interface ToolCardStatus {
	state: ToolCardState;
	message: string;
	/**
	 * The owner already sanitized and coloured this message, for example a
	 * multi-colour statistics line. The library then only adds the branch and
	 * never rewrites the message.
	 */
	styled?: boolean;
}

const HEADER_DOT = "●";
const STATUS_BRANCH = "⎿ ";
const STATUS_INDENT = "  ";
const ELLIPSIS = "…";

const DOT_COLOR: Record<ToolCardState, ToolCardColor> = {
	running: "accent",
	success: "success",
	error: "error",
	cancelled: "warning",
	neutral: "dim",
};

const STATUS_COLOR: Record<ToolCardState, ToolCardColor> = {
	running: "accent",
	success: "success",
	error: "error",
	cancelled: "warning",
	neutral: "muted",
};

const CONTROL_SEQUENCES = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/**
 * Collapse arbitrary text into one plain line before it is coloured.
 *
 * Terminal control sequences and control characters are removed and whitespace is
 * folded, so a title can never move the cursor, clear the screen or break the card
 * layout. Body text keeps its own module's sanitizer; this is only the card chrome.
 */
function plainText(value: string): string {
	return value.replace(CONTROL_SEQUENCES, "").replace(CONTROL_CHARACTERS, "").replace(/\s+/g, " ").trim();
}

/**
 * The header text `● title summary`, coloured through semantic theme roles.
 *
 * The dot carries the state colour; the title uses `toolTitle` and the summary
 * `muted`. Callers that own line wrapping use this builder; `renderToolHeader`
 * adds the width contract.
 */
export function toolHeaderText(theme: ToolCardTheme, value: ToolCardHeader): string {
	const state = value.state ?? "neutral";
	const title = plainText(value.title);
	const summary = value.summary === undefined ? "" : plainText(value.summary);
	const glyph = value.glyph === undefined ? HEADER_DOT : plainText(value.glyph) || HEADER_DOT;
	let line = `${theme.fg(DOT_COLOR[state], glyph)} ${theme.bold(theme.fg("toolTitle", title))}`;
	if (summary) line += ` ${theme.fg("muted", summary)}`;
	return line;
}

/**
 * The result status text `  ⎿ message`.
 *
 * The message colour is the state role and the branch is `dim`, so the state is
 * readable from the text as well as the colour. Callers that own line wrapping
 * use this builder; `renderToolStatus` adds the width contract.
 */
export function toolStatusText(theme: ToolCardTheme, value: ToolCardStatus): string {
	const message = value.styled ? value.message : plainText(value.message);
	return `${STATUS_INDENT}${theme.fg("dim", STATUS_BRANCH)}${theme.fg(STATUS_COLOR[value.state], message)}`;
}

/**
 * One header line, truncated to `width` visible columns; an empty array is
 * returned for a non-positive width.
 */
export function renderToolHeader(theme: ToolCardTheme, value: ToolCardHeader, width: number): string[] {
	if (width <= 0) return [];
	return [truncateToWidth(toolHeaderText(theme, value), width, ELLIPSIS)];
}

/**
 * One status line, truncated to `width` visible columns; an empty array is
 * returned for a non-positive width.
 */
export function renderToolStatus(theme: ToolCardTheme, value: ToolCardStatus, width: number): string[] {
	if (width <= 0) return [];
	return [truncateToWidth(toolStatusText(theme, value), width, ELLIPSIS)];
}
