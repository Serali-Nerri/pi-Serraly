import assert from "node:assert/strict";
import test from "node:test";
import { harness, strip } from "./harness.ts";
import { createCcstyleTool } from "../src/transcript/tool-renderers.ts";

const result = (text: string, isError = false) => ({ content: [{ type: "text", text }], isError });

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

test("pending frames repaint without reassembling call/result bodies and real results remain live", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
	const h = await harness();
	t.mock.timers.tick(0); // Finish the host's initial deferred transcript refresh.
	try {
		const observed = observedRenderer("bash", "generic");
		const tool = h.tool(observed.definition.name, "animated", { command: "synthetic-only" }, undefined, observed.definition);
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
		for (const [name, args] of [
			["write", { path: "fixture.ts", content: "body" }],
			["edit", { path: "fixture.ts", oldText: "old", newText: "new" }],
			["apply_patch", { patch: "*** Begin Patch\n*** End Patch" }],
		] as const) {
			h.root.clear();
			const observed = observedRenderer(name, name === "apply_patch" ? "patch" : "file");
			const tool = h.tool(observed.definition.name, `pending-${name}`, args, undefined, observed.definition);
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
