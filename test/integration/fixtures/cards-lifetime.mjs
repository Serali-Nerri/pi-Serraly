import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { renderExecCall } from "../../../packages/pi-codex-conversion/dist/tools/code-mode/call-rendering.js";
import { renderTrackedCodeModeResult } from "../../../packages/pi-codex-conversion/dist/tools/code-mode/result-rendering.js";
import { createCodeModeRenderTracker } from "../../../packages/pi-codex-conversion/dist/tools/code-mode/render-tracker.js";
import { CodeModeNestedRenderStore } from "../../../packages/pi-codex-conversion/dist/tools/code-mode/trace-render-state.js";

initTheme("dark", false);
assert.equal(typeof globalThis.gc, "function");
const theme = { fg: (_role, text) => text, bold: (text) => text };
const tracker = createCodeModeRenderTracker(), store = new CodeModeNestedRenderStore(), state = {};
function streamFrames() {
	const callRefs = [], resultRefs = [];
	let call, output;
	for (let frame = 0; frame < 400; frame++) {
		const code = Array.from({ length: 120 }, (_, i) => `console.log("frame_${frame}_line_${i} ${"x".repeat(100)}");`).join("\n");
		const context = {
			state, args: { code }, lastComponent: call, expanded: false, isPartial: true,
			toolCallId: "streamed-exec", executionStarted: true, argsComplete: true, invalidate() {},
		};
		const result = {
			content: [{ type: "text", text: `${frame}: ${"current payload ".repeat(3000)}` }],
			details: { notification: true, status: "running", statusPrefix: false },
		};
		call = renderExecCall({ code }, theme, context, tracker);
		output = renderTrackedCodeModeResult(result, { expanded: false, isPartial: true }, theme,
			{ ...context, lastComponent: output }, tracker, store);
		call.render(80);
		output.render(80);
		callRefs.push(new WeakRef(call));
		resultRefs.push(new WeakRef(output));
	}
	return { call, output, callRefs, resultRefs };
}
const { call, output, callRefs, resultRefs } = streamFrames();
for (let attempt = 0; attempt < 3; attempt++) { await nextTurn(); globalThis.gc(); }
// A row may reuse its component across frames; count live instances, not weak handles.
assert.equal(new Set(callRefs.map((ref) => ref.deref()).filter(Boolean)).size, 1, "obsolete script components must be collectable");
assert.equal(new Set(resultRefs.map((ref) => ref.deref()).filter(Boolean)).size, 1, "obsolete output components must be collectable");
assert.match(call.render(80).join("\n"), /frame_399_line_0/);
assert.match(output.render(80).join("\n"), /399:/);
