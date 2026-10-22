import assert from "node:assert/strict";
import { ToolExecutionComponent, VERSION } from "@earendil-works/pi-coding-agent";
import { TuiMainScreen, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerScriptedProvider, report } from "./scripted-provider.js";
import { toolsByName, commandsByName } from "./contracts.mjs";
function walk(root) {
	const seen = new Set(), queue = [root];
	while (queue.length) {
		const value = queue.shift();
		if (!value || typeof value !== "object" || seen.has(value)) continue;
		seen.add(value);
		queue.push(...(value.children || []));
		for (const name of ["child", "content", "contentContainer", "scrollView", "root"]) queue.push(value[name]);
	}
	return [...seen];
}
export default function (pi) {
	const state = globalThis[Symbol.for("serraly.runtime-fixture")];
	assert.ok(state); assert.equal(VERSION, "1.3.0");
	const config = JSON.parse(readFileSync(process.env.SERRALY_CONFIG, "utf8"));
	registerScriptedProvider(pi, state);
	pi.on("session_start", async (_event, ctx) => {
		assert.deepEqual(pi.getCommands().map((command) => command.name).sort(), Object.values(commandsByName).flat().sort());
		const ours = pi.getAllTools().filter((tool) => Object.values(toolsByName).flat().includes(tool.name));
		assert.deepEqual(ours.map((tool) => tool.name).sort(), Object.values(toolsByName).flat().sort());
		assert.ok(pi.getActiveTools().includes("tool_search"));
		if (ctx.mode !== "tui") {
			state.unpatched(); assert.equal(state.timers, 0); assert.deepEqual(state.uiCalls, []);
		} else {
			const patch = globalThis[Symbol.for("claude-style-tools.global-tool-render-patch")];
			assert.equal(patch.prototype, ToolExecutionComponent.prototype, "compiled UI patches HOST class, not a workspace copy");
			assert.equal(patch.installed.getCallRenderer, ToolExecutionComponent.prototype.getCallRenderer);
			await ctx.ui.custom((tui, _theme, _keys, done) => {
				assert.ok(tui instanceof TuiMainScreen || tui instanceof TuiAltScreen, "shared bundled CLI TUI identity");
				state.tui = tui; queueMicrotask(() => done(undefined));
				return { render: () => [], invalidate() {} };
			});
		}
		report("session-start", { mode: ctx.mode, uiCalls: state.uiCalls, timers: state.timers });
	});
	pi.on("agent_end", (_event, ctx) => {
		if (ctx.mode === "tui") {
			const rows = walk(state.tui).filter((component) => component instanceof ToolExecutionComponent);
			assert.equal(rows.length, 2, "two genuine agent tool executions created two host-owned rows");
			const names = rows.map((row) => row.toolName).sort();
			assert.deepEqual(names, ["read", "write"]);
			for (const row of rows) {
				assert.equal(Object.getPrototypeOf(row), state.toolPrototype, "live host ToolExecutionComponent instance identity");
				for (const width of [40, 80, 120]) for (const line of row.render(width)) assert.ok(visibleWidth(line) <= width);
			}
			const read = rows.find((row) => row.toolName === "read");
			assert.equal(read[Symbol.for("claude-style-tools.component-tool-render-mode")], true, "positive control: built-in read is styled");
			assert.equal(readFileSync(join(ctx.cwd, "boundary.txt"), "utf8"), "first\nsecond\n");
			report("host-identity", { names, tuiClass: state.tui.constructor.name, tuiMode: state.tui.mode,
				fullscreen: state.tui instanceof TuiAltScreen });
		} else { state.unpatched(); assert.equal(state.timers, 0); }
	});
	pi.on("agent_settled", () => {
		assert.ok(state.providerCalls > 0);
		assert.deepEqual(state.instrumentation, { payload: state.providerCalls, response: state.providerCalls, stream: state.providerCalls }, "scripted provider fulfills all request instrumentation hooks");
		report("settled", { providerCalls: state.providerCalls, instrumentation: state.instrumentation });
	});
	pi.on("session_shutdown", () => {
		state.unpatched();
		report("shutdown", { mode: state.mode, uiCalls: state.uiCalls, timers: state.timers, providerCalls: state.providerCalls });
	});
}
