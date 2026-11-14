import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionFactory,
	ExtensionToolContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	createFixture,
	type RequestBody,
	response,
} from "./fixtures/session.js";

const parameters = {
	type: "object",
	properties: {},
	additionalProperties: false,
};
const reviewedTool = (body: RequestBody) => {
	const text = body.input.at(-1)?.content?.[0]?.text;
	assert.ok(text);
	return (JSON.parse(text) as { pending_action: { toolName: string } })
		.pending_action.toolName;
};

for (const terminal of ["response.completed", "response.done"]) {
	for (const automatic of [false, true]) {
		test(`yielded nested review survives real SDK result appends (${terminal}, ${automatic ? "default" : "rules-only"})`, {
			timeout: 15_000,
		}, async (t) => {
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			t.after(() => release.resolve());
			let manager: SessionManager;
			let reviewLeaf: string | null = null;
			let executed = 0;
			let outcome:
				| Awaited<ReturnType<ExtensionToolContext["executeTool"]>>
				| undefined;
			let pending: ReturnType<ExtensionToolContext["executeTool"]> | undefined;
			const tools: ExtensionFactory = (pi) => {
				pi.registerTool({
					name: "probe_action",
					label: "Probe",
					description: "Record execution",
					parameters,
					async execute() {
						executed++;
						return {
							content: [{ type: "text", text: "executed" }],
							details: {},
						};
					},
				});
				pi.registerTool({
					name: "yielding_wrapper",
					label: "Yield",
					description: "Start work and yield",
					parameters,
					async execute(_id, _args, _signal, _update, ctx) {
						pending = ctx.executeTool("probe_action", {});
						await Promise.race([started.promise, pending]);
						return {
							content: [{ type: "text", text: "yielded; call wait_result" }],
							details: {},
						};
					},
				});
				pi.registerTool({
					name: "wait_result",
					label: "Wait",
					description: "Collect yielded work",
					parameters,
					async execute() {
						assert.ok(pending);
						outcome = await pending;
						return outcome.result;
					},
				});
			};
			const fixture = await createFixture(t, {
				factories: [tools],
				tools: ["yielding_wrapper", "wait_result", "probe_action"],
				...(automatic
					? {}
					: {
							config: {
								defaultAction: "pass",
								rules: [{ tool: "probe_action", action: "review" }],
							},
						}),
				onParent(body, index) {
					if (index === 2) {
						assert.notEqual(manager.getLeafId(), reviewLeaf);
						release.resolve();
					}
					return response(
						`resp_parent${index}`,
						body.model,
						index === 1
							? { name: "yielding_wrapper" }
							: index === 2
								? { name: "wait_result" }
								: undefined,
						"Complete",
						terminal,
					);
				},
				async onReview(body, index) {
					if (reviewedTool(body) === "probe_action") {
						reviewLeaf = manager.getLeafId();
						started.resolve();
						await release.promise;
					}
					return response(
						`resp_review${index}`,
						body.model,
						undefined,
						'{"outcome":"allow"}',
						terminal,
					);
				},
			});
			manager = fixture.manager;
			await fixture.session.prompt(
				"Run the yielding wrapper and collect its result.",
			);
			assert.equal(executed, 1);
			assert.equal(outcome?.isError, false);
			assert.equal(fixture.reviewCount(), automatic ? 3 : 1);
		});
	}
}

