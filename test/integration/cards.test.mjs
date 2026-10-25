import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { getCapabilities, setCapabilities, stripTerminalSequences, Text, visibleWidth } from "@earendil-works/pi-tui";
import { renderExecCall } from "../../packages/pi-codex-conversion/dist/tools/code-mode/call-rendering.js";
import { renderTrackedCodeModeResult } from "../../packages/pi-codex-conversion/dist/tools/code-mode/result-rendering.js";
import { createCodeModeRenderTracker } from "../../packages/pi-codex-conversion/dist/tools/code-mode/render-tracker.js";
import { CodeModeNestedRenderStore } from "../../packages/pi-codex-conversion/dist/tools/code-mode/trace-render-state.js";
import { CodeModeDelegateRuntime } from "../../packages/pi-codex-conversion/dist/tools/code-mode/delegate-runtime.js";
import { createApplyPatchTool } from "../../packages/pi-codex-conversion/dist/tools/apply-patch/tool.js";
import { createExecCommandTool } from "../../packages/pi-codex-conversion/dist/tools/exec/command-tool.js";
import { createExecCommandTracker } from "../../packages/pi-codex-conversion/dist/tools/exec/command-state.js";
import { createViewImageTool } from "../../packages/pi-codex-conversion/dist/tools/view-image/tool.js";
import { runIsolated } from "../../scripts/lib/workspace.mjs";

initTheme("dark", false);

const theme = { fg: (_role, text) => text, bold: (text) => text };
const text = (component, width = 120) => component.render(width).map(stripTerminalSequences).join("\n");
function mouseAt(component, pattern, type = "click") {
	const lines = component.render(120).map(stripTerminalSequences);
	const y = lines.findIndex((line) => pattern.test(line));
	assert(y >= 0, `Missing click target: ${pattern}`);
	return component.handleMouse?.({
		type, button: "left", x: 2, y, screenX: 2, screenY: y,
		width: 120, height: lines.length, shift: false, alt: false, ctrl: false,
	});
}
function fixture(tools = [], store = new CodeModeNestedRenderStore()) {
	const tracker = createCodeModeRenderTracker();
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
		code, result, context, store,
		call: (ctx = context()) => renderExecCall({ code }, theme, ctx, tracker),
		output: (ctx = context(), rich = true, minimal = false, update = result) => renderTrackedCodeModeResult(
			update, { expanded: ctx.expanded, isPartial: ctx.isPartial }, theme, ctx, tracker, store, tools, rich, minimal,
		),
	};
}

