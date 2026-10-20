import assert from "node:assert/strict";
import { ToolExecutionComponent, CustomMessageComponent, VERSION } from "@earendil-works/pi-coding-agent";
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
// Loaded before the release factories. The inventory/provider extension below
// remains last, so shutdown assertions run after all module cleanup handlers.
export function installGuard(pi) {
	const state = globalThis[Symbol.for("serraly.runtime-fixture")];
	for (const name of ["setTimeout", "setInterval"]) {
		const original = globalThis[name];
		globalThis[name] = (...args) => {
			const stack = new Error().stack;
			// The manager watchdog is a business timer and valid in every mode.
			// Qualify presentation timers, not every timer in the shared bundle.
			if (stack.includes(process.env.SERRALY_RELEASE + "/extensions/pi-subagents/dist/") &&
				/AgentWidget\.ensureTimer|ConversationViewer\.scheduleRender|createNavInputHandler/.test(stack)) {
				state.timers++;
				report("subagents-ui-timer", { name, stack });
			}
			return original(...args);
		};
	}
	pi.on("session_start", (_event, ctx) => {
		for (const name of ["select", "confirm", "input", "notify", "custom", "setStatus", "onTerminalInput",
			"setTitle", "setWorkingMessage", "setWorkingVisible", "setWorkingIndicator", "setHiddenThinkingLabel",
			"pasteToEditor", "setEditorText", "editor", "addAutocompleteProvider", "setEditorComponent", "setTheme", "setToolsExpanded"]) {
			const original = ctx.ui[name];
			ctx.ui[name] = function (...args) {
				if (new Error().stack.includes(process.env.SERRALY_RELEASE + "/extensions/pi-subagents/dist/")) state.uiCalls.push({ name });
				return original.apply(this, args);
			};
		}
	});
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
		const exposures = { grep: "codemode", find: "codemode", ls: "codemode",
			bg_run: "codemode", bg_status: "codemode", bg_logs: "codemode", bg_kill: "codemode",
			Agent: "direct", StopAgent: "direct", MessageAgent: "direct", AgentStatus: "direct", ask_user_question: "codemode", imagegen: "direct" };
		for (const tool of ours) {
			const exposure = exposures[tool.name] ?? "deferred";
			assert.equal(tool.exposure, exposure);
			assert.equal(pi.getActiveTools().includes(tool.name), exposure === "direct" || exposure === "model-only",
				"direct and model-only tools are initially active");
		}
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
			// Mount the module's REAL question dialog through the host custom UI;
			// drive Enter on it, never replace the dialog's answer with a mock.
			const original = ctx.ui.custom;
			ctx.ui.custom = (factory, options) => original((tui, theme, keys, done) => {
				const component = factory(tui, theme, keys, done);
				queueMicrotask(() => component.handleInput?.("\r"));
				return component;
			}, options);
			pi.setActiveTools([...pi.getActiveTools(), "bg_status"]);
		}
		report("session-start", { mode: ctx.mode, uiCalls: state.uiCalls, timers: state.timers });
	});
	pi.on("before_agent_start", () => {
		if (config.tui && !state.resultMessageSent) {
			state.resultMessageSent = true;
			pi.sendMessage({ customType: "subagent-result", content: "Local synthetic completion",
				details: { type: "general-purpose", description: "Dedicated local completion card" }, display: true });
		}
	});
	pi.on("tool_result", (event) => {
		const text = event.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
		if (event.toolName === "Agent") { assert.equal(event.isError, true); assert.match(text, /Unknown agent type: no-such-agent/); }
		if (event.toolName === "StopAgent") { assert.equal(event.isError, true); assert.match(text, /Agent missing not found/); }
	});
	pi.on("agent_end", (_event, ctx) => {
		if (ctx.mode === "tui") {
			const rows = walk(state.tui).filter((component) => component instanceof ToolExecutionComponent);
			assert.equal(rows.length, 6, "six genuine agent tool executions created six host-owned rows");
			const names = rows.map((row) => row.toolName).sort();
			assert.deepEqual(names, ["Agent", "StopAgent", "bg_status", "codemode", "read", "write"]);
			for (const row of rows) {
				assert.equal(Object.getPrototypeOf(row), state.toolPrototype, "live host ToolExecutionComponent instance identity");
				for (const width of [40, 80, 120]) for (const line of row.render(width)) assert.ok(visibleWidth(line) <= width);
				if (["Agent", "StopAgent", "bg_status"].includes(row.toolName)) {
					assert.equal(row.getCallRenderer(), row.toolDefinition.renderCall, "dedicated call renderer protected: " + row.toolName);
					assert.equal(row.getResultRenderer(), row.toolDefinition.renderResult, "dedicated result renderer protected: " + row.toolName);
					assert.notEqual(row[Symbol.for("claude-style-tools.component-tool-render-mode")], true, "no generic group/background takeover");
				}
			}
			const completion = walk(state.tui).find((component) => component instanceof CustomMessageComponent &&
				component.render(120).join("\n").includes("Dedicated local completion card"));
			assert.ok(completion, "live host custom message uses the real subagent-result renderer");
			assert.match(completion.render(120).join("\n"), /Subagent Result/);
			const read = rows.find((row) => row.toolName === "read");
			assert.equal(read[Symbol.for("claude-style-tools.component-tool-render-mode")], true, "positive control: built-in read is styled");
			assert.equal(readFileSync(join(ctx.cwd, "boundary.txt"), "utf8"), "first\nsecond\n");
			report("host-identity", { names, tuiClass: state.tui.constructor.name, tuiMode: state.tui.mode,
				fullscreen: state.tui instanceof TuiAltScreen,
				renderer: "subagent-result", fixtureScope: "compiled subagents; invalid calls do not spawn" });
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
