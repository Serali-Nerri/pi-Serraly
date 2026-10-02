import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { NOTES_ONLY } from "../src/config.ts";
import { createAskUserQuestionDialog, type AskUserQuestionDialog } from "../src/dialog.ts";
import type { DialogOutcome } from "../src/result.ts";
import { fakeTui, keys, testQuestion, testQuestions, testTheme } from "./helpers.ts";

function open(questions = [testQuestion()]) {
	const outcomes: DialogOutcome[] = [];
	const dialog = createAskUserQuestionDialog({
		questions,
		tui: fakeTui(),
		theme: testTheme(),
		done: (outcome) => outcomes.push(outcome),
	});
	return {
		dialog,
		outcomes,
		// The TUI invalidates components on resize; tests re-render at several widths.
		render: (width = 80) => {
			dialog.invalidate();
			return dialog.render(width);
		},
	};
}

/** Narrow an outcome to the submitted/afk branch so answers and records are typed. */
function answersOf(outcome: DialogOutcome | undefined): Extract<DialogOutcome, { kind: "submitted" | "afk" }> {
	assert.ok(outcome && outcome.kind !== "cancelled", `expected an answered outcome, got ${outcome?.kind}`);
	return outcome as Extract<DialogOutcome, { kind: "submitted" | "afk" }>;
}

function type(dialog: ReturnType<typeof open>["dialog"], text: string): void {
	for (const character of text) dialog.handleInput(character);
}

test("Enter on the first option submits a single question immediately", () => {
	const { dialog, outcomes } = open();
	dialog.handleInput(keys.enter);
	assert.equal(outcomes.length, 1);
	const outcome = outcomes[0];
	assert.equal(outcome?.kind, "submitted");
	assert.deepEqual(answersOf(outcome).answers, { "Which database should we use?": "SQLite (Recommended)" });
});

test("arrow keys move the cursor and carry the option preview into the annotations", () => {
	const question = testQuestion({
		options: [
			{ label: "SQLite (Recommended)", description: "Embedded." },
			{ label: "Postgres", description: "Client/server.", preview: "```sql\nCREATE TABLE x();\n```" },
		],
	});
	const { dialog, outcomes } = open([question]);
	dialog.handleInput(keys.down);
	dialog.handleInput(keys.enter);
	const outcome = outcomes[0];
	assert.equal(outcome?.kind, "submitted");
	assert.deepEqual(answersOf(outcome).answers, { "Which database should we use?": "Postgres" });
	assert.equal(answersOf(outcome).annotations?.[question.question]?.preview, "```sql\nCREATE TABLE x();\n```");
});

test("multiSelect toggles with Space and joins the labels", () => {
	const question = testQuestion({
		multiSelect: true,
		options: [
			{ label: "Dark mode", description: "Follow the OS." },
			{ label: "Telemetry", description: "Anonymous stats." },
		],
	});
	const { dialog, outcomes, render } = open([question]);

	// Enter without a selection only sets a hint, it does not submit.
	dialog.handleInput(keys.enter);
	assert.equal(outcomes.length, 0);
	assert.match(render().join("\n"), /Select at least one option/);

	dialog.handleInput(keys.space);
	dialog.handleInput(keys.down);
	dialog.handleInput(keys.space);
	dialog.handleInput(keys.enter);
	assert.deepEqual(answersOf(outcomes[0]).answers, { "Which database should we use?": "Dark mode, Telemetry" });
});

test("Other collects a free-text answer and clears any selection", () => {
	const { dialog, outcomes } = open();
	dialog.handleInput(keys.down);
	dialog.handleInput(keys.down);
	dialog.handleInput(keys.enter); // "Other"
	type(dialog, "MariaDB");
	dialog.handleInput(keys.enter);
	assert.deepEqual(answersOf(outcomes[0]).answers, { "Which database should we use?": "MariaDB" });
	assert.equal(answersOf(outcomes[0]).records[0]?.custom, "MariaDB");
});

