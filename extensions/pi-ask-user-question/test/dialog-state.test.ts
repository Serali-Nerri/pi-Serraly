import assert from "node:assert/strict";
import test from "node:test";
import { type QuestionnaireAction, routeKey } from "../src/state/key-router.ts";
import { displayLabel, sentinelsToAppend } from "../src/state/row-intent.ts";
import { type Effect, reduce } from "../src/state/state-reducer.ts";
import type { QuestionnaireRuntime, QuestionnaireState } from "../src/state/state.ts";
import type { QuestionData, QuestionnaireResult } from "../src/tool/types.ts";
import type { WrappingSelectItem } from "../src/view/components/wrapping-select.ts";

const KEYS: Record<string, string> = {
	"tui.select.confirm": "\r",
	"tui.input.submit": "\r",
	"tui.select.cancel": "\u001b",
	"tui.select.up": "\u001b[A",
	"tui.select.down": "\u001b[B",
};
const keybindings = { matches: (data: string, name: string) => KEYS[name] === data };

const question = (overrides: Partial<QuestionData> = {}): QuestionData => ({
	question: "Which?",
	header: "Pick",
	options: [
		{ label: "Local", description: "embedded", preview: "SELECT 1;" },
		{ label: "Remote", description: "client/server" },
	],
	...overrides,
});

function itemsFor(q: QuestionData): WrappingSelectItem[] {
	const items: WrappingSelectItem[] = q.options.map((o) => ({ kind: "option", label: o.label, description: o.description }));
	for (const kind of sentinelsToAppend(q)) items.push({ kind, label: displayLabel(kind) });
	return items;
}

function createSession(questions: QuestionData[], collapseKey = "ctrl+]") {
	let state: QuestionnaireState = {
		currentTab: 0,
		optionIndex: 0,
		inputMode: false,
		notesVisible: false,
		answers: new Map(),
		multiSelectChecked: new Set(),
		customDraftsByTab: new Map(),
		notesByTab: new Map(),
		submitChoiceIndex: 0,
		notesDraft: "",
		collapsed: false,
	};
	let inputBuffer = "";
	const itemsByTab = questions.map(itemsFor);
	const completed: QuestionnaireResult[] = [];
	const effects: Effect[] = [];
	const isMulti = questions.length > 1;
	function runtime(): QuestionnaireRuntime {
		const items = itemsByTab[state.currentTab] ?? [];
		return {
			keybindings,
			inputBuffer,
			canMoveInputUp: false,
			canMoveInputDown: false,
			questions,
			isMulti,
			currentItem: items[state.optionIndex],
			items,
			collapseKey,
		};
	}
	function send(data: string): QuestionnaireAction {
		const action = routeKey(data, state, runtime());
		const result = reduce(state, action, { questions, itemsByTab });
		state = result.state;
		for (const effect of result.effects) {
			effects.push(effect);
			if (effect.kind === "done") completed.push(effect.result);
		}
		return action;
	}
	return {
		send,
		completed,
		effects,
		get state() { return state; },
		setState: (next: QuestionnaireState) => { state = next; },
		setInputBuffer: (value: string) => { inputBuffer = value; },
	};
}

test("Enter on an option confirms it and carries the focused preview", () => {
	const session = createSession([question()]);
	assert.equal(session.send("\r").kind, "confirm");
	assert.deepEqual(session.completed[0], {
		answers: [{ questionIndex: 0, question: "Which?", kind: "option", answer: "Local", preview: "SELECT 1;" }],
		cancelled: false,
	});
});

test("Escape on the option list cancels the whole questionnaire", () => {
	const session = createSession([question()]);
	assert.equal(session.send("\u001b").kind, "cancel");
	assert.deepEqual(session.completed[0], { answers: [], cancelled: true });
});

test("an in-flight custom draft survives browsing away from the free-text row", () => {
	const session = createSession([question()]);
	session.setState({ ...session.state, optionIndex: 2, inputMode: true });
	session.setInputBuffer("my own answer");
	session.send("\u001b[B");
	assert.equal(session.state.optionIndex, 0);
	assert.equal(session.state.inputMode, false);
	assert.equal(session.state.customDraftsByTab.get(0), "my own answer");
	session.setInputBuffer("");
	session.send("\u001b[A");
	assert.deepEqual(session.effects.at(-1), { kind: "set_input_buffer", value: "my own answer" });
});

test("multi-select toggles options and commits them from the Next row, where Space is inert", () => {
	const session = createSession([question({ multiSelect: true })]);
	session.send(" ");
	assert.deepEqual(session.state.answers.get(0)?.selected, ["Local"]);
	session.setState({ ...session.state, optionIndex: 2 });
	assert.equal(session.send(" ").kind, "ignore");
	session.setState({ ...session.state, optionIndex: 3 });
	assert.equal(session.send("\r").kind, "multi_confirm");
	assert.deepEqual(session.completed[0]?.answers[0], {
		questionIndex: 0,
		question: "Which?",
		kind: "multi",
		answer: null,
		selected: ["Local"],
	});
});

test("a question note is trimmed, stored without answering, then attached on confirm", () => {
	const session = createSession([question()]);
	session.send("n");
	assert.equal(session.state.notesVisible, true);
	session.setState({ ...session.state, notesDraft: "  trimmed note  " });
	session.send("\r");
	assert.equal(session.state.notesVisible, false);
	assert.equal(session.state.answers.size, 0, "a note alone does not mark the question answered");
	assert.equal(session.state.notesByTab.get(0), "trimmed note");
	session.send("\r");
	assert.equal(session.completed[0]?.answers[0]?.notes, "trimmed note");
});

test("a Submit-tab note covers the whole questionnaire and survives partial submission", () => {
	const session = createSession([question(), question({ question: "Second?", header: "Two" })]);
	session.send("\t");
	assert.equal(session.state.currentTab, 1);
	session.setState({ ...session.state, currentTab: 2 });
	session.send("n");
	session.setState({ ...session.state, notesDraft: "whole questionnaire" });
	session.send("\r");
	assert.equal(session.state.notesByTab.get(2), "whole questionnaire");
	session.send("\r");
	assert.deepEqual(session.completed[0], { answers: [], cancelled: false, globalNote: "whole questionnaire" });
});

test("collapse hides the overlay, swallows input, and only Escape still cancels", () => {
	const session = createSession([question()]);
	assert.equal(session.send("\u001d").kind, "toggle_collapsed");
	assert.equal(session.state.collapsed, true);
	assert.deepEqual(session.effects.at(-1), { kind: "set_overlay_hidden", hidden: true });
	assert.equal(session.send("x").kind, "ignore");
	assert.equal(session.send("\u001b").kind, "cancel");
	assert.deepEqual(session.completed[0], { answers: [], cancelled: true });
});
