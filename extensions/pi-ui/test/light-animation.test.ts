import assert from "node:assert/strict";
import test from "node:test";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { harness, strip } from "./harness.ts";
import { createCcstyleTool } from "../src/transcript/tool-renderers.ts";

const result = (text: string, isError = false) => ({ content: [{ type: "text", text }], isError });

async function startExecution(h: Awaited<ReturnType<typeof harness>>, toolCallId: string, toolName: string, args: object) {
	await h.emit("tool_execution_start", { type: "tool_execution_start", toolCallId, toolName, args });
}

// Supply the UI views through the host's public renderer interface, recording
// those callbacks only. No private host accessor/updateDisplay is intercepted.
function observedRenderer(name: string, kind: "generic" | "file" | "patch") {
	let calls = 0;
	let results = 0;
	const renderer = createCcstyleTool({ name, label: name, parameters: {} }, kind);
	return {
		definition: {
			...renderer, name: `animation_fixture_${name}`,
			renderCall(...args: any[]) { calls++; return renderer.renderCall(...args); },
			renderResult(...args: any[]) { results++; return renderer.renderResult(...args); },
		},
		counts: () => ({ calls, results }),
	};
}

test("a live declared call animates while waiting without rebuilding its bodies", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
	const h = await harness();
	t.mock.timers.tick(0);
	try {
		const observed = observedRenderer("bash", "generic");
		const args = { command: "WAITING_DECLARATION" };
		// Unlike h.tool(), this public host constructor has not started execution.
		const tool = new ToolExecutionComponent(observed.definition.name, "waiting-declared", args,
			{ showImages: false }, observed.definition, h.tui, process.cwd());
		h.root.addChild(tool);
		const replay = h.render().join("\n");
		t.mock.timers.tick(240);
		assert.equal(h.render().join("\n"), replay, "an unfinished historical call is static until declared in a live run");
		await h.emit("agent_start", { type: "agent_start" });
		await h.emit("message_start", { type: "message_start", message: {
			role: "assistant", content: [{ type: "toolCall", id: "waiting-declared", name: "bash", arguments: args }],
		} });
		const initial = observed.counts();
		const frames = new Set<string>();
		let repaints = 0;
		h.tui.requestRender = () => { repaints++; };
		for (let frame = 0; frame < 4; frame++) {
			frames.add(h.render().join("\n"));
			t.mock.timers.tick(80);
		}
		assert.ok(frames.size > 1, "declared calls animate before execution begins");
		assert.ok(repaints > 0, "waiting declarations request repaint");
		assert.deepEqual(observed.counts(), initial, "waiting animation must not rebuild either body");
		tool.updateResult(result("WAITING_RESULT"));
		await h.emit("tool_execution_end", { type: "tool_execution_end", toolCallId: "waiting-declared",
			toolName: "bash", result: result("WAITING_RESULT"), isError: false });
		const settled = h.render().join("\n");
		t.mock.timers.tick(240);
		assert.equal(h.render().join("\n"), settled, "a real result stops the animation");
		assert.match(settled, /✓.*Bash/);
	} finally { await h.close(); }
});

test("grouped declared calls animate before execution and settle without duplicate body assembly", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
	const h = await harness();
	t.mock.timers.tick(0);
	try {
		const observed = observedRenderer("bash", "generic");
		const calls = ["first", "second"].map((command) => ({
			type: "toolCall", id: `queued-${command}`, name: "bash", arguments: { command },
		}));
		const tools = calls.map((call) => {
			const tool = new ToolExecutionComponent("bash", call.id, call.arguments,
				{ showImages: false }, observed.definition, h.tui, process.cwd());
			h.root.addChild(tool);
			return tool;
		});
		const historical = h.render().join("\n");
		t.mock.timers.tick(240);
		assert.equal(h.render().join("\n"), historical, "an unfinished historical group stays quiet");
		await h.emit("agent_start", { type: "agent_start" });
		await h.emit("message_end", { type: "message_end", message: { role: "assistant", content: calls } });
		const initial = observed.counts();
		const declared = h.render().join("\n");
		t.mock.timers.tick(80);
		assert.notEqual(h.render().join("\n"), declared, "waiting rows use the shared animation without execution-start flags");
		assert.deepEqual(observed.counts(), initial);
		tools[0]!.updateResult(result("done"));
		tools[1]!.updateResult(result("failed", true));
		const settled = h.render().join("\n");
		t.mock.timers.tick(240);
		assert.equal(h.render().join("\n"), settled);
		assert.match(settled, /✓.*Bash first/);
		assert.match(settled, /✗.*Bash second/);
	} finally { await h.close(); }
});

