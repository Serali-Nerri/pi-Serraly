import type { Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { choicesFor } from "./choices.ts";
import { CHAT_LABEL, MAX_HEADER, NOTES_ONLY, OTHER_LABEL } from "./config.ts";
import type { AnswerRecord } from "./result.ts";
import { formatAnswer } from "./result.ts";
import type { QuestionInput } from "./schema.ts";

// ---------------------------------------------------------------------------
// Layout helpers (pure: they only need a theme for coloring)
// ---------------------------------------------------------------------------

export function padToWidth(line: string, width: number): string {
	const current = visibleWidth(line);
	return current >= width ? line : line + " ".repeat(width - current);
}

export function looksLikeHtml(text: string): boolean {
	return /<\s*(html|body|div|span|table|thead|tbody|tr|td|th|pre|code|p|h[1-6]|ul|ol|li|br|hr|strong|em|b|i|u|img|svg|section|article|header|footer|style|script)\b/i.test(
		text,
	);
}

/** HTML previews cannot be rendered in a terminal; degrade to readable text. */
export function htmlToText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|li|h[1-6]|tr|table|section|article|header|footer)>/gi, "\n")
		.replace(/<li[^>]*>/gi, "- ")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function markdownThemeFor(theme: Theme): MarkdownTheme {
	return {
		heading: (text) => theme.fg("accent", theme.bold(text)),
		link: (text) => theme.fg("accent", text),
		linkUrl: (text) => theme.fg("dim", text),
		code: (text) => theme.fg("muted", text),
		codeBlock: (text) => theme.fg("text", text),
		codeBlockBorder: (text) => theme.fg("dim", text),
		quote: (text) => theme.fg("muted", text),
		quoteBorder: (text) => theme.fg("dim", text),
		hr: (text) => theme.fg("dim", text),
		listBullet: (text) => theme.fg("accent", text),
		bold: (text) => theme.bold(text),
		italic: (text) => theme.italic(text),
		strikethrough: (text) => theme.strikethrough(text),
		underline: (text) => theme.underline(text),
	};
}

// ---------------------------------------------------------------------------
// View builders: they turn questions, answers and cursor state into lines. They
// are pure so the layout can be tested without a terminal (see test/render.test.ts).
// ---------------------------------------------------------------------------

/** Wrap `text` to `width`, indenting continuation lines so the prefix stays aligned. */
export function pushWrapped(out: string[], prefix: string, text: string, width: number): void {
	const prefixWidth = visibleWidth(prefix);
	const available = Math.max(1, width - prefixWidth);
	const wrapped = wrapTextWithAnsi(text, available);
	const continuation = " ".repeat(prefixWidth);
	wrapped.forEach((line, index) => out.push((index === 0 ? prefix : continuation) + line));
}

/** The `[Header] Question` headline of a question. */
export function renderQuestionTitle(theme: Theme, question: QuestionInput, index: number, width: number): string[] {
	const out: string[] = [];
	const header = question.header || `Q${index + 1}`;
	pushWrapped(out, " ", `${theme.fg("accent", theme.bold(`[${header}]`))} ${theme.fg("text", question.question)}`, width);
	return out;
}

/**
 * The option list of one question: its own options, then `Other` and `Chat about this`.
 * Selected labels, a custom answer and notes all come from `record`.
 */
export function renderChoices(
	theme: Theme,
	question: QuestionInput,
	state: { cursor: number; record?: AnswerRecord },
	width: number,
): string[] {
	const out: string[] = [];
	const multi = question.multiSelect === true;
	const existing = state.record;
	choicesFor(question).forEach((choice, index) => {
		const selected = index === state.cursor;
		const pointer = selected ? theme.fg("accent", "❯ ") : "  ";
		let text: string;
		let checked = false;
		let isPlaceholder = false;
		if (choice.kind === "option") {
			text = choice.option.label;
			checked = existing?.labels.includes(choice.option.label) ?? false;
		} else if (choice.kind === "other") {
			checked = existing?.custom !== undefined;
			isPlaceholder = !checked;
			text = checked ? `${OTHER_LABEL}: ${existing?.custom ?? ""}` : OTHER_LABEL;
		} else {
			isPlaceholder = true;
			text = CHAT_LABEL;
		}
		const checkbox = multi ? (checked ? theme.fg("success", "[x] ") : theme.fg("dim", "[ ] ")) : "";
		const color = selected || checked ? "accent" : isPlaceholder ? "muted" : "text";
		pushWrapped(out, pointer + checkbox, theme.fg(color, text), width);
		const indent = " ".repeat(visibleWidth(pointer + checkbox));
		if (choice.kind === "option" && choice.option.description) {
			pushWrapped(out, indent, theme.fg("muted", choice.option.description), width);
		} else if (choice.kind === "other") {
			pushWrapped(out, indent, theme.fg("dim", "Type something."), width);
		} else if (choice.kind === "chat") {
			pushWrapped(out, indent, theme.fg("dim", "Reply in your own words instead of picking an option."), width);
		}
	});
	return out;
}