function hostCard(f) {
	const card = new ToolExecutionComponent("exec", "fixture-exec", { code: f.code }, {}, {
		renderCall: (_args, _theme, context) => f.call(context),
		renderResult: (result, _options, _theme, context) => f.output(context, true, false, result),
	}, { requestRender() {} }, process.env.HOME);
	card.markExecutionStarted();
	card.setArgsComplete();
	card.updateResult(f.result);
	return card;
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

test("repeated command calls toggle independently inside the real Pi card", () => {
	const command = createExecCommandTool(createExecCommandTracker(), {}, { showOutputWhenCollapsed: true });
	const f = fixture([{
		kind: "function", name: "exec_command", invoke() { throw new Error("Rendering only"); },
		renderCall: command.renderCall, renderResult: command.renderResult,
	}]);
	const traces = ["alpha", "beta"].map((name) => ({
		id: name, name: "exec_command", status: "done", input: { cmd: `printf ${name}` },
		result: {
			content: [{ type: "text", text: "Command completed" }],
			details: { output: Array.from({ length: 10 }, (_, i) => `${name}_line_${i}`).join("\n"), exit_code: 0 },
		},
	}));
	f.result.details.traces = traces;
	const card = hostCard(f);
	assert.doesNotMatch(text(card), /alpha_line_0|beta_line_0|source_3|output_0/);
	assert.equal(mouseAt(card, /printf alpha/, "drag"), undefined);
	assert.equal(mouseAt(card, /^\s*• Ran\s*$/).handled, true);
	assert.match(text(card), /alpha_line_0/);
	assert.doesNotMatch(text(card), /beta_line_0|source_3|output_0/);
	assert.equal(mouseAt(card, /beta_line_9/).handled, true);
	assert.match(text(card), /beta_line_0/);
	assert.match(text(card), /alpha_line_0/);
	assert.equal(mouseAt(card, /alpha_line_0/).handled, true);
	assert.doesNotMatch(text(card), /alpha_line_0|source_3|output_0/);
	assert.match(text(card), /beta_line_0/);
	card.render(40);
	card.invalidate();
	assert.match(text(card), /beta_line_0/);
	card.updateResult(f.result, true);
	card.updateResult(f.result);
	assert.match(text(card), /beta_line_0/);
	assert.doesNotMatch(text(card), /alpha_line_0|source_3|output_0/);
	card.setExpanded(true);
	assert.match(text(card), /alpha_line_0/);
	assert.match(text(card), /beta_line_0/);
	assert.match(text(card), /source_15/);
	assert.match(text(card), /output_0/);
	assert.equal(mouseAt(card, /beta_line_0/).handled, true);
	assert.doesNotMatch(text(card), /beta_line_0/);
	assert.match(text(card), /alpha_line_0/);
	assert.match(text(card), /output_0/);
	card.setExpanded(false);
	assert.doesNotMatch(text(card), /alpha_line_0|beta_line_0|source_3|output_0/);
	assert.equal(mouseAt(card, /printf alpha/).handled, true);
	f.result.details.traces = [traces[1]];
	card.updateResult(f.result);
	f.result.details.traces = traces;
	card.updateResult(f.result);
	assert.doesNotMatch(text(card), /alpha_line_0/);
});

test("notification frames preserve nested choices; explicit empty snapshots clear them", () => {
	const f = fixture();
	const card = hostCard(f);
	assert.equal(mouseAt(card, /nested_result_0\s*$/).handled, true);
	assert.match(text(card), /input_0/);
	card.updateResult({
		content: [{ type: "text", text: "Notification without a trace snapshot" }],
		details: { cellId: "fixture-cell", notification: true },
	}, true);
	assert.match(text(card), /Notification without a trace snapshot/);
	card.updateResult(f.result, true);
	assert.match(text(card), /input_0/);
	assert.doesNotMatch(text(card), /input_1|source_3/);
	card.updateResult({ ...f.result, details: { ...f.result.details, traces: [] } }, true);
	card.updateResult(f.result);
	assert.doesNotMatch(text(card), /input_0/);
});

test("generic nested calls expand independently without a custom renderer", () => {
	const card = hostCard(fixture());
	assert.doesNotMatch(text(card), /input_[0-9]|source_3|output_0/);
	assert.equal(mouseAt(card, /nested_result_1\s*$/).handled, true);
	assert.match(text(card), /input_1/);
	assert.doesNotMatch(text(card), /input_0|input_2|source_3|output_0/);
	assert.equal(mouseAt(card, /nested_result_0\s*$/).handled, true);
	assert.match(text(card), /input_0/);
	assert.match(text(card), /input_1/);
	assert.equal(mouseAt(card, /input_1/).handled, true);
	assert.doesNotMatch(text(card), /input_1|source_3|output_0/);
	assert.match(text(card), /input_0/);
});

test("completed generic calls collapse while another call and the outer script stream", () => {
	const f = fixture();
	f.result.details.traces[0].result.content = [{
		type: "text", text: Array.from({ length: 10 }, (_, i) => `completed_line_${i}`).join("\n"),
	}];
	f.result.details.traces[1].status = "running";
	f.result.details.traces[1].result.content = [{
		type: "text", text: Array.from({ length: 10 }, (_, i) => `active_line_${i}`).join("\n"),
	}];
	const card = hostCard(f);
	card.updateResult(f.result, true);
	assert.doesNotMatch(text(card), /completed_line_0/);
	assert.match(text(card), /active_line_0/);
	assert.match(text(card), /output_0/);
	assert.equal(mouseAt(card, /completed_line_9/).handled, true);
	assert.match(text(card), /completed_line_0/);
	assert.equal(mouseAt(card, /completed_line_0/).handled, true);
	assert.doesNotMatch(text(card), /completed_line_0/);
	assert.match(text(card), /completed_line_9/);
	assert.match(text(card), /active_line_0/);
	assert.match(text(card), /output_0/);
	f.result.details.traces[1].status = "done";
	card.updateResult(f.result, true);
	assert.doesNotMatch(text(card), /completed_line_0|active_line_0/);
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

test("hidden image results do not evict other calls' full renderer output", { timeout: 10_000 }, async (t) => {
	const commandResult = { content: [{ type: "text", text: `${"x".repeat(40_000)}\nFULL_COMMAND_END` }] };
	const imageResult = { content: [{ type: "image", mimeType: "image/png", data: "a".repeat(100_000) }] };
	const command = {
		kind: "function", name: "fixture_command", usage: "fixture_command()", deferLoading: false,
		executionPipeline: "adapter",
		async invoke(_input, context) {
			context.captureResult(commandResult);
			return commandResult;
		},
		renderResult: (result) => new Text(result.content[0].text, 0, 0),
	};
	const viewImage = createViewImageTool();
	const image = {
		kind: "function", name: "view_image", usage: "view_image({ path })", deferLoading: false,
		executionPipeline: "adapter", renderCall: viewImage.renderCall, renderResult: viewImage.renderResult,
		async invoke(_input, context) {
			context.onUpdate(imageResult);
			context.captureResult(imageResult);
			return imageResult;
		},
	};
	const f = fixture([command, image], new CodeModeNestedRenderStore(128 * 1024));
	const card = hostCard(f);
	const runtime = new CodeModeDelegateRuntime(() => {}, f.store);
	t.after(() => runtime.clear());
	runtime.bindCell("cache-cell", {
		cwd: process.env.HOME,
		onUpdate(update) { card.updateResult(update, true); },
	}, new Map([[command.name, command], [image.name, image]]));
	await runtime.invokeDirect("cache-cell", 1, command.name, {});
	assert.match(text(card), /FULL_COMMAND_END/);
	for (const requestId of [2, 3]) {
		const result = await runtime.invokeDirect("cache-cell", requestId, image.name, { path: `/image-${requestId}.png` });
		assert.deepEqual(result, imageResult, "image results must still reach the script unchanged");
		assert.match(text(card), /FULL_COMMAND_END/);
		assert.match(text(card), new RegExp(`image-${requestId}\\.png`));
	}
});

test("nested view_image never draws images; only script-emitted images reach the Pi display", async (t) => {
	const capabilities = getCapabilities();
	t.after(() => setCapabilities(capabilities));
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	const image = {
		type: "image", mimeType: "image/png",
		data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
	};
	const viewImage = createViewImageTool();
	for (const emitted of [false, true]) {
		for (const custom of [false, true]) {
			await t.test(`emitted=${emitted}, custom=${custom}`, () => {
				const f = fixture(custom ? [{
					kind: "function", name: "view_image", invoke() { throw new Error("Rendering only"); },
					renderCall: viewImage.renderCall, renderResult: viewImage.renderResult,
				}] : []);
				const nested = { content: [image], details: { viewImage: true } };
				f.result.content = emitted ? [image] : [{ type: "text", text: "OK" }];
				f.result.details.traces = [{
					id: "image-call", name: "view_image", status: "done", input: { path: "/fixture.png" }, result: nested,
				}];
				const before = emitted && custom ? structuredClone(f.result) : undefined;
				const card = hostCard(f);
				for (const expanded of [false, true]) {
					card.setExpanded(expanded);
					if (custom || expanded) assert.match(text(card), /fixture\.png/);
					if (custom) assert.match(text(card), /Viewed Image/);
					assert.equal(f.output(f.context(expanded)).render(120).join("\n").includes("\x1b_G"), false);
					assert.equal((card.render(120).join("\n").match(/\x1b_G/g) ?? []).length, emitted ? 1 : 0);
				}
				if (emitted && custom) {
					assert.deepEqual(f.result, before, "UI rendering must not change model-visible content or traces");
					f.result.details.traces[0].status = "error";
					f.result.details.traces[0].error = "Unable to load /fixture.png";
					card.updateResult(f.result);
					assert.match(text(card), /Unable to load \/fixture\.png/);
				}
			});
		}
	}
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
