import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import installUiGuard from "./fixtures/cli-guard.js";
import { installGuard as installSubagentsGuard } from "./fixtures/cli-fixture.js";

test("CLI guards observe member-owned presentation timers and UI calls, not business timers", async () => {
	const base = await mkdtemp(join(tmpdir(), "serraly-cli-guards-"));
	const release = join(base, "release");
	const uiEntry = join(release, "extensions/pi-ui/dist/index.js");
	const subagentsEntry = join(release, "extensions/pi-subagents/dist/index.js");
	const key = Symbol.for("serraly.runtime-fixture");
	const previousState = globalThis[key];
	const timers = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval };
	const controls = { SERRALY_RELEASE: release, SERRALY_REPORT: join(base, "report.jsonl") };
	const previous = new Map(Object.keys(controls).map((name) => [name, process.env[name]]));
	try {
		await Promise.all([uiEntry, subagentsEntry].map((path) => mkdir(dirname(path), { recursive: true })));
		await writeFile(join(release, "package.json"), '{"type":"module"}\n');
		await writeFile(uiEntry, `
			export function schedulePresentation() {
				const timer = setTimeout(() => {}, 60000);
				clearTimeout(timer);
			}
		`);
		await writeFile(subagentsEntry, `
			export class AgentWidget {
				ensureTimer() {
					const timer = setInterval(() => {}, 60000);
					clearInterval(timer);
				}
			}
			export function businessTimer() {
				const timer = setTimeout(() => {}, 60000);
				clearTimeout(timer);
			}
			export function useUi(ui) { return ui.setStatus("probe", "local"); }
		`);
		Object.assign(process.env, controls);
		const listeners = [];
		const pi = { on(name, listener) { if (name === "session_start") listeners.push(listener); } };
		installUiGuard(pi);
		installSubagentsGuard(pi);
		const forwarded = [];
		const ui = Object.fromEntries(["setWidget", "setHeader", "setFooter", "select", "confirm", "input",
			"notify", "custom", "setStatus", "onTerminalInput", "setTitle", "setWorkingMessage", "setWorkingVisible",
			"setWorkingIndicator", "setHiddenThinkingLabel", "pasteToEditor", "setEditorText", "editor",
			"addAutocompleteProvider", "setEditorComponent", "setTheme", "setToolsExpanded"].map((name) => [
				name, (...args) => { forwarded.push({ name, args }); return "forwarded"; },
			]));
		for (const listener of listeners) listener({}, { mode: "print", ui });
		const state = globalThis[key];
		const moduleUi = await import(pathToFileURL(uiEntry).href);
		const subagents = await import(pathToFileURL(subagentsEntry).href);
		subagents.businessTimer();
		assert.equal(state.timers, 0, "the manager's business timer must not count as presentation");
		moduleUi.schedulePresentation();
		const uiTimers = state.timers;
		new subagents.AgentWidget().ensureTimer();
		const subagentsTimers = state.timers - uiTimers;
		assert.equal(subagents.useUi(ui), "forwarded", "the UI wrapper preserves the delegate's result");
		assert.deepEqual(forwarded, [{ name: "setStatus", args: ["probe", "local"] }]);
		assert.deepEqual({ uiTimers, subagentsTimers, uiCalls: state.uiCalls }, {
			uiTimers: 1, subagentsTimers: 1, uiCalls: [{ name: "setStatus" }],
		});
	} finally {
		Object.assign(globalThis, timers);
		if (previousState === undefined) delete globalThis[key];
		else globalThis[key] = previousState;
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		await rm(base, { recursive: true, force: true });
	}
});
