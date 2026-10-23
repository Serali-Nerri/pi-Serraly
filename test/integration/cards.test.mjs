import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { renderExecCall } from "../../packages/pi-codex-conversion/dist/tools/code-mode/call-rendering.js";
import { renderTrackedCodeModeResult } from "../../packages/pi-codex-conversion/dist/tools/code-mode/result-rendering.js";
import { createCodeModeRenderTracker } from "../../packages/pi-codex-conversion/dist/tools/code-mode/render-tracker.js";
import { CodeModeNestedRenderStore } from "../../packages/pi-codex-conversion/dist/tools/code-mode/trace-render-state.js";
import { createApplyPatchTool } from "../../packages/pi-codex-conversion/dist/tools/apply-patch/tool.js";
import { runIsolated } from "../../scripts/lib/workspace.mjs";

initTheme("dark", false);

const theme = { fg: (_role, text) => text, bold: (text) => text };
const text = (component, width = 120) => component.render(width).map(stripTerminalSequences).join("\n");
function mouseAt(component, pattern, type = "click") {
	const lines = component.render(120).map(stripTerminalSequences);
	const y = lines.findIndex((line) => pattern.test(line));
	assert(y >= 0, `Missing click target: ${pattern}`);
	return component.handleMouse?.({
		type, button: "left", x: 0, y, screenX: 0, screenY: y,
		width: 120, height: lines.length, shift: false, alt: false, ctrl: false,
	});
}
function fixture(tools = []) {
	const tracker = createCodeModeRenderTracker();
	const store = new CodeModeNestedRenderStore();
	const state = {};
	const code = Array.from({ length: 16 }, (_, i) => `console.log("source_${i}");`).join("\n");
	const result = {
		content: [{ type: "text", text: Array.from({ length: 10 }, (_, i) => `output_${i}`).join("\n") }],
		details: { status: "result", statusPrefix: false, traces: Array.from({ length: 10 }, (_, i) => ({
			id: `trace-${i}`, name: "fixture_tool", status: "done", input: `input_${i}`,
			result: { content: [{ type: "text", text: `nested_result_${i}` }] },
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
			result, { expanded: ctx.expanded, isPartial: ctx.isPartial }, theme, ctx, tracker, store, tools, rich, minimal,
		),
	};
}

test("local clicks expand script and console independently while preserving upstream rendering", () => {
	const f = fixture();
	let call = f.call();
	let output = f.output();
	assert.match(text(call), /Ran code/);
	assert.match(text(call), /source_2/);
	assert.doesNotMatch(text(call), /source_3/);
	assert.match(text(output), /nested_result_0/);
	assert.match(text(output), /output_5/);
	assert.doesNotMatch(text(output), /output_0/);
	assert.equal(mouseAt(call, /source_0/, "drag"), undefined);
	assert.equal(mouseAt(call, /source_0/).handled, true);
	call = f.call();
	assert.match(text(call), /source_15/);
	call.invalidate();
	call.render(40);
	assert.match(text(f.call()), /source_15/);
	assert.doesNotMatch(text(f.output()), /output_0/);
	assert.equal(mouseAt(output, /output_5/).handled, true);
	output = f.output();
	assert.match(text(output), /output_0/);
	f.output({ ...f.context(), isPartial: true });
	assert.match(text(f.output()), /output_0/);
	assert.match(text(f.call()), /source_15/);
	assert.equal(mouseAt(f.call(), /source_0/).handled, true);
	assert.doesNotMatch(text(f.call()), /source_3/);
	assert.match(text(f.output()), /output_0/);
	// A global transition overrides both local choices; ordinary repaint does not.
	assert.match(text(f.call(f.context(true))), /source_15/);
	output = f.output(f.context(true));
	assert.match(text(output), /output_0/);
	assert.equal(mouseAt(output, /output_0/).handled, true);
	assert.doesNotMatch(text(f.output(f.context(true))), /output_0/);
	assert.match(text(f.call(f.context(true))), /source_15/);
	call = f.call(f.context(false));
	assert.doesNotMatch(text(call), /source_3/);
	assert.doesNotMatch(text(f.output()), /output_0/);
	for (const width of [20, 40, 80, 120]) {
		output = f.output();
		for (const line of [...call.render(width), ...output.render(width)]) assert(visibleWidth(line) <= width);
	}
});

test("each patch click expands the original renderer for that call without changing other regions", () => {
	const patch = createApplyPatchTool({ showDiffWhenCollapsed: false });
	const f = fixture([{
		kind: "function", name: "apply_patch", invoke() { throw new Error("Rendering only"); },
		renderCall: patch.renderCall, renderResult: patch.renderResult,
	}]);
	const traces = ["alpha", "beta"].map((name) => ({
		id: name, name: "apply_patch", status: "done",
		input: { input: "*** Begin Patch\n" + [name, `${name}-extra`].map((file) =>
			`*** Add File: ${file}.txt\n` + Array.from({ length: 16 }, (_, i) => `+${file}_line_${i}`).join("\n"),
		).join("\n") + "\n*** End Patch" },
	}));
	f.result.details.traces = traces;
	let output = f.output();
	assert.doesNotMatch(text(output), /alpha_line_15|beta_line_15/);
	assert.equal(mouseAt(output, /alpha\.txt/).handled, true);
	output = f.output();
	assert.match(text(output), /alpha_line_15/);
	assert.match(text(output), /alpha-extra_line_15/);
	assert.doesNotMatch(text(output), /beta_line_15|output_0/);
	assert.doesNotMatch(text(f.call()), /source_3/);
	assert.equal(mouseAt(output, /beta\.txt/).handled, true);
	output = f.output();
	assert.match(text(output), /beta_line_15/);
	assert.equal(mouseAt(output, /alpha_line_15/).handled, true);
	output = f.output();
	assert.doesNotMatch(text(output), /alpha_line_15/);
	assert.match(text(output), /beta_line_15/);
	assert.match(text(f.output(f.context(true))), /alpha_line_15/);
	assert.doesNotMatch(text(f.output(f.context(false))), /alpha_line_15|beta_line_15/);
	assert.equal(mouseAt(f.output(), /alpha\.txt/).handled, true);
	f.result.details.traces = [traces[1]];
	f.output();
	f.result.details.traces = traces;
	assert.doesNotMatch(text(f.output()), /alpha_line_15/);
});

test("local console clicks obey disabled details and the minimal preview setting", () => {
	const f = fixture();
	let output = f.output(f.context(), true, true);
	assert.doesNotMatch(text(output), /output_0|output_9/);
	assert.equal(mouseAt(output, /10 lines/).handled, true);
	output = f.output(f.context(), true, true);
	assert.match(text(output), /output_0/);
	assert.equal(mouseAt(output, /output_0/).handled, true);
	assert.doesNotMatch(text(f.output(f.context(), true, true)), /output_9/);
	assert.doesNotMatch(text(f.output(f.context(), false)), /output_9/);
	assert.doesNotMatch(text(f.output(f.context(true), false)), /output_9/);
	assert.match(text(f.output(f.context(true), false)), /nested_result_0/);
});

test("400 streamed frames release obsolete call and result components", async () => {
	await runIsolated(process.execPath, ["--expose-gc", "test/integration/fixtures/cards-lifetime.mjs"]);
});
