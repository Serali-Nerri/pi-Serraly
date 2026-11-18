import assert from "node:assert/strict";
import test from "node:test";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { ParentBindings } from "../src/parents.js";
import { createFixture, response } from "./fixtures/session.js";

test(
	"repeated nested parent lookups share one branch read per leaf and invalidate correctly",
	{
		timeout: 10_000,
	},
	async (t) => {
		const parents = new ParentBindings();
		let manager: SessionManager;
		let checked = false;
		const fixture = await createFixture(t, {
			guardian: false,
			tools: ["inspect_parent"],
			factories: [
				(pi) => {
					parents.register(pi, () => true);
					pi.registerTool({
						name: "inspect_parent",
						label: "Inspect",
						description: "Inspect parent binding",
						parameters: { type: "object", properties: {} },
						async execute(id, _args, _signal, _update, ctx) {
							const readBranch = ctx.sessionManager.getBranch.bind(
								ctx.sessionManager,
							);
							const reads = t.mock.method(
								ctx.sessionManager,
								"getBranch",
								readBranch,
							);
							const parent = parents.resolve(id, ctx);
							assert.ok(parent);
							for (let i = 0; i < 64; i++) {
								parents.admitted(`nested-${i}`, parent);
								assert.equal(parents.resolve(`nested-${i}`, ctx), parent);
							}
							assert.equal(reads.mock.callCount(), 1);
							const nextLeaf = manager.appendCustomEntry("display-state", {});
							assert.equal(parents.resolve(id, ctx), parent);
							assert.equal(parents.resolve(id, ctx), parent);
							assert.equal(reads.mock.callCount(), 2);
							const beforeResponse = readBranch().find(
								(entry) =>
									entry.type === "message" && entry.message.role === "user",
							);
							assert.ok(beforeResponse);
							manager.branch(beforeResponse.id);
							assert.equal(parents.resolve(id, ctx), undefined);
							assert.equal(parents.resolve(id, ctx), undefined);
							assert.equal(reads.mock.callCount(), 3);
							manager.branch(nextLeaf);
							assert.equal(parents.resolve(id, ctx), parent);
							assert.equal(reads.mock.callCount(), 4);
							parents.clear();
							assert.equal(parents.resolve(id, ctx), undefined);
							assert.equal(reads.mock.callCount(), 4);
							reads.mock.restore();
							checked = true;
							return {
								content: [{ type: "text", text: "checked" }],
								details: {},
							};
						},
					});
				},
			],
			onParent(body, index) {
				return response(
					`resp_parent${index}`,
					body.model,
					index === 1 ? { name: "inspect_parent" } : undefined,
					"Complete",
					"response.done",
				);
			},
		});
		manager = fixture.manager;
		await fixture.session.prompt("Inspect the parent binding.");
		assert.equal(checked, true);
	},
);
