import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { QuestionInput } from "../src/schema.ts";

/**
 * An identity theme: it returns the text unchanged instead of ANSI-colored text. Layout tests care
 * about visible text, and the real `Theme` (with its ~60 color slots) is pi's code, not ours.
 */
export function testTheme(): Theme {
	const identity = (text: string): string => text;
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: identity,
		italic: identity,
		underline: identity,
		inverse: identity,
		strikethrough: identity,
	} as unknown as Theme;
}

/** A theme that really emits ANSI codes, to check that wrapping counts visible columns. */
export function ansiTheme(): Theme {
	const theme = testTheme();
	return {
		...theme,
		fg: (_color: string, text: string) => `\u001b[31m${text}\u001b[0m`,
		bold: (text: string) => `\u001b[1m${text}\u001b[0m`,
	} as unknown as Theme;
}

/** The dialog only calls `requestRender()` and reads `terminal.rows` from its TUI. */
export function fakeTui(rows = 40): TUI {
	return { requestRender: () => {}, terminal: { rows } } as unknown as TUI;
}

/** A single-select question with two options, unless overridden. */
export function testQuestion(overrides: Partial<QuestionInput> = {}): QuestionInput {
	return {
		question: "Which database should we use?",
		header: "Database",
		multiSelect: false,
		options: [
			{ label: "SQLite (Recommended)", description: "Embedded, zero configuration." },
			{ label: "Postgres", description: "Client/server with rich types." },
		],
		...overrides,
	};
}

/**
 * Raw byte sequences as the terminal delivers them. `matchesKey()` parses real input, so tests
 * must feed the same bytes a keypress would produce instead of `Key`'s symbolic names.
 */
export const keys = {
	enter: "\r",
	escape: "\x1b",
	tab: "\t",
	space: " ",
	up: "\x1b[A",
	down: "\x1b[B",
	left: "\x1b[D",
	right: "\x1b[C",
	shiftTab: "\x1b[Z",
} as const;

/** A realistic payload: one single-select question and one multi-select question. */
export function testQuestions(): QuestionInput[] {
	return [
		testQuestion(),
		testQuestion({
			question: "Which features should we enable?",
			header: "Features",
			multiSelect: true,
			options: [
				{ label: "Dark mode", description: "Follow the OS." },
				{ label: "Telemetry", description: "Anonymous stats." },
			],
		}),
	];
}
