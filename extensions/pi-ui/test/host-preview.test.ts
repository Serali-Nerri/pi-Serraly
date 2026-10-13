import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createCodemodeExtension, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { config } from "../src/config/config.ts";
import { harness, strip, theme } from "./harness.ts";

// Native lazy renderers resolve TUI within coding-agent's development closure.
// Live bundled-CLI class identity is checked separately by runtime integration.
const hostRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { Container } = await import(pathToFileURL(hostRequire.resolve("@earendil-works/pi-tui")).href);

function walk(value: any): any[] {
	return [value, ...(value?.children ?? []).flatMap(walk)];
}

test("Pi 1.2.0 bash VisualLinePreview survives exclusion and off/on transitions", async () => {
	const h = await harness();
	const originalExclusions = config.excludeRenderers;
	const result = { content: [{ type: "text", text: "界".repeat(2_000) }], details: {} };
	try {
		config.excludeRenderers = ["bash"];
		const component = h.tool("bash", "native-preview", { command: "synthetic-only" }, result);
		assert.equal(component.getResultRenderer(), h.definitions.bash.renderResult);
		assert.ok(walk(component.resultRendererComponent).some((child) => child.constructor.name === "VisualLinePreview"));
		for (const width of [40, 80, 120]) {
			const lines = component.render(width);
			assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
			assert.match(lines.map(strip).join("\n"), /earlier lines/);
		}
		config.excludeRenderers = [];
		await h.commands.get("ccstyle").handler("off", h.ctx);
		assert.equal(component.getResultRenderer(), h.definitions.bash.renderResult);
		await h.commands.get("ccstyle").handler("on", h.ctx);
		assert.notEqual(component.getResultRenderer(), h.definitions.bash.renderResult);
		assert.equal(component.result, result, "screen previews never mutate the tool result");
	} finally { config.excludeRenderers = originalExclusions; await h.close(); }
});

test("Pi 1.2.0 dedicated codemode Container/visual previews remain native through all modes", async () => {
	let definition: any;
	await createCodemodeExtension({ models: false })({
		registerTool: (tool: any) => { definition = tool; },
	} as any);
	assert.equal(typeof definition.renderCall, "function");
	const h = await harness();
	h.definitions.codemode = definition;
	h.toolMetadata.set("codemode", {
		name: "codemode", description: definition.description, parameters: definition.parameters, exposure: "direct",
		sourceInfo: { path: "builtin:codemode", source: "builtin", scope: "temporary", origin: "top-level" },
	});
	const result = {
		content: [{ type: "text", text: "Script completed\nWall time 0.01 seconds\nOutput:\n" },
			{ type: "text", text: "界".repeat(2_000) }],
		details: { calls: [], fullOutputPath: "/synthetic/already-returned-output.txt" },
	};
	try {
		const component = h.tool("codemode", "native-container", { code: `return ${JSON.stringify("界".repeat(500))};` }, result);
		for (const mode of ["on", "compact", "off"]) {
			await h.commands.get("ccstyle").handler(mode, h.ctx);
			assert.equal(component.getCallRenderer(), definition.renderCall);
			assert.equal(component.getResultRenderer(), definition.renderResult);
			assert.ok(component.callRendererComponent instanceof Container);
			assert.ok(component.resultRendererComponent instanceof Container);
			assert.ok(walk(component.resultRendererComponent).some((child) => child.constructor.name === "VisualLinePreview"));
			for (const width of [40, 80, 120]) {
				const lines = component.render(width);
				assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
				assert.match(lines.map(strip).join("\n"), /more lines/);
			}
			assert.equal(component.result, result);
		}
	} finally { await h.close(); }
});

test("native codemode progress settles empty output, errors and recorded replay without live timers", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 10_000 });
	let definition: any;
	await createCodemodeExtension({ models: false })({
		registerTool: (tool: any) => { definition = tool; },
	} as any);
	const h = await harness();
	t.mock.timers.tick(0);
	const intervals = t.mock.method(globalThis, "setInterval");
	const clears = t.mock.method(globalThis, "clearInterval");
	const tools: ToolExecutionComponent[] = [];
	const make = (id: string, live = true) => {
		const tool = new ToolExecutionComponent("codemode", id, { code: "return undefined;" },
			{ showImages: false }, definition, h.tui, process.cwd());
		tools.push(tool);
		h.root.addChild(tool);
		if (live) tool.markExecutionStarted();
		return tool;
	};
	const empty = { content: [], details: { calls: [] }, isError: false };
	const frame = (tool: ToolExecutionComponent) => tool.render(80).map(strip).join("\n");
	try {
		const live = make("native-empty-live");
		live.updateResult(empty, true);
		assert.match(frame(live), /Elapsed 0\.0s/);
		assert.doesNotMatch(frame(live), /Script completed|Output:/);
		assert.equal(intervals.mock.callCount(), 1);
		const timer = intervals.mock.calls[0]!.result;
		t.mock.timers.tick(2_000);
		assert.match(frame(live), /Elapsed 2\.0s/, "the native interval refreshes an empty partial result");
		live.updateResult({ ...empty, durationMs: 1_250 });
		assert.match(frame(live), /Took 1\.3s/, "the recorded execution duration wins over the live clock");
		assert.equal(clears.mock.calls.filter((call) => call.arguments[0] === timer).length, 1);
		t.mock.timers.tick(5_000);
		assert.match(frame(live), /Took 1\.3s/);
		assert.equal(intervals.mock.callCount(), 1, "a final empty result never restarts its clock");

		const failed = make("native-error-live");
		failed.updateResult(empty, true);
		const errorTimer = intervals.mock.calls[1]!.result;
		t.mock.timers.tick(1_000);
		failed.updateResult({
			content: [{ type: "text", text: "Script failed\nWall time 0.50 seconds\nOutput:\n" },
				{ type: "text", text: "SYNTHETIC_FAILURE" }],
			details: { calls: [{ name: "fixture", args: "{}", status: "error", error: "SYNTHETIC_FAILURE" }] },
			isError: true, durationMs: 500,
		});
		assert.match(frame(failed), /✗ fixture[\s\S]*SYNTHETIC_FAILURE[\s\S]*Took 0\.5s/);
		assert.doesNotMatch(frame(failed), /Script failed|Output:/);
		assert.ok(failed.render(80).join("\n").includes(theme.fg("error", "SYNTHETIC_FAILURE")));
		assert.equal(clears.mock.calls.filter((call) => call.arguments[0] === errorTimer).length, 1);

		const replay = make("native-recorded-replay", false);
		replay.updateResult({ ...empty, durationMs: 3_600 });
		for (const mode of ["on", "compact", "off"]) {
			await h.commands.get("ccstyle").handler(mode, h.ctx);
			assert.match(frame(replay), /Took 3\.6s/);
			assert.doesNotMatch(frame(replay), /Elapsed/);
		}
		t.mock.timers.tick(10_000);
		assert.equal(intervals.mock.callCount(), 2, "failure and replay leave no new live interval");
		assert.equal(clears.mock.callCount(), 2, "both live native timers were released");
	} finally {
		for (const tool of tools) tool.updateResult(empty);
		await h.close();
	}
});
