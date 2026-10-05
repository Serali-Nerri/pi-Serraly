import assert from "node:assert/strict";
import { test } from "node:test";
import { NOTES_ONLY } from "../src/config.ts";
import {
	buildAnswerSummary,
	buildToolResultText,
	formatAnswer,
	formatLabels,
	isCleanlyAnswered,
	type AnswerRecord,
	type DialogOutcome,
} from "../src/result.ts";
import { testQuestion } from "./helpers.ts";

function record(overrides: Partial<AnswerRecord> = {}): AnswerRecord {
	return { labels: [], ...overrides };
}

function submitted(overrides: Partial<Extract<DialogOutcome, { kind: "submitted" }>> = {}) {
	return {
		kind: "submitted" as const,
		records: [record({ labels: ["SQLite (Recommended)"] })],
		answers: { "Which database should we use?": "SQLite (Recommended)" },
		...overrides,
	};
}

test("formatLabels quotes labels containing a comma or quote", () => {
	assert.equal(formatLabels(["a", "b"]), "a, b");
	assert.equal(formatLabels(["a, b"]), '"a, b"');
	assert.equal(formatLabels(['say "hi"']), '"say \\"hi\\""');
});

test("formatAnswer follows the documented precedence", () => {
	assert.equal(formatAnswer(record({ labels: ["a", "b"] }), true), "a, b");
	assert.equal(formatAnswer(record({ labels: ["a", "b"] }), false), "a");
	assert.equal(formatAnswer(record({ labels: ["a"], custom: "custom" }), false), "custom");
	assert.equal(formatAnswer(record({ notes: "only notes" }), false), NOTES_ONLY);
	assert.equal(formatAnswer(record(), false), "");
});

test("buildAnswerSummary annotates previews and notes", () => {
	const question = testQuestion();
	const summary = buildAnswerSummary(
		[question],
		{ [question.question]: "SQLite (Recommended)" },
		{ [question.question]: { preview: "```ts\nx\n```", notes: "add WAL" } },
	);
	assert.equal(
		summary,
		'"Which database should we use?"="SQLite (Recommended)" selected preview:\n```ts\nx\n``` notes: add WAL',
	);
});

test("buildAnswerSummary reports a question answered with notes only", () => {
	const question = testQuestion();
	const summary = buildAnswerSummary(
		[question],
		{ [question.question]: NOTES_ONLY },
		{ [question.question]: { notes: "no preference" } },
	);
	assert.equal(summary, '"Which database should we use?"=(no option selected) notes: no preference');
});

test("isCleanlyAnswered is false for custom text, notes, or unknown labels", () => {
	const question = testQuestion();
	assert.equal(isCleanlyAnswered(question, undefined, [record({ labels: ["Postgres"] })], 0), true);
	assert.equal(isCleanlyAnswered(question, undefined, [record({ custom: "MariaDB" })], 0), false);
	assert.equal(
		isCleanlyAnswered(question, { [question.question]: { notes: "maybe" } }, [record({ labels: ["Postgres"] })], 0),
		false,
	);
	assert.equal(isCleanlyAnswered(question, undefined, [record({ labels: ["Unknown"] })], 0), false);
});

test("buildToolResultText distinguishes clean answers from requested changes", () => {
	const question = testQuestion();
	assert.equal(
		buildToolResultText([question], submitted()),
		'Your questions have been answered: "Which database should we use?"="SQLite (Recommended)". You can now continue with these answers in mind.',
	);
	assert.equal(
		buildToolResultText(
			[question],
			submitted({
				records: [record({ custom: "MariaDB" })],
				answers: { [question.question]: "MariaDB" },
			}),
		),
		'The user answered: "Which database should we use?"="MariaDB". Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.',
	);
});

test("buildToolResultText prefers a freeform response over the answer summary", () => {
	const question = testQuestion();
	assert.equal(
		buildToolResultText([question], submitted({ response: "Use Postgres, we already run it." })),
		"The user responded: Use Postgres, we already run it.",
	);
});

test("buildToolResultText reports away-from-keyboard outcomes", () => {
	const question = testQuestion();
	const outcome: Extract<DialogOutcome, { kind: "afk" }> = {
		kind: "afk",
		afkTimeoutMs: 240_000,
		records: [record({ labels: ["SQLite (Recommended)"] })],
		answers: { [question.question]: "SQLite (Recommended)" },
	};
	const text = buildToolResultText([question], outcome);
	assert.match(text, /^No response after 240s — the user may be away from keyboard\./);
	assert.match(text, /Before going idle the user had selected: "Which database should we use\?"="SQLite \(Recommended\)"\.$/);
});

test("buildToolResultText falls back to the did-not-answer text", () => {
	const question = testQuestion();
	assert.equal(
		buildToolResultText([question], submitted({ records: [record()], answers: {} })),
		"The user did not answer the questions.",
	);
});
