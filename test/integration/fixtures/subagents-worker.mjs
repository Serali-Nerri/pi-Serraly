import assert from "node:assert/strict";
import { appendFileSync, existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

const host = process.argv[2], scenario = process.argv[3];
const SDK = await import(pathToFileURL(join(host, "dist/index.js")).href);
const require = createRequire(join(host, "package.json"));
const TUI = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href);
// Pi 1.0.2 declares AuthStorage but does not export it from its SDK root.
// TEST ONLY pinned import, always in-memory; no credentials file is read.
const { AuthStorage } = await import(pathToFileURL(join(host, "dist/core/auth-storage.js")).href);
const config = JSON.parse(await readFile(process.env.SERRALY_CONFIG, "utf8"));
const cwd = process.cwd(), agentDir = process.env.PI_CODING_AGENT_DIR;
const provider = join(import.meta.dirname, "subagents-provider.js");
const native = ["builtin:codemode", "builtin:tool-search", "builtin:mcp"];
const report = (phase, extra = {}) => appendFileSync(process.env.SERRALY_REPORT, JSON.stringify({ phase, scenario, ...extra }) + "\n");
const text = (result) => result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
const records = async () => (await readFile(process.env.SERRALY_REPORT, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
async function until(predicate, label, timeout = 10000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		const value = await predicate();
		if (value) return value;
		await new Promise((done) => setTimeout(done, 15));
	}
	assert.fail("bounded wait: " + label);
}
async function json(path, value) { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, JSON.stringify(value)); }
function server(label, extra = {}) {
	return { command: process.execPath, args: [join(import.meta.dirname, "mcp-server.mjs"), JSON.stringify({ label, ...(config.cleanupGate ? { cleanupGate: config.cleanupGate } : {}), ...extra })],
		exposure: config.exposure ?? "deferred", timeout: 15, ...(config.server ?? {}) };
}
async function profile(name, fields = {}) {
	const values = { name, extensions: [...native, provider], skills: false, ...fields };
	if (Array.isArray(values.extensions)) values.extensions = values.extensions.map((item) => item === "PROVIDER" ? provider : item);
	const yaml = Object.entries(values).map(([key, value]) => Array.isArray(value)
		? `${key}: ${value.length ? "\n" + value.map((item) => `  - ${item}`).join("\n") : "[]"}` : `${key}: ${value}`).join("\n");
	await mkdir(join(agentDir, "agents"), { recursive: true });
	await writeFile(join(agentDir, "agents", name + ".md"), `---\n${yaml}\n---\nLocal synthetic fixture.\n`);
}
let modelRuntime, session, target, uiHarness, menuActions = [], uiComponents = new Set();
const errors = [];
let closing;
async function close(reason = "quit") {
	if (closing) return closing;
	closing = (async () => {
		if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason }); session.dispose(); }
		for (const component of uiComponents) component.dispose?.();
	})();
	return closing;
}
async function cleanupOwned() {
	const pids = [...new Set((await records()).filter((item) => item.phase === "mcp-start").map((item) => item.pid))];
	for (const pid of pids.filter(alive)) {
		report("forced-cleanup", { pid });
		try { process.kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
	}
	await until(() => pids.every((pid) => !alive(pid)), "owned MCP fixture cleanup", 3000).catch(() => {
		for (const pid of pids.filter(alive)) { try { process.kill(pid, "SIGKILL"); } catch {} }
	});
}
const deadline = setTimeout(() => { report("worker-deadline"); void cleanupOwned().finally(() => process.exit(9)); }, 55000);

// Observe real timer allocation/cancellation, not manager internals or fake time.
// Native handles still run normally, including refresh/unref and SDK MCP timers.
function observeTimers() {
	const originals = Object.fromEntries(["setTimeout", "setInterval", "clearTimeout", "clearInterval"].map((name) => [name, globalThis[name]]));
	const live = new Map();
	for (const [name, repeat] of [["setTimeout", false], ["setInterval", true]]) {
		globalThis[name] = function track(callback, delay, ...args) {
			const error = {}; Error.captureStackTrace(error, track);
			const caller = error.stack.split("\n")[1] ?? "";
			const owned = caller.includes("/pi-subagents/dist/pi-subagents.js");
			const fixture = caller.includes(import.meta.dirname);
			const nativeCleanup = caller.includes("/pi-mcp/") && caller.includes("stdio.js");
			let kind = nativeCleanup ? "cleanup" : "sdk";
			if (owned) kind = repeat && delay === 5000 ? "watchdog" : repeat && delay === 80 ? "widget" : !repeat && delay === 200 ? "notification" : "cleanup";
			let handle;
			handle = originals[name](function (...values) {
				if (!repeat) live.delete(handle);
				return callback.apply(this, values);
			}, delay, ...args);
			if (!fixture) {
				live.set(handle, { kind, delay, repeat });
				if (owned || nativeCleanup) report("timer-created", { kind, delay, repeat });
			}
			return handle;
		};
	}
	for (const name of ["clearTimeout", "clearInterval"]) globalThis[name] = (handle) => { live.delete(handle); return originals[name](handle); };
	syncBuiltinESMExports();
	return {
		counts() { const counts = { watchdog: 0, widget: 0, notification: 0, cleanup: 0, sdk: 0 }; for (const { kind } of live.values()) counts[kind]++; return counts; },
		restore() { for (const [name, value] of Object.entries(originals)) globalThis[name] = value; syncBuiltinESMExports(); },
	};
}
const timers = scenario === "timer-clear" || scenario === "timer-shutdown" ? observeTimers() : undefined;
function timerCount(point) { const counts = timers.counts(); report("timer-count", { point, ...counts }); return counts; }

async function open() {
	const settingsPath = join(agentDir, "settings.json");
	const settings = JSON.parse(await readFile(settingsPath, "utf8"));
	const ordinary = join(agentDir, "ordinary.js");
	if (config.modelsJsonTransport) {
		await writeFile(ordinary, `import {appendFileSync} from "node:fs";
export default function (pi) {
 const report = (phase) => appendFileSync(process.env.SERRALY_REPORT, JSON.stringify({phase}) + "\\n");
 report("ordinary-factory");
 pi.registerTool({name:"ordinary_effect", label:"ordinary effect", description:"Ordinary extension side effect",
  parameters:{type:"object",properties:{}}, execute:async () => {
   report("ordinary-effect"); return {content:[{type:"text",text:"ordinary-executed"}]};
  }});
}`);
		await json(join(agentDir, "models.json"), { providers: { "serraly-subagents-isolated": {
			api: "serraly-subagents-models-scripted", apiKey: "fixture", baseUrl: "https://example.invalid",
			models: [{ id: "fixture", name: "Isolated local model", reasoning: false, input: ["text"],
				contextWindow: 65536, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		} } });
	}
	modelRuntime = await SDK.ModelRuntime.create({ credentials: AuthStorage.inMemory(),
		modelsPath: config.modelsJsonTransport ? join(agentDir, "models.json") : null,
		modelsStorePath: join(process.env.TMPDIR, "subagents-model-cache.json"), allowModelNetwork: false, refreshOnCreate: false });
	await json(settingsPath, { ...settings, defaultProvider: config.modelsJsonTransport ? "serraly-subagents-isolated" : "serraly-subagents",
		defaultModel: "fixture", ...config.settings,
		extensions: [provider, ...(config.modelsJsonTransport ? [ordinary] : []), ...(config.settings?.extensions ?? [])] });
	await json(join(agentDir, "subagents-lite.json"), { concurrency: { default: config.limit ?? 3 }, agent: {
		loadExtensionsImplicitly: false, loadSkillsImplicitly: false, showCompletionCards: false,
		toolTimeoutMinutes: 0, idleTimeoutMinutes: 0, agentStatusLimit: 100, finishedRetentionMinutes: 1 / 60 } });
	if (config.target) {
		if (config.target === "same-repo") execFileSync("git", ["init", "--quiet", cwd]);
		target = config.target === "same-repo" ? join(cwd, "nested") : join(process.env.TMPDIR, "cross-target");
		await mkdir(target, { recursive: true });
		if (config.target === "cross") execFileSync("git", ["init", "--quiet", target]);
		const protectedExtension = join(target, ".pi/extensions/protected.js");
		await mkdir(join(protectedExtension, ".."), { recursive: true });
		await writeFile(protectedExtension, `import {appendFileSync} from "node:fs"; export default function () { appendFileSync(process.env.SERRALY_REPORT, JSON.stringify({phase:"protected-factory"}) + "\\n"); }`);
		await json(join(target, ".pi/mcp.json"), { mcpServers: { fixture: server("target-project") } });
		if (config.targetTrusted !== undefined) new SDK.ProjectTrustStore(agentDir).set(target, config.targetTrusted);
	}
	await profile("fixture", config.profile);
	if (config.mcp !== false) await json(join(agentDir, "mcp.json"), { mcpServers: { fixture: server("user", config.startupGate ? { startupGate: config.startupGate } : {}) } });
	// Contradictory HOME default sentinels prove the child uses custom agentDir.
	await json(join(process.env.HOME, ".pi/agent/mcp.json"), { mcpServers: { fixture: server("wrong-home") } });
	await json(join(process.env.HOME, ".pi/agent/subagents-lite.json"), { agent: { disableDefaultAgents: true } });
	await writeFile(join(cwd, "seed.txt"), "seed\n");
	if (config.projectSettings) await json(join(cwd, ".pi/settings.json"), config.projectSettings);
	if (config.projectMcp) await json(join(cwd, ".pi/mcp.json"), { mcpServers: { fixture: server("project") } });
	const settingsManager = SDK.SettingsManager.create(cwd, agentDir, { projectTrusted: config.trusted === true });
	const loader = new SDK.DefaultResourceLoader({ cwd, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
		additionalExtensionPaths: [provider, "builtin:codemode", "builtin:tool-search", join(process.env.SERRALY_RELEASE, "extensions/pi-subagents/dist/pi-subagents.js")],
		extensionFactories: [{ name: "codemode", builtin: true, factory: SDK.createCodemodeExtension() },
			{ name: "tool-search", builtin: true, factory: SDK.createToolSearchExtension() }] });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, [], "compiled production entry loads");
	for (const { name, config } of loader.getExtensions().runtime.pendingProviderRegistrations) modelRuntime.registerProvider(name, config);
	const model = modelRuntime.getModel(config.modelsJsonTransport ? "serraly-subagents-isolated" : "serraly-subagents", "fixture");
	assert.ok(model, "scripted provider registered before model selection");
	({ session } = await SDK.createAgentSession({ cwd, agentDir, modelRuntime, model, settingsManager,
		resourceLoader: loader, sessionManager: SDK.SessionManager.inMemory(cwd), thinkingLevel: "off" }));
	await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
	assert.deepEqual(errors, []);
	session.subscribe((event) => {
		if (event.type === "message_start" && event.message.customType === "subagent-result") report("parent-notification", { content: event.message.content });
	});
}
let callId = 0;
async function execute(name, args) {
	const tool = session.getToolDefinition(name);
	assert.ok(tool, "actual compiled tool " + name);
	const id = `runtime-${++callId}`;
	return tool.execute(id, tool.prepareArguments ? tool.prepareArguments(args) : args, undefined, undefined,
		session.extensionRunner.createToolContext(id, undefined));
}
async function spawn(marker, extra = {}) {
	return execute("Agent", { agent: config.agent ?? "fixture", prompt: `SERRALY_PLAN:${marker}`, description: marker,
		...(target ? { worktree_path: target } : {}), ...extra });
}
function select(component, label) {
	for (let i = 0; i < 50; i++) {
		const selected = component.render(220).map(stripVTControlCharacters).find((line) => line.trimStart().startsWith("→"));
		if (selected?.includes(label)) { component.handleInput("\r"); return; }
		component.handleInput("\u001b[B");
	}
	assert.fail("public /agents menu choice not found: " + label);
}
async function mountMenus() {
	if (uiHarness) { session.extensionRunner.setUIContext(uiHarness.context, "tui"); return uiHarness; }
	SDK.initTheme("dark", false);
	const { theme } = await import(pathToFileURL(join(host, "dist/modes/interactive/theme/theme.js")).href);
	const terminal = { columns: 220, rows: 44, write() {}, start() {}, stop() {}, hideCursor() {}, showCursor() {},
		moveBy() {}, clearLine() {}, clearFromCursor() {}, setTitle() {}, drainInput: async () => {} };
	const tui = new TUI.TuiMainScreen(terminal); tui.requestRender = () => {};
	const base = session.extensionRunner.getUIContext();
	const widgets = new Map(), statuses = new Map();
	const context = { ...base, theme,
		notify(message, type) { report("ui-notification", { message, type }); },
		onTerminalInput() { return () => {}; },
		setStatus(key, value) { if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
		setWidget(key, factory) {
			const previous = widgets.get(key); if (previous) uiComponents.delete(previous);
			if (typeof factory === "function") { const component = factory(tui, theme); widgets.set(key, component); uiComponents.add(component); }
			else widgets.delete(key);
		},
		custom(factory) {
			return new Promise((resolve, reject) => {
				let component;
				const done = (value) => { component?.dispose?.(); uiComponents.delete(component); resolve(value); };
				try {
					component = factory(tui, theme, TUI.getKeybindings(), done);
					uiComponents.add(component);
					const action = menuActions.shift();
					queueMicrotask(() => { try { if (action) action(component, done); else done(undefined); } catch (error) { reject(error); } });
				} catch (error) { reject(error); }
			});
		},
	};
	session.extensionRunner.setUIContext(context, "tui");
	uiHarness = { context, widgets, statuses, rows: () => [...widgets.values()].flatMap((component) => component.render(220)).map(stripVTControlCharacters) };
	return uiHarness;
}
async function menu(actions) {
	menuActions = actions;
	const command = session.extensionRunner.getRegisteredCommands().find((item) => item.invocationName === "agents");
	assert.ok(command, "compiled public /agents command");
	await command.handler("", session.extensionRunner.createCommandContext());
	assert.equal(menuActions.length, 0, "all requested public menu interactions occurred");
}
async function clearAll(onCleared) {
	await mountMenus();
	await menu([(component) => select(component, "Running agents"), (component) => select(component, "Clear all")]);
	assert.match(text(await execute("AgentStatus", {})), /No agents running or completed/);
	await onCleared?.();
	if (config.startupGate) await writeFile(config.startupGate, "release");
	const pids = (await records()).filter((item) => item.phase === "mcp-start").map((item) => item.pid);
	await until(() => pids.every((pid) => !alive(pid)), "Clear releases every retained MCP process");
}
async function continueChild(description, marker) {
	await mountMenus();
	await menu([(component) => select(component, "Running agents"), (component, done) => {
		select(component, description); select(component, "View conversation"); done(undefined);
	}, (component, done) => {
		component.handleInput("\r");
		component.handleInput(`SERRALY_PLAN:${marker}`);
		component.handleInput("\r");
		done(undefined);
	}]);
	await until(async () => (await records()).some((item) => item.phase === "plan-complete" && item.marker === marker), "continuation " + marker);
	await until(async () => !/fixture\) running/.test(text(await execute("AgentStatus", {}))), "continuation settled");
}
async function assertNoProcesses() {
	const starts = (await records()).filter((item) => item.phase === "mcp-start");
	await until(() => starts.every((item) => !alive(item.pid)), "parent shutdown releases owned MCP processes");
	const log = await records();
	for (const { pid } of starts) assert.equal(log.filter((item) => item.phase === "mcp-exit" && item.pid === pid).length, 1);
}

try {
	await open();
	if (scenario === "roundtrip" || scenario === "permissions" || scenario === "trust" || scenario === "dynamic") {
		const result = await spawn("main");
		report("agent-result", { text: text(result) });
		if (scenario === "permissions") {
			assert.equal(existsSync(join(cwd, "forbidden-write")), false, "denied writes have no filesystem effect");
			assert.equal(await readFile(join(cwd, "seed.txt"), "utf8"), "seed\n", "denied edit did not mutate seed");
		}
		await close();
		await assertNoProcesses();
	} else if (scenario === "state") {
		const first = await spawn("first"); assert.match(text(first), /mcp-sentinel:user:peek/);
		await continueChild("first", "continued");
		await spawn("sibling");
		await session.prompt("SERRALY_PLAN:parent");
		await clearAll();
	} else if (scenario === "widget-retain") {
		// SDK print mode cannot instantiate the widget. Bind a public TUI-style
		// UI context and lifecycle event; no manager/widget exports are accessed.
		const ui = await mountMenus();
		await session.bindExtensions({ mode: "tui", uiContext: ui.context, onError: (error) => errors.push(error) });
		await session.extensionRunner.emit({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });
		await spawn("first", { description: "retention-row" });
		const retainedStatus = text(await execute("AgentStatus", {}));
		assert.match(retainedStatus, /\(fixture\) completed/);
		const count = async (point) => report("retention-count", { point,
			rows: ui.rows().filter((line) => line.includes("retention-row")).length,
			retained: (text(await execute("AgentStatus", {})).match(/\(fixture\)/g) ?? []).length,
			live: (await records()).filter((item) => item.phase === "mcp-start" && alive(item.pid)).length });
		await until(() => ui.rows().some((line) => line.includes("retention-row")), "finished child row visible in real widget");
		await count("visible");
		await until(() => !ui.widgets.has("agents"), "widget retention expires and unregisters rows");
		assert.equal(text(await execute("AgentStatus", {})), retainedStatus, "public status still contains the same retained record");
		assert.ok(ui.statuses.has("subagents"), "retention hides rows but leaves the status line");
		await count("expired");
		await continueChild("retention-row", "continued");
		assert.equal((await records()).filter((item) => item.phase === "mcp-start").length, 1, "expired-row child continues without reconnect");
		await clearAll();
		await until(() => !ui.widgets.has("agents"), "public Clear removes the widget block");
		await count("cleared");
		assert.equal((await records()).filter((item) => item.phase === "provider-request" && item.sessionId === session.sessionManager.getSessionId()).length, 0, "UI probe never prompts the parent model");
	} else if (scenario === "timer-clear" || scenario === "timer-shutdown") {
		const baseline = timerCount("opened");
		assert.equal(baseline.watchdog, 1, "real compiled manager owns one watchdog timer");
		assert.equal(baseline.notification, 0);
		await spawn("main", { run_in_background: true });
		await until(() => timers.counts().notification === 1, "completed background child has a pending notification timer");
		assert.doesNotMatch(text(await execute("AgentStatus", {})), /\) (running|queued)/);
		timerCount("pending");
		const pendingCleanup = async () => {
			await until(async () => (await records()).some((item) => item.phase === "mcp-exit-waiting"), "owned MCP process waits at graceful cleanup boundary");
			const counts = timerCount("closing");
			assert.ok(counts.cleanup > 0, "real native MCP close has pending escalation timers");
			const live = (await records()).filter((item) => item.phase === "mcp-start" && alive(item.pid)).length;
			assert.equal(live, 1, "removed record still owns a closing MCP process");
			report("cleanup-count", { point: "closing", live });
			await writeFile(config.cleanupGate, "release");
		};
		if (scenario === "timer-clear") {
			await clearAll(pendingCleanup);
			await until(() => timers.counts().notification === 0, "cleared child notification timer drains without delivering");
			assert.deepEqual(timerCount("cleared"), baseline, "Clear retains only the parent's baseline timers");
		} else {
			const shutdown = close();
			await pendingCleanup();
			await shutdown;
			await assertNoProcesses();
		}
		report("cleanup-count", { point: "closed", live: (await records()).filter((item) => item.phase === "mcp-start" && alive(item.pid)).length });
		await close();
		await until(() => Object.values(timers.counts()).every((count) => count === 0), "shutdown clears watchdog, notifications and SDK cleanup timers");
		timerCount("shutdown");
		// Drain the notification window using real time. A forgotten cancel would
		// now send a custom message / trigger a parent model request or UI fallback.
		await new Promise((done) => setTimeout(done, 250));
		const log = await records();
		assert.equal(log.filter((item) => item.phase === "parent-notification" || (item.phase === "ui-notification" && /Subagent/i.test(item.message))).length, 0, "no late subagent notification after Clear/shutdown");
		assert.equal(log.filter((item) => item.phase === "provider-request" && item.sessionId === session.sessionManager.getSessionId()).length, 0, "no stale nudge triggers a parent model request");
		timerCount("settled");
	} else if (scenario === "resources") {
		for (let i = 0; i < 12; i++) await spawn("serial", { description: `serial-${i}` });
		let starts = (await records()).filter((item) => item.phase === "mcp-start");
		assert.equal(starts.length, 12); assert.equal(starts.filter((item) => alive(item.pid)).length, 12);
		assert.doesNotMatch(text(await execute("AgentStatus", {})), /\) running/);
		report("resource-count", { active: 0, retained: 12, live: 12 });
		await clearAll();
		const launched = await Promise.all(Array.from({ length: 4 }, (_, i) => spawn("concurrent", { description: `concurrent-${i}`, run_in_background: true })));
		await until(async () => (await records()).filter((item) => item.phase === "mcp-start").length >= 15, "three active workers started");
		const status = text(await execute("AgentStatus", {}));
		assert.equal((status.match(/\) running/g) ?? []).length, 3); assert.equal((status.match(/\) queued/g) ?? []).length, 1);
		starts = (await records()).filter((item) => item.phase === "mcp-start");
		assert.equal(starts.filter((item) => alive(item.pid)).length, 3);
		report("resource-count", { active: 3, retained: 0, live: 3 });
		await writeFile(config.providerGate, "release");
		await until(async () => !/\) (running|queued)/.test(text(await execute("AgentStatus", {}))), "all queued runs settled");
		assert.equal((await records()).filter((item) => item.phase === "mcp-start" && alive(item.pid)).length, 4);
		report("resource-count", { active: 0, retained: 4, live: 4 });
		assert.equal(launched.length, 4);
		await clearAll();
	} else if (scenario === "stop-retain" || scenario === "late-stop-clear") {
		const result = await spawn("blocked", { run_in_background: true });
		const id = result.details.agentId;
		await until(async () => (await records()).some((item) => item.phase === "mcp-initialize"), "MCP startup reached controlled boundary");
		await execute("StopAgent", { agent_id: id });
		if (config.startupGate && scenario === "stop-retain") await writeFile(config.startupGate, "release");
		if (scenario === "stop-retain") {
			await until(async () => (await records()).some((item) => item.phase === "provider-aborted"), "aborted provider settled");
			assert.equal((await records()).filter((item) => item.phase === "mcp-start" && alive(item.pid)).length, 1);
			await continueChild("blocked", "continued");
			assert.equal((await records()).filter((item) => item.phase === "mcp-start").length, 1, "Stop continuation does not reconnect");
		}
		await clearAll();
	} else if (scenario === "invalid-permission") {
		await assert.rejects(spawn("main"), /MCP wildcard restriction.*unsupported/);
		assert.equal((await records()).filter((item) => item.phase === "mcp-call").length, 0);
	} else if (scenario === "initialization-failure") {
		await json(process.env.SERRALY_CONFIG, { ...config, invalidChildResources: true });
		await assert.rejects(spawn("main"), /Agent failed/);
		assert.equal((await records()).filter((item) => item.phase === "provider-resource-failure").length, 1);
		await assertNoProcesses();
	} else if (scenario === "allocation-race") {
		await json(process.env.SERRALY_CONFIG, { ...config, blockChildFactory: true });
		await spawn("blocked", { run_in_background: true });
		await until(async () => (await records()).some((item) => item.phase === "provider-factory-waiting"), "child factory loading");
		let shutdownFinished = false;
		const shutdown = close().then(() => { shutdownFinished = true; });
		report("shutdown-began");
		await writeFile(config.factoryGate, "release");
		await until(async () => (await records()).some((item) => item.phase === "provider-ready-waiting"), "late allocated session waiting at SDK readiness");
		assert.equal(shutdownFinished, false, "parent cleanup must await late allocation and SDK readiness");
		assert.equal((await records()).filter((item) => item.phase === "mcp-start" && alive(item.pid)).length, 1);
		await writeFile(config.readyGate, "release");
		await shutdown;
		await assertNoProcesses();
	} else if (scenario === "late-shutdown") {
		await spawn("blocked", { run_in_background: true });
		await until(async () => (await records()).some((item) => item.phase === "mcp-initialize"), "MCP blocked before parent shutdown");
		const shutdown = close(config.reason ?? "quit");
		await writeFile(config.startupGate, "release");
		await shutdown;
		await assertNoProcesses();
	} else if (scenario === "shutdown") {
		await spawn("main");
		if (config.reason === "reload") {
			await session.reload();
			await assertNoProcesses();
			assert.match(text(await execute("AgentStatus", {})), /No agents running or completed/);
		} else { await close(config.reason); await close(config.reason); await assertNoProcesses(); }
	} else throw new Error("unknown subagents runtime scenario " + scenario);
	await close();
	assert.deepEqual(errors, [], "SDK extension handlers did not fail");
	assert.ok(!(await records()).some((item) => ["network-denied", "fixture-error", "forced-cleanup"].includes(item.phase)));
	report("complete");
} catch (error) {
	report("worker-error", { error: String(error), stack: error.stack });
	process.exitCode = 1;
} finally {
	try { await close(); } catch (error) { report("cleanup-error", { error: String(error) }); process.exitCode = 1; }
	await cleanupOwned();
	clearTimeout(deadline);
	timers?.restore();
}