/** A bordered markdown panel used for option previews (HTML previews are degraded to text). */
export function renderPreviewBox(theme: Theme, markdownTheme: MarkdownTheme, preview: string, width: number): string[] {
	const source = looksLikeHtml(preview) ? htmlToText(preview) : preview;
	const inner = Math.max(1, width - 4);
	const markdown = new Markdown(source, 0, 0, markdownTheme);
	const body = markdown.render(inner);
	const title = " Preview ";
	const topDashes = Math.max(0, width - title.length - 3);
	const lines = [theme.fg("borderMuted", `┌─${title}${"─".repeat(topDashes)}┐`)];
	for (const line of body) {
		for (const wrapped of wrapTextWithAnsi(line, inner)) {
			lines.push(theme.fg("borderMuted", "│ ") + padToWidth(wrapped, inner) + theme.fg("borderMuted", " │"));
		}
	}
	lines.push(theme.fg("borderMuted", `└${"─".repeat(Math.max(0, width - 2))}┘`));
	return lines;
}

/** Place two column blocks next to each other, separated by a vertical rule. */
export function mergeColumns(theme: Theme, left: string[], right: string[], leftWidth: number): string[] {
	const rows = Math.max(left.length, right.length);
	const merged: string[] = [];
	for (let index = 0; index < rows; index += 1) {
		const leftLine = padToWidth(left[index] ?? "", leftWidth);
		merged.push(`${leftLine}${theme.fg("borderMuted", " │ ")}${right[index] ?? ""}`);
	}
	return merged;
}

/**
 * The tab bar shown when a call carries more than one question. `activeIndex` equal to the number
 * of questions selects the trailing `Submit` tab.
 */
export function renderTabBar(
	theme: Theme,
	state: { questions: QuestionInput[]; activeIndex: number; answered: boolean[]; allAnswered: boolean },
	width: number,
): string[] {
	const tabs: string[] = [];
	state.questions.forEach((entry, index) => {
		const active = index === state.activeIndex;
		const header = truncateToWidth(entry.header || `Q${index + 1}`, MAX_HEADER, "…");
		const text = ` ${state.answered[index] ? "✓ " : ""}${index + 1}. ${header} `;
		tabs.push(
			active ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(state.answered[index] ? "success" : "muted", text),
		);
	});
	const submitActive = state.activeIndex === state.questions.length;
	const submitText = ` ${state.allAnswered ? "✓ " : ""}Submit `;
	tabs.push(
		submitActive
			? theme.bg("selectedBg", theme.fg("text", submitText))
			: theme.fg(state.allAnswered ? "success" : "dim", submitText),
	);
	const out: string[] = [];
	pushWrapped(out, " ", `${theme.fg("dim", "← ")}${tabs.join(theme.fg("dim", " │ "))}${theme.fg("dim", " →")}`, width);
	return out;
}

/** The review tab: every question with the answer that would be submitted. */
export function renderSubmitTab(
	theme: Theme,
	state: { questions: QuestionInput[]; records: Map<number, AnswerRecord>; allAnswered: boolean },
	width: number,
): string[] {
	const out: string[] = [];
	pushWrapped(out, " ", theme.fg("accent", theme.bold("Review your answers")), width);
	out.push("");
	for (const [index, question] of state.questions.entries()) {
		const existing = state.records.get(index);
		const header = question.header || `Q${index + 1}`;
		const answer = existing ? formatAnswer(existing, question.multiSelect === true) : "";
		const display = answer === NOTES_ONLY ? theme.fg("dim", "(notes only)") : theme.fg("text", answer || "(unanswered)");
		pushWrapped(out, " ", `${theme.fg("muted", `${header}: `)}${display}`, width);
		if (existing?.notes) {
			pushWrapped(out, "   ", theme.fg("dim", `notes: ${existing.notes}`), width);
		}
	}
	out.push("");
	if (state.allAnswered) {
		pushWrapped(out, " ", theme.fg("success", "Ready to submit your answers?"), width);
	} else {
		pushWrapped(out, " ", theme.fg("warning", "You have not answered all questions."), width);
	}
	return out;
}

/** Key hints for the footer, mirroring the keys handled in `dialog.ts`. */
export function helpText(state: { mode: "options" | "other" | "chat" | "notes"; onSubmitTab: boolean; multiSelect: boolean }): string {
	if (state.mode !== "options") return "Enter submit • Esc back";
	if (state.onSubmitTab) return "Enter submit • Tab switch questions • Esc cancel";
	return state.multiSelect
		? "Space toggle • ↑↓ move • Enter confirm • n notes • Tab switch • Esc cancel"
		: "↑↓ move • Enter confirm • n notes • Tab switch • Esc cancel";
}
