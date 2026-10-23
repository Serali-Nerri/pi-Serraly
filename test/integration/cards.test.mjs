import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { renderExecCall } from "../../packages/pi-codex-conversion/dist/tools/code-mode/call-rendering.js";
import { renderTrackedCodeModeResult } from "../../packages/pi-codex-conversion/dist/tools/code-mode/result-rendering.js";
import { createCodeModeRenderTracker } from "../../packages/pi-codex-conversion/dist/tools/code-mode/render-tracker.js";
import { CodeModeNestedRenderStore } from "../../packages/pi-codex-conversion/dist/tools/code-mode/trace-render-state.js";
import { runIsolated } from "../../scripts/lib/workspace.mjs";

initTheme("dark", false);

const theme = { fg: (_role, text) => text, bold: (text) => text };
const text = (component, width = 120) => component.render(width).map(stripTerminalSequences).join("\n");
const mouse = (type = "click") => ({
	type, button: "left", x: 0, y: 0, screenX: 0, screenY: 0,
	width: 120, height: 100, shift: false, alt: false, ctrl: false,
});
function fixture() {
	const tracker = createCodeModeRenderTracker();
	const store = new CodeModeNestedRenderStore();
	const state = {};
	const code = Array.from({ length: 16 }, (_, i) => `console.log("source_${i}");`).join("\n");
	const result = {
		content: [{ type: "text", text: Array.from({ length: 10 }, (_, i) => `output_${i}`).join("\n") }],
		details: { status: "result", statusPrefix: false, traces: Array.from({ length: 10 }, (_, i) => ({
			id: `trace-${i}`, name: "fixture_tool", status: "done", input: `input_${i}`,
			result: { content: [{ type: "text", text: "private nested result must not be duplicated" }] },
		})) },
	};
	const context = (expanded = false, lastComponent) => ({
		state, expanded, lastComponent, toolCallId: "fixture-exec", args: { code },
		executionStarted: true, argsComplete: true, isPartial: false, cwd: process.env.HOME,
		invalidate() {}, durationMs: 2300,
	});
	return {
		code, result, context,
		call: (ctx = context()) => renderExecCall({ code }, theme, ctx, tracker),
		output: (ctx = context(), rich = true, minimal = false) => renderTrackedCodeModeResult(
			result, { expanded: ctx.expanded, isPartial: ctx.isPartial }, theme, ctx, tracker, store, [], rich, minimal,
		),
	};
}

test("green-card content budgets, independent local choices and global expansion survive the port", () => {
	const f = fixture();
	let call = f.call();
	let output = f.output();
	assert.match(text(call), /source_9/);
	assert.doesNotMatch(text(call), /source_10/);
	assert.match(text(output), /input_2/);
	assert.doesNotMatch(text(output), /input_1(?:\s|$)/);
	assert.match(text(output), /output_4/);
	assert.doesNotMatch(text(output), /output_5|private nested result/);
	assert.match(text(output), /Took 2\.3s/);
	assert.equal(call.handleMouse(mouse("drag")), undefined);
	assert.equal(call.handleMouse(mouse()).handled, true);
	call = f.call();
	assert.match(text(call), /source_15/);
	assert.doesNotMatch(text(f.output()), /output_5/);
	// Global transitions discard local choices; redraw and resize do not.
	f.call(f.context(true));
	assert.match(text(f.output(f.context(true))), /input_0/);
	call = f.call(f.context(false));
	assert.doesNotMatch(text(call), /source_10/);
	for (const width of [20, 40, 80, 120]) {
		output = f.output();
		for (const line of [...call.render(width), ...output.render(width)]) assert(visibleWidth(line) <= width);
	}
});

test("producer truncation and important partial output remain visible when details are hidden", () => {
	const f = fixture();
	f.result.content[0].text += "\n[Output truncated]";
	assert.match(text(f.output(f.context(), false)), /\[Output truncated\]/);
	assert.doesNotMatch(text(f.output(f.context(), false)), /output_0/);
	assert.match(text(f.output(f.context(), true, true)), /more lines/);
	assert.doesNotMatch(text(f.output(f.context(), true, true)), /output_0/);
	assert.doesNotMatch(text(f.output({ ...f.context(), isPartial: true })), /output_0/);
	f.result.details.notification = true;
	assert.match(text(f.output({ ...f.context(), isPartial: true }, false)), /output_0/);
});

test("400 streamed frames release obsolete call and result components", async () => {
	await runIsolated(process.execPath, ["--expose-gc", "test/integration/fixtures/cards-lifetime.mjs"]);
});