test("streamed and final declarations animate waiting file and patch headers without rebuilding bodies", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
	const h = await harness();
	t.mock.timers.tick(0);
	try {
		for (const [name, kind, event, args] of [
			["write", "file", "message_update", {}],
			["write", "file", "message_update", { path: "waiting.ts" }],
			["write", "file", "message_update", { path: "waiting.ts", content: "retained source" }],
			["apply_patch", "patch", "message_end", { patch: "*** Begin Patch\n*** End Patch" }],
		] as const) {
			h.root.clear();
			await h.emit("agent_start", { type: "agent_start" });
			const observed = observedRenderer(name, kind);
			const id = `declared-${name}`;
			const tool = new ToolExecutionComponent(observed.definition.name, id, args,
				{ showImages: false }, observed.definition, h.tui, process.cwd());
			h.root.addChild(tool);
			const message = { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] };
			await h.emit(event, { type: event, message, assistantMessageEvent: {
				type: "toolcall_delta", contentIndex: 0, delta: "{}", partial: message,
			} });
			const initial = observed.counts();
			const before = h.render().join("\n");
			t.mock.timers.tick(80);
			assert.notEqual(h.render().join("\n"), before, `${event} marks ${name} as live before execution`);
			assert.deepEqual(observed.counts(), initial, "waiting repaint leaves the retained body intact");
			tool.updateResult(result("declaration finished"));
			const settled = h.render().join("\n");
			t.mock.timers.tick(240);
			assert.equal(h.render().join("\n"), settled, "a real result supersedes waiting state");
		}
	} finally { await h.close(); }
});

test("settled and replaced transcripts do not restart unfinished execution animations", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
	const h = await harness();
	t.mock.timers.tick(0);
	try {
		await h.emit("agent_start", { type: "agent_start" });
		h.tool("bash", "unfinished-live", { command: "UNFINISHED_EXECUTION" });
		await h.emit("tool_execution_start", { type: "tool_execution_start", toolCallId: "unfinished-live",
			toolName: "bash", args: { command: "UNFINISHED_EXECUTION" } });
		const executing = h.render().join("\n");
		t.mock.timers.tick(80);
		assert.notEqual(h.render().join("\n"), executing);
		await h.emit("agent_settled", { type: "agent_settled", aborted: true });
		t.mock.timers.tick(0);
		const settled = h.render().join("\n");
		t.mock.timers.tick(240);
		assert.equal(h.render().join("\n"), settled, "settling stops an unfinished call");
		for (const event of ["session_tree", "session_start"]) {
			await h.emit(event, { type: event });
			t.mock.timers.tick(0);
			const historical = h.render().join("\n");
			t.mock.timers.tick(240);
			assert.equal(h.render().join("\n"), historical, `${event} cannot make historical execution live again`);
		}
	} finally { await h.close(); }
});

test("pending frames repaint without reassembling call/result bodies and real results remain live", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
	const h = await harness();
	t.mock.timers.tick(0); // Finish the host's initial deferred transcript refresh.
	try {
		await h.emit("agent_start", { type: "agent_start" });
		const observed = observedRenderer("bash", "generic");
		const tool = h.tool(observed.definition.name, "animated", { command: "synthetic-only" }, undefined, observed.definition);
		await startExecution(h, "animated", "bash", { command: "synthetic-only" });
		const counts = observed.counts;
		tool.updateResult(result("partial one"), true);
		const initial = counts();
		const frames = new Set<string>();
		let repaint = 0;
		h.tui.requestRender = () => { repaint++; };
		for (let frame = 0; frame < 4; frame++) {
			frames.add(tool.render(100).map(strip).join("\n"));
			t.mock.timers.tick(80);
		}
		assert.ok(frames.size > 1, "the spinner advances at a stable width");
		assert.ok(repaint > 0, "animation requests repaint");
		assert.deepEqual(counts(), initial, "animation alone must not call either body renderer again");

		tool.updateResult(result("final failure", true));
		assert.ok(counts().results > initial.results, "real result updates still assemble the body");
		assert.match(tool.render(100).map(strip).join("\n"), /✗.*Bash[\s\S]*final failure/);
		const stopped = tool.render(100).map(strip).join("\n");
		t.mock.timers.tick(240);
		assert.equal(tool.render(100).map(strip).join("\n"), stopped);
		await h.close();
		const afterClose = repaint;
		t.mock.timers.tick(1_000);
		assert.equal(repaint, afterClose, "disposed sessions do not request animation frames");
	} finally { await h.close(); }
});

