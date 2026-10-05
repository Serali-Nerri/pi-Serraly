import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { ParamsSchema, validateQuestions, type QuestionInput } from "../src/schema.ts";
import { testQuestion, testQuestions } from "./helpers.ts";

test("validateQuestions accepts the documented limits", () => {
	assert.doesNotThrow(() => validateQuestions([testQuestion()]));
	assert.doesNotThrow(() =>
		validateQuestions([
			testQuestion({
				options: [
					{ label: "a", description: "a" },
					{ label: "b", description: "b" },
					{ label: "c", description: "c" },
					{ label: "d", description: "d" },
				],
			}),
		]),
	);
});

test("validateQuestions rejects an empty question list", () => {
	assert.throws(() => validateQuestions([]), /requires 1-4 questions/);
});

test("validateQuestions rejects duplicate question texts", () => {
	const questions: QuestionInput[] = [testQuestion(), testQuestion()];
	assert.throws(() => validateQuestions(questions), /question texts must be unique/);
});

test("validateQuestions rejects a question without a real decision", () => {
	assert.throws(
		() => validateQuestions([testQuestion({ options: [{ label: "only", description: "one" }] })]),
		/single option has no decision in it/,
	);
});

test("validateQuestions rejects duplicate option labels", () => {
	assert.throws(
		() =>
			validateQuestions([
				testQuestion({
					options: [
						{ label: "same", description: "first" },
						{ label: "same", description: "second" },
					],
				}),
			]),
		/option labels must be unique/,
	);
});

test("ParamsSchema enforces the documented shape", () => {
	assert.equal(Value.Check(ParamsSchema, { questions: testQuestions() }), true);
	// A 13 character header is the smallest violation of the documented limit.
	assert.equal(
		Value.Check(ParamsSchema, { questions: [testQuestion({ header: "thirteenChars" })] }),
		false,
	);
	assert.equal(Value.Check(ParamsSchema, { questions: [testQuestion({ options: [] })] }), false);
	assert.equal(Value.Check(ParamsSchema, { questions: [] }), false);
});