test("Chat about this returns a freeform response", () => {
	const { dialog, outcomes } = open();
	dialog.handleInput(keys.down);
	dialog.handleInput(keys.down);
	dialog.handleInput(keys.down); // "Chat about this"
	dialog.handleInput(keys.enter);
	type(dialog, "Use Postgres, we already run it.");
	dialog.handleInput(keys.enter);
	const outcome = answersOf(outcomes[0]);
	assert.equal(outcome.response, "Use Postgres, we already run it.");
});

test("notes are attached as annotations next to the selected option", () => {
	const { dialog, outcomes } = open();
	dialog.handleInput("n");
	type(dialog, "check with the team");
	dialog.handleInput(keys.enter); // back to the option list
	dialog.handleInput(keys.enter); // pick the recommended option
	const outcome = answersOf(outcomes[0]);
	assert.deepEqual(outcome.answers, { "Which database should we use?": "SQLite (Recommended)" });
	assert.equal(outcome.annotations?.["Which database should we use?"]?.notes, "check with the team");
});

test("a question with notes but no option submits as notes only", () => {
	const questions = testQuestions();
	const { dialog, outcomes } = open(questions);

	dialog.handleInput("n");
	type(dialog, "let the user decide");
	dialog.handleInput(keys.enter); // back to the options

	dialog.handleInput(keys.tab); // second question
	dialog.handleInput(keys.space); // toggle "Dark mode"
	dialog.handleInput(keys.enter); // advance to the Submit tab
	dialog.handleInput(keys.enter); // submit

	const outcome = answersOf(outcomes[0]);
	assert.deepEqual(outcome.answers, {
		"Which database should we use?": NOTES_ONLY,
		"Which features should we enable?": "Dark mode",
	});
	assert.equal(outcome.annotations?.["Which database should we use?"]?.notes, "let the user decide");
});

test("Escape cancels the whole dialog", () => {
	const { dialog, outcomes } = open();
	dialog.handleInput(keys.escape);
	assert.deepEqual(outcomes, [{ kind: "cancelled" }]);
});

test("multiple questions use tabs and gate the Submit tab", () => {
	const questions = testQuestions();
	const { dialog, outcomes, render } = open(questions);

	dialog.handleInput(keys.tab); // second question
	dialog.handleInput(keys.space); // toggle "Dark mode"
	dialog.handleInput(keys.enter); // advance to the Submit tab
	assert.match(render().join("\n"), /Review your answers/);
	assert.match(render().join("\n"), /You have not answered all questions\./);

	dialog.handleInput(keys.enter); // refused: the first question is unanswered
	assert.equal(outcomes.length, 0);

	dialog.handleInput(keys.tab); // wrap around to the first question
	dialog.handleInput(keys.enter); // answer it -> second question
	dialog.handleInput(keys.enter); // confirm the multi-select answer -> Submit tab

	dialog.handleInput(keys.enter);
	assert.equal(outcomes.length, 1);
	assert.deepEqual(answersOf(outcomes[0]).answers, {
		"Which database should we use?": "SQLite (Recommended)",
		"Which features should we enable?": "Dark mode",
	});
});

test("previews stack below the options until the terminal is wide enough", () => {
	const question = testQuestion({
		options: [
			{ label: "SQLite (Recommended)", description: "Embedded.", preview: "```sql\nSELECT 1;\n```" },
			{ label: "Postgres", description: "Client/server." },
		],
	});
	const { render } = open([question]);

	const narrow = render(80).join("\n");
	assert.match(narrow, /┌─ Preview/);
	assert.doesNotMatch(narrow, /│ ┌─ Preview/);

	const wide = render(120).join("\n");
	assert.match(wide, /│ ┌─ Preview/);
});

test("rendered lines never exceed the requested width", () => {
	const questions = testQuestions();
	for (const width of [24, 40, 80, 120]) {
		const { dialog } = open(questions);
		dialog.handleInput(keys.tab);
		for (const line of dialog.render(width)) {
			assert.ok(visibleWidth(line) <= Math.max(24, width), `width ${width}: ${line}`);
		}
	}
});

test("the component can be disposed without leaving timers behind", () => {
	const { dialog } = open();
	dialog.dispose();
	dialog.dispose();
});
