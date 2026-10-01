import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createCodemodeExtension } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { config } from "../src/config/config.ts";
import { harness, strip } from "./harness.ts";

// Native lazy renderers resolve TUI within coding-agent's development closure.
// Live bundled-CLI class identity is checked separately by runtime integration.
const hostRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { Container } = await import(pathToFileURL(hostRequire.resolve("@earendil-works/pi-tui")).href);

function walk(value: any): any[] {
	return [value, ...(value?.children ?? []).flatMap(walk)];
}

test("Pi 0.99.2 bash VisualLinePreview survives exclusion and off/on transitions", async () => {
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

test("Pi 0.99.2 dedicated codemode Container/visual previews remain native through all modes", async () => {
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