for (const change of [
	"none",
	"context_edit",
	"custom_message",
	"compaction",
] as const) {
	test(`late nested admission checks the original parent snapshot (${change})`, {
		timeout: 15_000,
	}, async (t) => {
		let invoke:
			| (() => ReturnType<ExtensionToolContext["executeTool"]>)
			| undefined;
		let pending: ReturnType<ExtensionToolContext["executeTool"]> | undefined;
		let outcome:
			| Awaited<ReturnType<ExtensionToolContext["executeTool"]>>
			| undefined;
		let executed = 0;
		const tools: ExtensionFactory = (pi) => {
			pi.registerTool({
				name: "probe_action",
				label: "Probe",
				description: "Record execution",
				parameters,
				async execute() {
					executed++;
					return { content: [{ type: "text", text: "executed" }], details: {} };
				},
			});
			pi.registerTool({
				name: "yielding_wrapper",
				label: "Yield",
				description: "Defer a nested call",
				parameters,
				async execute(_id, _args, _signal, _update, ctx) {
					invoke = () => ctx.executeTool("probe_action", {});
					return { content: [{ type: "text", text: "yielded" }], details: {} };
				},
			});
			pi.registerTool({
				name: "wait_result",
				label: "Wait",
				description: "Collect yielded work",
				parameters,
				async execute() {
					assert.ok(pending);
					outcome = await pending;
					return outcome.result;
				},
			});
			pi.on("turn_end", (event, ctx) => {
				if (
					change === "none" ||
					!event.toolResults.some(
						(result) => result.toolName === "yielding_wrapper",
					)
				)
					return;
				if (change === "custom_message")
					return {
						entries: [
							{
								type: "custom_message",
								customType: "authorization",
								content: "Do not execute probe_action.",
								display: false,
							},
						],
					};
				if (change === "compaction")
					return {
						entries: [
							{
								type: "compaction",
								summary: "Do not execute probe_action.",
								firstKeptEntryId: event.messageEntryId,
							},
						],
					};
				const user = ctx.sessionManager
					.getBranch()
					.find(
						(entry) =>
							entry.type === "message" && entry.message.role === "user",
					);
				assert.ok(user);
				return {
					entries: [
						{
							type: "context_edit",
							targetId: user.id,
							replacement: { content: "Do not execute probe_action." },
						},
					],
				};
			});
		};
		const fixture = await createFixture(t, {
			factories: [tools],
			tools: ["yielding_wrapper", "wait_result", "probe_action"],
			config: {
				defaultAction: "pass",
				rules: [{ tool: "probe_action", action: "review" }],
			},
			onParent(body, index) {
				if (index === 2) {
					assert.ok(invoke);
					pending = invoke();
				}
				return response(
					`resp_parent${index}`,
					body.model,
					index === 1
						? { name: "yielding_wrapper" }
						: index === 2
							? { name: "wait_result" }
							: undefined,
				);
			},
		});
		await fixture.session.prompt(
			"Run the yielding wrapper and collect its result.",
		);
		assert.equal(executed, change === "none" ? 1 : 0);
		assert.equal(outcome?.isError, change !== "none");
		assert.equal(fixture.reviewCount(), change === "none" ? 1 : 0);
	});
}

for (const change of ["context_edit", "custom_message", "steer"] as const) {
	test(`a yielded review cannot survive ${change} authorization changes`, {
		timeout: 15_000,
	}, async (t) => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		t.after(() => release.resolve());
		let executed = 0;
		let pending: ReturnType<ExtensionToolContext["executeTool"]> | undefined;
		let outcome:
			| Awaited<ReturnType<ExtensionToolContext["executeTool"]>>
			| undefined;
		const tools: ExtensionFactory = (pi) => {
			pi.registerTool({
				name: "probe_action",
				label: "Probe",
				description: "Record execution",
				parameters,
				async execute() {
					executed++;
					return { content: [{ type: "text", text: "executed" }], details: {} };
				},
			});
			pi.registerTool({
				name: "yielding_wrapper",
				label: "Yield",
				description: "Start work and yield",
				parameters,
				async execute(_id, _args, _signal, _update, ctx) {
					pending = ctx.executeTool("probe_action", {});
					await Promise.race([started.promise, pending]);
					if (change === "steer")
						pi.sendUserMessage("Do not execute probe_action.", {
							deliverAs: "steer",
						});
					return { content: [{ type: "text", text: "yielded" }], details: {} };
				},
			});
			pi.registerTool({
				name: "wait_result",
				label: "Wait",
				description: "Collect yielded work",
				parameters,
				async execute() {
					assert.ok(pending);
					outcome = await pending;
					return outcome.result;
				},
			});
			pi.on("turn_end", (event, ctx) => {
				if (
					change === "steer" ||
					!event.toolResults.some(
						(result) => result.toolName === "yielding_wrapper",
					)
				)
					return;
				if (change === "custom_message")
					return {
						entries: [
							{
								type: "custom_message",
								customType: "authorization",
								content: "Do not execute probe_action.",
								display: false,
							},
						],
					};
				const user = ctx.sessionManager
					.getBranch()
					.find(
						(entry) =>
							entry.type === "message" && entry.message.role === "user",
					);
				assert.ok(user);
				return {
					entries: [
						{
							type: "context_edit",
							targetId: user.id,
							replacement: { content: "Do not execute probe_action." },
						},
					],
				};
			});
		};
		const fixture = await createFixture(t, {
			factories: [tools],
			tools: ["yielding_wrapper", "wait_result", "probe_action"],
			config: {
				defaultAction: "pass",
				rules: [{ tool: "probe_action", action: "review" }],
			},
			onParent(body, index) {
				if (index === 2) release.resolve();
				return response(
					`resp_parent${index}`,
					body.model,
					index === 1
						? { name: "yielding_wrapper" }
						: index === 2
							? { name: "wait_result" }
							: undefined,
				);
			},
			async onReview(body, index) {
				started.resolve();
				await release.promise;
				return response(
					`resp_review${index}`,
					body.model,
					undefined,
					'{"outcome":"allow"}',
				);
			},
		});
		await fixture.session.prompt(
			"Run the yielding wrapper and collect its result.",
		);
		assert.equal(executed, 0);
		assert.equal(outcome?.isError, true);
	});
}
