import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { harness } from "./harness.ts";
import { toolCallSummary } from "../src/transcript/tool/names.ts";

test("compact capability failure leaves no orphan methods or pipeline registration after shutdown", async () => {
	const tool = ToolExecutionComponent.prototype as any;
	const assistant = AssistantMessageComponent.prototype;
	const originals = { updateDisplay: tool.updateDisplay, render: tool.render, assistant: assistant.updateContent };
	const key = Symbol.for("pi-ui.method-pipelines");
	tool.updateDisplay = undefined;
	let h: Awaited<ReturnType<typeof harness>> | undefined;
	try {
		h = await harness({ mode: "compact" });
		assert.equal(tool.render, originals.render, "failed domain releases everything acquired before compact");
		assert.equal(Object.hasOwn(tool, key), false);
		await h.close();
		assert.equal(assistant.updateContent, originals.assistant);
		assert.equal(Object.hasOwn(assistant, key), false);
		assert.equal((globalThis as any)[Symbol.for("claude-style-tools.compact-mode-patch")], undefined);
	} finally {
		await h?.close();
		tool.updateDisplay = originals.updateDisplay;
		tool.render = originals.render;
		assistant.updateContent = originals.assistant;
	}
});

test("partial compact acquisition rolls back when a callable method cannot be replaced", async () => {
	const proto = ToolExecutionComponent.prototype as any;
	const descriptor = Object.getOwnPropertyDescriptor(proto, "updateDisplay")!;
	const render = proto.render;
	const assistant = AssistantMessageComponent.prototype.updateContent;
	Object.defineProperty(proto, "updateDisplay", { ...descriptor, writable: false });
	let h: Awaited<ReturnType<typeof harness>> | undefined;
	try {
		h = await harness({ mode: "compact" });
		assert.equal(proto.render, render);
		assert.equal(Object.hasOwn(proto, Symbol.for("pi-ui.method-pipelines")), false);
		await h.close();
		assert.equal(AssistantMessageComponent.prototype.updateContent, assistant);
		assert.equal(Object.hasOwn(AssistantMessageComponent.prototype, Symbol.for("pi-ui.method-pipelines")), false);
	} finally { await h?.close(); Object.defineProperty(proto, "updateDisplay", descriptor); }
});

test("compaction observes the mounted post-rebuild boundary even after a slow downstream handler", async () => {
	const h = await harness({ mode: "compact" });
	const message: AssistantMessage = {
		role: "assistant", timestamp: 10, api: "openai-responses", provider: "fixture", model: "fixture",
		stopReason: "toolUse", content: [{ type: "toolCall", id: "compacted-tool", name: "read", arguments: { path: "fixture.ts" } }],
		usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
	const before: any = new AssistantMessageComponent(message, true);
	h.root.addChild(before);
	h.tool("read", "compacted-tool", { path: "fixture.ts" }, { content: [{ type: "text", text: "synthetic" }] });
	h.ctx.ui.getToolsExpanded = () => true;
	let rebuilt: any;
	const handlers = h.events.get("session_compact")!;
	handlers.push(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
		h.render(); // A render of the old tree must not consume the pending boundary.
		h.root.clear();
		rebuilt = new AssistantMessageComponent(message, true);
		h.root.addChild(rebuilt);
		h.tool("read", "compacted-tool", { path: "fixture.ts" }, { content: [{ type: "text", text: "synthetic" }] });
		assert.notEqual(rebuilt.expanded, true, "native rebuild does not assign the global expansion");
		h.render();
	});
	try {
		await h.emit("session_compact", { type: "session_compact" });
		assert.equal(rebuilt.expanded, true, "post-rebuild bridge synchronizes the new transcript");
	} finally { await h.close(); }
});

test("removed Task names use the same ordinary summary path as future tools", () => {
	for (const name of ["TaskCreate", "TaskUpdate", "TaskExecute", "TaskStop", "TaskList", "TaskGet", "TaskOutput"]) {
		const args = { subject: "old subject", task_id: "id", task_ids: ["a", "b"] };
		assert.deepEqual(toolCallSummary(name, args, { title: "Generic" }), toolCallSummary("future_tool", args, { title: "Generic" }));
	}
});
