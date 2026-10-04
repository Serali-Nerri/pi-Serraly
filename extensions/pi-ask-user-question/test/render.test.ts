import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { padToWidth } from "pi-ui-kit";
import {
	helpText,
	htmlToText,
	looksLikeHtml,
	mergeColumns,
	pushWrapped,
	renderChoices,
	renderPreviewBox,
	renderQuestionTitle,
	renderSubmitTab,
	renderTabBar,
	markdownThemeFor,
} from "../src/render.ts";
import type { AnswerRecord } from "../src/result.ts";
import { ansiTheme, testQuestion, testTheme } from "./helpers.ts";

/** Strip ANSI colors so assertions can match visible text. */
function plain(lines: string[]): string[] {
	return lines.map((line) => stripTerminalSequences(line));
}

const theme = testTheme();
const markdownTheme = markdownThemeFor(theme);

test("padToWidth never shrinks a line and fills to the requested width", () => {
	assert.equal(visibleWidth(padToWidth("abc", 6)), 6);
	assert.equal(padToWidth("abcdef", 3), "abcdef");
});

test("pushWrapped indents continuation lines under the prefix", () => {
	const out: string[] = [];
	pushWrapped(out, "❯ ", "one two three four five", 12);
	assert.ok(out.length > 1);
	assert.match(plain(out)[0] ?? "", /^❯ one two/);
	assert.match(plain(out)[1] ?? "", /^ {2}three/);
});

test("renderChoices keeps every line inside the requested width", () => {
	const question = testQuestion();
	for (const width of [24, 40, 80]) {
		const lines = plain(renderChoices(theme, question, { cursor: 0 }, width));
		assert.ok(lines.length > 0);
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
	}
});

test("renderChoices marks the cursor, selected options and placeholders", () => {
	const question = testQuestion({ multiSelect: true });
	const record: AnswerRecord = { labels: ["Postgres"] };
	const lines = plain(renderChoices(theme, question, { cursor: 1, record }, 60));
	assert.ok(lines.some((line) => /^❯ \[x\] Postgres/.test(line)));
	assert.ok(lines.some((line) => /^ {2}\[ \] SQLite/.test(line)));
	assert.ok(lines.some((line) => line.includes("Other")));
	assert.ok(lines.some((line) => line.includes("Chat about this")));
});

test("renderChoices shows the custom answer instead of the Other placeholder", () => {
	const question = testQuestion();
	const lines = plain(renderChoices(theme, question, { cursor: 2, record: { labels: [], custom: "MariaDB" } }, 60));
	assert.ok(lines.some((line) => line.includes("Other: MariaDB")));
});

test("renderQuestionTitle uses the header or falls back to the question number", () => {
	assert.equal(plain(renderQuestionTitle(theme, testQuestion(), 0, 60))[0], " [Database] Which database should we use?");
	assert.match(plain(renderQuestionTitle(theme, testQuestion({ header: "" }), 1, 60))[0] ?? "", /^ \[Q2\]/);
});

test("renderPreviewBox renders markdown inside a fixed-width frame", () => {
	const lines = plain(renderPreviewBox(theme, markdownTheme, "```ts\nconst a = 1;\n```", 40));
	for (const line of lines) assert.equal(visibleWidth(line), 40);
	assert.match(lines[0] ?? "", /^┌─ Preview ─+┐$/);
	assert.match(lines.at(-1) ?? "", /^└─+┘$/);
	assert.ok(lines.some((line) => line.includes("const a = 1;")));
});

test("renderPreviewBox degrades HTML previews to text", () => {
	const lines = plain(renderPreviewBox(theme, markdownTheme, "<p>Hello <b>world</b></p>", 40));
	assert.ok(lines.some((line) => line.includes("Hello world")));
	assert.ok(looksLikeHtml("<div>x</div>"));
	assert.equal(htmlToText("<p>a</p><p>b</p>"), "a\nb");
});

test("mergeColumns pads the left column before the rule", () => {
	const merged = plain(mergeColumns(theme, ["left"], ["right"], 10));
	assert.equal(visibleWidth(merged[0] ?? ""), 10 + 3 + 5);
	assert.equal(merged[0], "left       │ right");
});

test("renderTabBar marks answered questions and the active tab", () => {
	const questions = [testQuestion(), testQuestion({ question: "Other?", header: "Other" })];
	const lines = plain(
		renderTabBar(theme, { questions, activeIndex: 1, answered: [true, false], allAnswered: false }, 80),
	);
	assert.equal(lines.length, 1);
	assert.match(lines[0] ?? "", /^ ← {2}✓ 1\. Database {2}│ {2}2\. Other {2}│ {2}Submit {2}→$/);
});

test("renderSubmitTab lists answers, notes and the readiness message", () => {
	const question = testQuestion();
	const records = new Map<number, AnswerRecord>([[0, { labels: ["Postgres"], notes: "for JSONB" }]]);
	const lines = plain(renderSubmitTab(theme, { questions: [question], records, allAnswered: true }, 70));
	assert.ok(lines.some((line) => line.includes("Review your answers")));
	assert.ok(lines.some((line) => line.includes("Database: Postgres")));
	assert.ok(lines.some((line) => line.includes("notes: for JSONB")));
	assert.ok(lines.some((line) => line.includes("Ready to submit your answers?")));
});

test("renderSubmitTab reports missing answers", () => {
	const question = testQuestion();
	const lines = plain(renderSubmitTab(theme, { questions: [question], records: new Map(), allAnswered: false }, 70));
	assert.ok(lines.some((line) => line.includes("You have not answered all questions.")));
	assert.ok(lines.some((line) => line.includes("(unanswered)")));
});

test("helpText follows the mode", () => {
	assert.equal(helpText({ mode: "options", onSubmitTab: false, multiSelect: false }), "↑↓ move • Enter confirm • n notes • Tab switch • Esc cancel");
	assert.match(helpText({ mode: "options", onSubmitTab: false, multiSelect: true }), /^Space toggle/);
	assert.match(helpText({ mode: "options", onSubmitTab: true, multiSelect: false }), /^Enter submit/);
	assert.equal(helpText({ mode: "notes", onSubmitTab: false, multiSelect: false }), "Enter submit • Esc back");
});

test("ANSI colored text still wraps by visible width", () => {
	const colored = ansiTheme();
	const out: string[] = [];
	pushWrapped(out, "❯ ", colored.fg("text", "alpha beta gamma delta"), 12);
	for (const line of out) assert.ok(visibleWidth(line) <= 12, `${visibleWidth(line)}: ${line}`);
	assert.match(stripTerminalSequences(out[1] ?? ""), /^ {2}/);
});