test("file headers and grouped pending tools animate without body rebuilds", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
	const h = await harness();
	t.mock.timers.tick(0);
	try {
		await h.emit("agent_start", { type: "agent_start" });
		for (const [name, args] of [
			["write", { path: "fixture.ts", content: "body" }],
			["edit", { path: "fixture.ts", oldText: "old", newText: "new" }],
			["apply_patch", { patch: "*** Begin Patch\n*** End Patch" }],
		] as const) {
			h.root.clear();
			const observed = observedRenderer(name, name === "apply_patch" ? "patch" : "file");
			const tool = h.tool(observed.definition.name, `pending-${name}`, args, undefined, observed.definition);
			await startExecution(h, `pending-${name}`, name, args);
			const counts = observed.counts;
			const initial = counts();
			const frames = new Set<string>();
			for (let frame = 0; frame < 3; frame++) {
				frames.add(tool.render(100).map(strip).join("\n"));
				t.mock.timers.tick(80);
			}
			assert.ok(frames.size > 1, `${name} headers must not freeze their glyph in a width cache`);
			assert.deepEqual(counts(), initial);
			tool.updateResult(result("cancelled", true));
		}
		h.root.clear();
		const first = h.tool("bash", "group-first", { command: "first" });
		const second = h.tool("bash", "group-second", { command: "second" });
		await startExecution(h, "group-first", "bash", { command: "first" });
		await startExecution(h, "group-second", "bash", { command: "second" });
		const groupFrames = new Set<string>();
		let repaints = 0;
		h.tui.requestRender = () => { repaints++; };
		for (let frame = 0; frame < 3; frame++) {
			groupFrames.add(h.root.render(100).map(strip).join("\n"));
			t.mock.timers.tick(80);
		}
		assert.ok(groupFrames.size > 1);
		h.root.render(100); // Paint the requested frame before final results arrive.
		first.updateResult(result("done"));
		second.updateResult(result("cancelled", true));
		h.root.render(100);
		const settledRepaints = repaints;
		t.mock.timers.tick(80);
		assert.equal(repaints, settledRepaints, "a settled group must not request another pending frame");
	} finally { await h.close(); }
});

test("expanded partial results remain visible and fresh while the spinner advances", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
	const h = await harness();
	t.mock.timers.tick(0);
	const tool = h.tool("bash", "streaming-result", { command: "synthetic-only" });
	try {
		await h.emit("agent_start", { type: "agent_start" });
		await startExecution(h, "streaming-result", "bash", { command: "synthetic-only" });
		tool.setExpanded(true);
		tool.updateResult(result("PARTIAL_ONE"), true);
		assert.match(tool.render(100).map(strip).join("\n"), /PARTIAL_ONE/);
		t.mock.timers.tick(80);
		const before = tool.render(100).map(strip).join("\n");
		tool.updateResult(result("PARTIAL_TWO\nsecond retained row"), true);
		const after = tool.render(100).map(strip).join("\n");
		assert.match(after, /PARTIAL_TWO[\s\S]*second retained row/);
		assert.doesNotMatch(after, /PARTIAL_ONE/);
		t.mock.timers.tick(80);
		assert.notEqual(tool.render(100).map(strip).join("\n"), after, "the current partial body must not freeze the spinner");
		assert.notEqual(before, after);
	} finally { tool.updateResult(result("cancelled", true)); await h.close(); }
});
