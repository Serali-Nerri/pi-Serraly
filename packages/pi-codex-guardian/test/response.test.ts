import assert from "node:assert/strict";
import test from "node:test";
import { parseSuccessfulResponseEvent } from "../src/response.js";

const aliases = ["response.completed", "response.done"];

test("successful raw terminal aliases expose the validated ID and untouched output", () => {
	const output = [{ type: "reasoning", encrypted_content: "opaque" }];
	for (const type of aliases) {
		const response = Object.freeze({
			id: "resp_Ab123",
			status: "completed",
			output,
		});
		const parsed = parseSuccessfulResponseEvent(
			Object.freeze({ type, response }),
		);
		assert.deepEqual(parsed, { id: "resp_Ab123", output });
		assert.equal(parsed?.output, output);
	}
});

test("parent success does not require reviewer output", () => {
	assert.deepEqual(
		parseSuccessfulResponseEvent({
			type: "response.done",
			response: { id: "resp_123", status: "completed" },
		}),
		{ id: "resp_123", output: undefined },
	);
});

test("both aliases require an explicit completed status", () => {
	for (const type of aliases) {
		for (const status of [
			undefined,
			null,
			"incomplete",
			"cancelled",
			"failed",
			"in_progress",
			"Completed",
		]) {
			assert.equal(
				parseSuccessfulResponseEvent({
					type,
					response: {
						id: "resp_123",
						...(status === undefined ? {} : { status }),
					},
				}),
				undefined,
				`${type}: ${String(status)}`,
			);
		}
	}
});

test("both aliases require the existing response ID pattern", () => {
	for (const type of aliases) {
		for (const id of [
			undefined,
			null,
			123,
			"",
			"resp_",
			"resp_a_b",
			"resp_a-1",
			"other_123",
		]) {
			assert.equal(
				parseSuccessfulResponseEvent({
					type,
					response: { id, status: "completed" },
				}),
				undefined,
				`${type}: ${String(id)}`,
			);
		}
	}
});

test("other events and malformed envelopes never establish success", () => {
	for (const type of [
		undefined,
		"response.incomplete",
		"response.created",
		"response.failed",
	]) {
		assert.equal(
			parseSuccessfulResponseEvent({
				type,
				response: { id: "resp_123", status: "completed" },
			}),
			undefined,
		);
	}
	for (const event of [
		null,
		[],
		"response.done",
		{},
		{ type: "response.done" },
		{ type: "response.done", response: [] },
	]) {
		assert.equal(parseSuccessfulResponseEvent(event), undefined);
	}
});
