import assert from "node:assert/strict";
import test from "node:test";
import { normalizeQuestionParams } from "../src/tool/normalize-params.ts";
import { buildQuestionnaireResponse, DECLINE_MESSAGE } from "../src/tool/response-envelope.ts";
import type { QuestionParams } from "../src/tool/types.ts";
import { type ValidationResult, validateQuestionnaire } from "../src/tool/validate-questionnaire.ts";

const errorOf = (result: ValidationResult) => (result.ok ? undefined : result.error);

const option = (label: string, description = "describes the choice") => ({ label, description });
const params = (questions: QuestionParams["questions"]): QuestionParams => ({ questions });
const one = params([{ question: "Which?", header: "Pick", options: [option("Local"), option("Remote")] }]);

test("option and question counts are enforced before the dialog opens", () => {
	assert.equal(validateQuestionnaire(one).ok, true);
	const tooFew = params([{ question: "Which?", header: "Pick", options: [option("Only")] }]);
	assert.deepEqual(validateQuestionnaire(tooFew), {
		ok: false,
		error: "empty_options",
		message: "Error: Each question requires at least 2 options",
	});
	const tooMany = params(
		Array.from({ length: 5 }, (_, index) => ({ question: `Q${index}?`, header: "Pick", options: [option("A"), option("B")] })),
	);
	assert.equal(errorOf(validateQuestionnaire(tooMany)), "too_many_questions");
	assert.equal(errorOf(validateQuestionnaire(params([]))), "no_questions");
});

test("reserved labels, duplicate labels and duplicate questions are rejected", () => {
	for (const label of ["Other", "Type something.", "Next"]) {
		const reserved = params([{ question: "Which?", header: "Pick", options: [option(label), option("B")] }]);
		assert.equal(errorOf(validateQuestionnaire(reserved)), "reserved_label", label);
	}
	const duplicateLabel = params([{ question: "Which?", header: "Pick", options: [option("A"), option("A")] }]);
	assert.equal(errorOf(validateQuestionnaire(duplicateLabel)), "duplicate_option_label");
	const duplicateQuestion = params([
		{ question: "Which?", header: "One", options: [option("A"), option("B")] },
		{ question: "Which?", header: "Two", options: [option("A"), option("B")] },
	]);
	assert.equal(errorOf(validateQuestionnaire(duplicateQuestion)), "duplicate_question");
});

test("line terminators are normalized before validation, so a CR cannot smuggle a reserved label", () => {
	const smuggled = normalizeQuestionParams(
		params([{ question: "A\r\nB", header: "Pick", options: [option("Other\r"), option("Remote")] }]),
	);
	assert.equal(smuggled.questions[0]?.question, "A\nB");
	assert.equal(errorOf(validateQuestionnaire(smuggled)), "reserved_label");
});

test("an answered envelope carries the selected preview, notes and the global note", () => {
	const response = buildQuestionnaireResponse(
		{
			answers: [
				{ questionIndex: 0, question: "Which?", kind: "option", answer: "Local", preview: "SELECT 1;", notes: "kept" },
			],
			cancelled: false,
			globalNote: "all good",
		},
		one,
	);
	assert.equal(
		response.content[0]?.text,
		'User has answered your questions: "Which?"="Local". selected preview: SELECT 1;. user notes: kept. global note: all good. You can now continue with the user\'s answers in mind.',
	);
	assert.equal(response.details.answers[0]?.preview, "SELECT 1;");
});

test("multi-select and empty custom answers fall back to the canonical placeholder", () => {
	const multi = params([
		{ question: "Which?", header: "Pick", options: [option("A"), option("B")], multiSelect: true },
	]);
	const response = buildQuestionnaireResponse(
		{
			answers: [
				{ questionIndex: 0, question: "Which?", kind: "multi", answer: null, selected: ["A", "B"] },
			],
			cancelled: false,
		},
		multi,
	);
	assert.equal(response.content[0]?.text, 'User has answered your questions: "Which?"="A, B". You can now continue with the user\'s answers in mind.');
	const empty = buildQuestionnaireResponse(
		{ answers: [{ questionIndex: 0, question: "Which?", kind: "custom", answer: null }], cancelled: false },
		one,
	);
	assert.match(empty.content[0]?.text ?? "", /"\(no input\)"/);
});

test("cancel and answered-nothing results collapse to the single decline signal", () => {
	const cancelled = buildQuestionnaireResponse({ answers: [], cancelled: true }, one);
	assert.equal(cancelled.content[0]?.text, DECLINE_MESSAGE);
	const empty = buildQuestionnaireResponse({ answers: [], cancelled: false }, one);
	assert.equal(empty.content[0]?.text, DECLINE_MESSAGE);
});

test("a cancelled result keeps its global note in details but still reads as a decline", () => {
	const response = buildQuestionnaireResponse({ answers: [], cancelled: true, globalNote: "kept" }, one);
	assert.equal(response.content[0]?.text, DECLINE_MESSAGE);
	assert.equal(response.details.globalNote, "kept");
});
