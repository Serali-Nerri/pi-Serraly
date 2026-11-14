import assert from "node:assert/strict";
import test from "node:test";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../src/response.js";
import { REVIEW_MODEL, Reviewer, ReviewFailure } from "../src/review.js";

const model: Model<Api> = {
	id: "parent-model",
	name: "Parent",
	api: "openai-codex-responses",
	provider: "test-codex",
	baseUrl: "https://guardian.invalid/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8192,
};

function terminal(type: string, response: Record<string, unknown> = {}) {
	return {
		type,
		response: {
			id: "resp_Review1",
			status: "completed",
			output: [{ type: "message", role: "assistant" }],
			...response,
		},
	};
}

interface Reply {
	event: unknown;
	result?: Partial<AssistantMessage>;
	beforeResult?: () => void;
}

function reviewerFixture(replies: Reply[]) {
	const reviewer = new Reviewer();
	const controller = new AbortController();
	const bodies: unknown[] = [];
	// Exercise Reviewer's public registry callbacks without authentication or I/O.
	const streamSimple: ExtensionContext["modelRegistry"]["streamSimple"] = (
		selectedModel,
		_context,
		options,
	) => {
		const reply = replies.shift();
		assert.ok(reply, "unexpected reviewer request");
		const stream = createAssistantMessageEventStream();
		const result: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: REVIEW_MODEL,
			responseId: "resp_Review1",
			content: [{ type: "text", text: '{"outcome":"allow"}' }],
			usage: {
				input: 2,
				output: 3,
				cacheRead: 5,
				cacheWrite: 7,
				totalTokens: 17,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
			...reply.result,
		};
		void (async () => {
			bodies.push(await options?.onPayload?.({}, selectedModel));
			await options?.onProviderStreamEvent?.(reply.event, selectedModel);
			reply.beforeResult?.();
			stream.end(result);
		})().catch((error: unknown) => {
			stream.end({
				...result,
				stopReason: "error",
				errorMessage: String(error),
			});
		});
		return stream;
	};
	const request: Parameters<Reviewer["review"]>[0] = {
		ctx: { modelRegistry: { streamSimple } } as ExtensionContext,
		fetch: async () => {
			throw new Error("unexpected fetch");
		},
		model,
		parentThreadId: "parent-session",
		parentResponseId: "resp_Parent1",
		context: {
			instructions: "Help the user.",
			items: [{ kind: "user", text: "Inspect the project." }],
			omitted: 0,
		},
		action: {
			toolName: "read",
			input: { path: "README.md" },
			toolCallId: "call_1",
			cwd: "/project",
		},
		signal: controller.signal,
		transport: "sse",
	};
	return { reviewer, request, controller, bodies };
}

function unavailable(error: unknown): boolean {
	return error instanceof ReviewFailure && error.kind === "unavailable";
}

for (const type of ["response.completed", "response.done"]) {
	test(`Reviewer accepts ${type} only with a matching successful final result`, {
		timeout: 5000,
	}, async (t) => {
		const fixture = reviewerFixture([{ event: terminal(type) }]);
		t.after(() => fixture.reviewer.clear());
		assert.deepEqual(await fixture.reviewer.review(fixture.request), {
			outcome: "allow",
			inputTokens: 14,
			outputTokens: 3,
		});
	});

	test(`Reviewer rejects invalid ${type} output`, {
		timeout: 5000,
	}, async (t) => {
		for (const output of [
			undefined,
			null,
			{},
			[null],
			[{}],
			[{ type: "function_call" }],
			[{ type: "message" }, { type: "custom_tool_call" }],
		]) {
			const fixture = reviewerFixture([{ event: terminal(type, { output }) }]);
			t.after(() => fixture.reviewer.clear());
			await assert.rejects(
				fixture.reviewer.review(fixture.request),
				unavailable,
				JSON.stringify(output),
			);
		}
	});
}

test("Reviewer does not trust a successful final result without validated raw success", {
	timeout: 5000,
}, async (t) => {
	const invalid: Reply[] = [
		{ event: terminal("response.done", { status: undefined }) },
		{ event: terminal("response.done", { status: "incomplete" }) },
		{
			event: terminal("response.done", { id: "resp_bad_id" }),
			result: { responseId: "resp_bad_id" },
		},
		{ event: terminal("response.incomplete") },
	];
	for (const reply of invalid) {
		const fixture = reviewerFixture([reply]);
		t.after(() => fixture.reviewer.clear());
		await assert.rejects(fixture.reviewer.review(fixture.request), unavailable);
	}
});

test("Reviewer still rejects inconsistent final IDs, model, stop reason and tool output", {
	timeout: 5000,
}, async (t) => {
	const invalid: Partial<AssistantMessage>[] = [
		{ responseId: "resp_Other" },
		{ model: "ordinary-model" },
		{ stopReason: "length" },
		{ stopReason: "aborted" },
		{
			content: [
				{ type: "toolCall", id: "call_1", name: "read", arguments: {} },
			],
		},
	];
	for (const result of invalid) {
		const fixture = reviewerFixture([
			{ event: terminal("response.done"), result },
		]);
		t.after(() => fixture.reviewer.clear());
		await assert.rejects(fixture.reviewer.review(fixture.request), unavailable);
	}
});

test("Reviewer cancellation and lane invalidation cannot admit a completed reply", {
	timeout: 5000,
}, async (t) => {
	const cancelled = reviewerFixture([
		{
			event: terminal("response.done"),
			beforeResult: () => cancelled.controller.abort(),
		},
	]);
	t.after(() => cancelled.reviewer.clear());
	await assert.rejects(
		cancelled.reviewer.review(cancelled.request),
		(error: unknown) =>
			error instanceof ReviewFailure && error.kind === "cancelled",
	);
	const stale = reviewerFixture([
		{
			event: terminal("response.done"),
			beforeResult: () => stale.reviewer.clear(),
		},
	]);
	t.after(() => stale.reviewer.clear());
	await assert.rejects(stale.reviewer.review(stale.request), unavailable);
});

test("Reviewer replays cloned raw reasoning and message items across terminal aliases", {
	timeout: 5000,
}, async (t) => {
	const reasoning = {
		type: "reasoning",
		id: "rs_1",
		encrypted_content: "opaque",
		summary: [{ type: "summary_text", text: "reasoning" }],
	};
	const message = {
		type: "message",
		id: "msg_1",
		role: "assistant",
		content: [
			{ type: "output_text", text: '{"outcome":"allow"}', annotations: [] },
		],
	};
	const output = [reasoning, message];
	const expected = structuredClone(output);
	const fixture = reviewerFixture([
		{ event: terminal("response.done", { output }) },
		{
			event: terminal("response.completed", { id: "resp_Review2" }),
			result: { responseId: "resp_Review2" },
		},
	]);
	t.after(() => fixture.reviewer.clear());
	await fixture.reviewer.review(fixture.request);
	reasoning.encrypted_content = "changed";
	message.content.push({
		type: "output_text",
		text: "changed",
		annotations: [],
	});
	await fixture.reviewer.review(fixture.request);
	const replay = fixture.bodies[1];
	assert.ok(isRecord(replay));
	assert.ok(Array.isArray(replay["input"]));
	assert.deepEqual(replay["input"].slice(1, 3), expected);
});
