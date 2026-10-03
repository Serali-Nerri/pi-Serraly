import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, realpath, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import childProcess from "node:child_process";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { entries, toolsByEntry, commandsByEntry, questionArgs, patchInput } from "./contracts.mjs";

const host = process.argv[2], scenario = process.argv[3];
const SDK = await import(pathToFileURL(join(host, "dist/index.js")).href);
const require = createRequire(join(host, "package.json"));
const TUI = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href);
// Pi 1.0.0 declares this API but does not export it from the SDK root. This
// private, pinned import is TEST ONLY; no credentials path is ever consulted.
const { AuthStorage } = await import(pathToFileURL(join(host, "dist/core/auth-storage.js")).href);
const config = JSON.parse(await readFile(process.env.SERRALY_CONFIG, "utf8"));
const cwd = process.cwd(), agentDir = process.env.PI_CODING_AGENT_DIR, release = process.env.SERRALY_RELEASE;
const allIndices = entries.map((_, index) => index);
const baseline = Object.fromEntries(["getCallRenderer", "getResultRenderer", "getRenderShell", "updateDisplay"].map((name) => [name, SDK.ToolExecutionComponent.prototype[name]]));
const report = (phase, extra = {}) => import("node:fs").then(({ appendFileSync }) => appendFileSync(process.env.SERRALY_REPORT, JSON.stringify({ phase, ...extra }) + "\n"));
const credentials = AuthStorage.inMemory();
const modelRuntime = await SDK.ModelRuntime.create({ credentials, modelsPath: null,
	modelsStorePath: join(process.env.TMPDIR, "models-cache.json"), allowModelNetwork: false, refreshOnCreate: false });

async function open(indices = config.indices ?? allIndices, packageFilter = config.packageFilter, discoverSettings = false) {
	if (packageFilter !== undefined) {
		// PackageManager reads persisted global/project resource settings, not
		// SettingsManager's transient merged overrides. Exercise real settings.
		const path = join(agentDir, "settings.json");
		const settings = JSON.parse(await readFile(path, "utf8"));
		settings.packages = [{ source: release, extensions: packageFilter }];
		await writeFile(path, JSON.stringify(settings));
	}
	const settingsManager = SDK.SettingsManager.create(cwd, agentDir);
	const eventBus = SDK.createEventBus();
	const loader = new SDK.DefaultResourceLoader({ cwd, agentDir, settingsManager, eventBus,
		noExtensions: !discoverSettings && packageFilter === undefined, noSkills: false, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalExtensionPaths: [join(import.meta.dirname, "sdk-provider.js"), "builtin:tool-search", "builtin:codemode",
			...(!discoverSettings && packageFilter === undefined ? indices.map((index) => join(release, entries[index])) : [])],
		extensionFactories: [{ name: "tool-search", builtin: true, factory: SDK.createToolSearchExtension() },
			{ name: "codemode", builtin: true, factory: SDK.createCodemodeExtension() }],
	});
	await loader.reload();
	const loaded = loader.getExtensions();
	assert.deepEqual(loaded.errors, [], "actual loader resolves compiled entry and lazy/native closure");
	assert.deepEqual(loader.getSkills().skills, [], "package does not activate the docparser companion skill");
	for (const { name, config } of loaded.runtime.pendingProviderRegistrations) modelRuntime.registerProvider(name, config);
	const model = modelRuntime.getModel("serraly-fixture", "fixture");
	assert.ok(model);
	const { session } = await SDK.createAgentSession({ cwd, agentDir, modelRuntime, model,
		resourceLoader: loader, settingsManager, sessionManager: SDK.SessionManager.inMemory(cwd), thinkingLevel: "off" });
	const errors = [];
	await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
	assert.deepEqual(errors, []);
	return { session, loader, eventBus, errors, model, async close() {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
		assert.deepEqual(errors, []);
		for (const [name, method] of Object.entries(baseline)) assert.equal(SDK.ToolExecutionComponent.prototype[name], method, "host prototype restored: " + name);
	} };
}

function inventory(h, indices) {
	const extensions = h.loader.getExtensions().extensions.filter((extension) => extension.path.startsWith(release));
	assert.equal(extensions.length, indices.length, "each manifest entry loads exactly once");
	const registeredTools = extensions.flatMap((extension) => [...extension.tools.keys()]).sort();
	const expectedTools = indices.flatMap((index) => toolsByEntry[index]).sort();
	assert.deepEqual(registeredTools, expectedTools);
	assert.equal(new Set(registeredTools).size, registeredTools.length, "no duplicate tool registration");
	const commands = h.session.extensionRunner.getRegisteredCommands().map((command) => command.invocationName).sort();
	assert.deepEqual(commands, indices.flatMap((index) => commandsByEntry[index]).sort());
	assert.equal(new Set(commands).size, commands.length, "no duplicate commands");
	const active = h.session.getActiveToolNames();
	assert.ok(active.includes("tool_search"), "builtin discovery remains enabled by +tool_search");
	for (const name of ["read", "bash", "edit", "write"]) assert.ok(active.includes(name), "+tool_search retains default built-ins");
	const exposures = { apply_patch: "direct", grep: "codemode", find: "codemode", ls: "codemode",
		Agent: "direct", StopAgent: "direct", AgentStatus: "direct" };
	for (const tool of h.session.getAllTools().filter((tool) => expectedTools.includes(tool.name))) {
		const exposure = exposures[tool.name] ?? "deferred";
		assert.equal(tool.exposure, exposure);
		assert.equal(active.includes(tool.name), exposure === "direct", "only direct tools are initially active");
	}
	const subagents = extensions.find((extension) => extension.path.endsWith("/pi-subagents/index.js"));
	assert.equal(extensions.filter((extension) => extension.messageRenderers.has("subagent-result")).length, subagents ? 1 : 0,
		"only the enabled subagents entry registers subagent-result");
	assert.equal(h.session.extensionRunner.getMessageRenderer("subagent-result"), subagents?.messageRenderers.get("subagent-result"),
		"subagents owns its dedicated message renderer, independently of root UI");
	for (const [name, method] of Object.entries(baseline)) assert.equal(SDK.ToolExecutionComponent.prototype[name], method, "non-TUI remains unpatched");
}

let callId = 0;
async function execute(h, name, args, signal, onUpdate) {
	// Public SDK tool definition, compiled factory, real extension tool context.
	// This deliberately does not claim to exercise model-generated validation.
	const tool = h.session.getToolDefinition(name);
	assert.ok(tool, "registered compiled tool " + name);
	const id = `integration-${++callId}`;
	return tool.execute(id, tool.prepareArguments ? tool.prepareArguments(args) : args, signal, onUpdate,
		h.session.extensionRunner.createToolContext(id, signal));
}

async function until(predicate, label, timeout = 5000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const value = await predicate();
		if (value) return value;
		await new Promise((done) => setTimeout(done, 15));
	}
	assert.fail("bounded wait exceeded: " + label);
}
function eventOnce(bus, channel, predicate, timeout = 8000) {
	let off, timer;
	const promise = new Promise((done, reject) => {
		off = bus.on(channel, (event) => { if (predicate(event)) { clearTimeout(timer); off(); done(event); } });
		timer = setTimeout(() => { off(); reject(new Error("bounded event deadline: " + channel)); }, timeout);
	});
	// A launch/reload assertion can fail before awaiting completion. Never leave
	// an unhandled rejection behind while failure cleanup runs.
	void promise.catch(() => {});
	return { promise, cancel() { clearTimeout(timer); off(); } };
}
function pidExists(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } }
async function status(h, taskId) { return (await execute(h, "bg_status", { taskId })).details.tasks[0]; }

async function contracts(h) {
	const patch = h.session.getToolDefinition("apply_patch");
	assert.equal(patch.exposure, "direct");
	assert.deepEqual(JSON.parse(JSON.stringify(patch.parameters)), { type: "object", properties: {
		input: { description: "The complete *** Begin Patch ... *** End Patch text", type: "string" },
	}, required: ["input"], additionalProperties: false });
	assert.equal(patch.promptSnippet, "Apply patches to add, update, delete, or move files");
	assert.deepEqual(patch.promptGuidelines, [
		"Use apply_patch for file changes; inspect existing text before constructing update chunks.",
		"apply_patch: @@ context anchors are text, not line numbers. Keep chunks in source order and include enough context to target the intended occurrence.",
	]);
	assert.equal(patch.constrainedSampling.type, "grammar");
	assert.match(patch.constrainedSampling.variants.openai_lark, /\*\*\* Begin Patch/);
	const original = { parameters: JSON.stringify(patch.parameters), description: patch.description,
		promptSnippet: patch.promptSnippet, promptGuidelines: [...patch.promptGuidelines],
		grammar: JSON.stringify(patch.constrainedSampling), execute: patch.execute, exposure: patch.exposure };
	const result = await execute(h, "apply_patch", { input: patchInput });
	assert.equal(await readFile(join(cwd, "boundary.txt"), "utf8"), "first\nsecond\n");
	assert.deepEqual(result.content, [{ type: "text", text: "Success. Updated the following files:\nA boundary.txt" }]);
	assert.equal(result.details.format, "apply_patch.v1");
	assert.equal(result.details.changes[0].views[0].added, 2);
	assert.equal(result.details.changes[0].views[0].removed, 0);
	const frozen = structuredClone(result);
	await writeFile(join(cwd, "boundary.txt"), "newer content must not change historical diff\n");
	// Same-name search replacements stay inactive but codemode-callable.
	const codemode = h.session.getToolDefinition("codemode");
	assert.ok(codemode, "codemode extension is loaded");
	const codemodeDescription = h.session.agent.state.tools.find((tool) => tool.name === "codemode").description;
	for (const name of ["grep", "find", "ls"]) {
		assert.equal(h.session.getToolDefinition(name).exposure, "codemode");
		assert.ok(!h.session.getActiveToolNames().includes(name));
		assert.ok(h.session.getCallableToolNames().includes(name));
		assert.match(codemodeDescription, new RegExp("### `" + name + "`"));
	}
	await writeFile(join(cwd, "codemode-listing.txt"), "codemode listing marker\n");
	// Nested tool calls require the assistant message that would have issued them.
	h.session.agent.state.messages.push({ role: "assistant", content: [], api: h.model.api, provider: h.model.provider, model: h.model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse", timestamp: Date.now() });
	const listing = await execute(h, "codemode", { code: `const [ls, grep] = await Promise.all([
		tools.ls({}), tools.grep({pattern: "codemode listing marker"})]);
	const find = ALL_TOOLS.find((tool) => tool.name === "find");
	text({ls, grep, find: find && find.name});` });
	const listingText = listing.content.map((part) => part.type === "text" ? part.text : "").join("\n");
	assert.match(listingText, /codemode-listing\.txt/);
	assert.match(listingText, /codemode-listing\.txt:1: codemode listing marker/);
	assert.match(listingText, /"find":"find"/);
	const q = h.session.getToolDefinition("AskUserQuestion");
	assert.equal(q.executionMode, "sequential");
	assert.equal(q.namespace.name, "questions");
	assert.deepEqual(q.parameters.required, ["questions"]);
	assert.equal(q.parameters.properties.questions.minItems, 1);
	assert.equal(q.parameters.properties.questions.maxItems, 4);
	assert.deepEqual(q.parameters.properties.questions.items.required, ["question", "header", "options"]);
	assert.equal(q.parameters.properties.questions.items.properties.header.maxLength, 12);
	assert.equal(q.parameters.properties.questions.items.properties.options.minItems, 2);
	assert.equal(q.parameters.properties.questions.items.properties.options.maxItems, 4);
	const nonTui = await execute(h, "AskUserQuestion", questionArgs);
	assert.deepEqual(nonTui.details, { questions: questionArgs.questions, answers: {} });
	assert.deepEqual(nonTui.content, [{ type: "text", text: "Error: AskUserQuestion requires the interactive TUI; no answer was collected. Ask the user in plain text instead." }]);
	await assert.rejects(execute(h, "AskUserQuestion", { questions: [{ ...questionArgs.questions[0], options: [questionArgs.questions[0].options[0]] }] }), /must have 2-4 options/);
	const ui = await mount(h);
	try {
		const ctx = h.session.extensionRunner.createCommandContext();
		for (const mode of ["compact", "off", "on"]) {
			await command(h, "ccstyle").handler(mode, ctx);
			const current = h.session.getToolDefinition("apply_patch");
			assert.equal(current, patch, "UI never re-registers the execute/schema contract");
			assert.equal(current.execute, original.execute);
			assert.equal(JSON.stringify(current.parameters), original.parameters);
			assert.equal(current.description, original.description);
			assert.equal(current.promptSnippet, original.promptSnippet);
			assert.deepEqual(current.promptGuidelines, original.promptGuidelines);
			assert.equal(JSON.stringify(current.constrainedSampling), original.grammar);
			assert.equal(current.exposure, original.exposure);
			if (mode === "off") {
				await execute(h, "apply_patch", { input: "*** Begin Patch\n*** Add File: ui-off.txt\n+tools still execute\n*** End Patch" });
				assert.equal(await readFile(join(cwd, "ui-off.txt"), "utf8"), "tools still execute\n", "ccstyle off only affects presentation");
			}
			const row = new SDK.ToolExecutionComponent("apply_patch", "history", { input: patchInput }, undefined, patch, ui.tui, cwd);
			row.updateResult({ ...result, isError: false }); row.setExpanded(true); row.render(80);
			assert.deepEqual(result, frozen, "UI does not mutate model result or immutable patch report");
		}
		ui.nextAction = (component) => { component.handleInput("\u001b[B"); component.handleInput("\r"); };
		const answered = await execute(h, "AskUserQuestion", questionArgs);
		assert.deepEqual(answered.details, { questions: questionArgs.questions,
			answers: { "Which local database?": "Postgres" }, annotations: { "Which local database?": { preview: "SELECT 1;" } } });
		assert.equal(answered.content[0].text, 'Your questions have been answered: "Which local database?"="Postgres" selected preview:\nSELECT 1;. You can now continue with these answers in mind.');
		ui.nextAction = (component) => component.handleInput("\u001b");
		const cancelled = await execute(h, "AskUserQuestion", questionArgs);
		assert.deepEqual(cancelled.details, { questions: questionArgs.questions, answers: {}, cancelled: true });
	} finally { ui.dispose(); }
}

function command(h, name) {
	const found = h.session.extensionRunner.getRegisteredCommands().find((item) => item.invocationName === name);
	assert.ok(found, "command /" + name); return found;
}
async function mount(h) {
	SDK.initTheme("dark", false);
	const { theme } = await import(pathToFileURL(join(host, "dist/modes/interactive/theme/theme.js")).href);
	const terminal = { columns: 120, rows: 44, write() {}, start() {}, stop() {}, hideCursor() {}, showCursor() {},
		moveBy() {}, clearLine() {}, clearFromCursor() {}, setTitle() {}, drainInput: async () => {} };
	const tui = new TUI.TuiMainScreen(terminal);
	tui.requestRender = () => {};
	const mounted = new Map(), statuses = new Map(), interactions = [];
	const editor = new TUI.Input(); tui.setFocus(editor);
	const state = { tui, editor, mounted, statuses, interactions, nextAction: undefined, dispose() { for (const component of mounted.values()) component.dispose?.(); } };
	const ui = { ...h.session.extensionRunner.getUIContext(), theme,
		getToolsExpanded: () => false, getThinkingVisible: () => false, getEditorText: () => "", setEditorText() {},
		onTerminalInput: () => () => {}, requestRender() {}, setTitle() {}, notify() {},
		setStatus(key, value) { if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
		setWidget(key, factory) { if (!factory) mounted.delete(key); else if (typeof factory === "function") mounted.set(key, factory(tui, theme)); },
		setHeader(factory) { if (!factory) mounted.delete("header"); else mounted.set("header", factory(tui, theme)); },
		setFooter(factory) {
			mounted.get("footer")?.dispose?.();
			if (!factory) mounted.delete("footer");
			else mounted.set("footer", factory(tui, theme, { onBranchChange: () => () => {},
				getExtensionStatuses: () => statuses, getGitBranch: () => undefined }));
		},
		custom(factory, options = {}) {
			return new Promise((resolve) => {
				let component, handle;
				const done = (value) => { if (handle) handle.hide(); else tui.setFocus(editor); component?.dispose?.(); resolve(value); };
				component = factory(tui, theme, {}, done);
				if (options.overlay) handle = tui.showOverlay(component, options.overlayOptions);
				else tui.setFocus(component);
				interactions.push({ component, options, handle });
				for (const width of [40, 80, 120]) for (const line of component.render(width))
					assert.ok(TUI.visibleWidth(line) <= width, "real component fits synthetic terminal width " + width);
				const action = state.nextAction; state.nextAction = undefined;
				queueMicrotask(() => { if (action) action(component, handle); else done(undefined); });
			});
		},
	};
	await h.session.bindExtensions({ uiContext: ui, mode: "tui", onError: (error) => h.errors.push(error) });
	return state;
}

async function background(h) {
	const terminalChannel = "pi-background-shell:terminal:v2";
	let taskId;
	const completion = eventOnce(h.eventBus, terminalChannel, (frame) => frame.task.id === taskId);
	const launched = (await execute(h, "bg_run", { name: "Short local command", command: `node -e ${JSON.stringify('process.stdout.write("local-bg-ok\\n")')}`,
		notifyOnCompletion: true, triggerOnCompletion: false })).details.task;
	taskId = launched.id;
	try {
		const event = await completion.promise;
		assert.equal(event.schema_version, "pi-background-shell.extension-terminal.v2");
		assert.equal(event.task.status, "completed"); assert.equal(event.task.exitCode, 0);
		const done = await status(h, taskId); assert.equal(done.pid, launched.pid);
		assert.match(done.outputPath, /^\.pi\/tasks\//);
		assert.equal(await readFile(join(cwd, done.outputPath), "utf8"), "local-bg-ok\n");
		const logs = await execute(h, "bg_logs", { taskId, maxBytes: 5, tail: true });
		assert.match(logs.content[0].text, /g-ok/);
		const notifications = () => h.session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "background-task-notification" && entry.details.id === taskId);
		await until(() => notifications().length === 1, "completion notification persisted");
		assert.equal(notifications()[0].details.status, "completed");
	} finally { completion.cancel(); }
	const survivor = (await execute(h, "bg_run", { name: "Semaphore survivor",
		command: `node -e ${JSON.stringify('const fs=require("node:fs");process.stdout.write("READY\\n");const t=setInterval(()=>{if(fs.existsSync("finish-bg")){clearInterval(t);process.stdout.write("AFTER\\n");process.exit(0)}},20);setTimeout(()=>process.exit(9),12000)')}`,
		surviveReload: true, notifyOnCompletion: false, triggerOnCompletion: false })).details.task;
	const survivorCompletion = eventOnce(h.eventBus, terminalChannel, (frame) => frame.task.id === survivor.id, 15000);
	try {
		await until(async () => (await execute(h, "bg_logs", { taskId: survivor.id })).content[0].text.includes("READY"), "survivor started");
		await h.session.reload();
		const fresh = await status(h, survivor.id);
		assert.equal(fresh.status, "running"); assert.equal(fresh.pid, survivor.pid); assert.equal(fresh.outputPath, survivor.outputPath);
		assert.equal(fresh.reloadSurvival.launchNonce, survivor.reloadSurvival.launchNonce);
		assert.equal(fresh.reloadSurvival.handoffCount, 1);
		await writeFile(join(cwd, "finish-bg"), "finish");
		const done = (await survivorCompletion.promise).task;
		assert.equal(done.status, "completed"); assert.equal(done.exitCode, 0);
		assert.equal(await readFile(join(cwd, done.outputPath), "utf8"), "READY\nAFTER\n");
	} finally { survivorCompletion.cancel(); }
	const killTask = (await execute(h, "bg_run", { name: "Stop local task", command: 'node -e "setInterval(()=>{},1000)"',
		notifyOnCompletion: false, triggerOnCompletion: false })).details.task;
	const killed = (await execute(h, "bg_kill", { taskId: killTask.id })).details.task;
	assert.equal(killed.status, "killed");
	await until(() => !pidExists(killTask.pid), "bg_kill released local process");
	const cleanup = (await execute(h, "bg_run", { name: "Shutdown local task", command: 'node -e "setInterval(()=>{},1000)"',
		notifyOnCompletion: false, triggerOnCompletion: false })).details.task;
	await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	await until(() => !pidExists(cleanup.pid), "session_shutdown released default child");
}

async function documents(h) {
	const path = join(import.meta.dirname, "minimal.pdf");
	// Instrument the OS boundary, not LiteParse or the production executor. Every
	// successful result below is produced by the real installed native binding.
	const originalSpawn = childProcess.spawn;
	const workers = []; let intervention;
	childProcess.spawn = function (...args) {
		const child = originalSpawn.apply(this, args);
		if (args[1]?.some((argument) => argument.endsWith("/native-worker.mjs"))) {
			workers.push(args[1].find((argument) => argument.endsWith("/native-worker.mjs")));
			const action = intervention; intervention = undefined;
			if (action) child.once("spawn", () => action(child));
		}
		return child;
	};
	syncBuiltinESMExports();
	try {
		const parsed = await execute(h, "document_parse", { path, format: "json", ocr: "off", maxPages: 1, numWorkers: 1, dpi: 72 });
		assert.equal(parsed.details.pageCount, 1);
		assert.equal(JSON.parse(await readFile(parsed.details.outputPath, "utf8")).text, "Hello Pi");
		assert.ok(parsed.details.outputPath.startsWith(process.env.TMPDIR + "/"));
		const found = await execute(h, "document_search", { path, phrase: "Hello", ocr: "off", maxPages: 1, maxResults: 1, numWorkers: 1, dpi: 72 });
		assert.equal(found.details.hits.length, 1); assert.equal(found.details.hits[0].text, "Hello");
		assert.equal(found.details.hits[0].pageNum, 1); assert.equal(found.details.truncatedByCount, false);
		const screenshot = await execute(h, "document_screenshot", { path, pages: "1", dpi: 72 });
		assert.equal(screenshot.details.screenshots.length, 1);
		const image = screenshot.content.find((item) => item.type === "image");
		assert.equal(image.mimeType, "image/png");
		assert.deepEqual(Buffer.from(image.data, "base64").subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
		assert.ok((await stat(screenshot.details.screenshots[0].outputPath)).size > 8);
		const aborted = new AbortController(); intervention = () => aborted.abort();
		await assert.rejects(execute(h, "document_parse", { path, ocr: "off" }, aborted.signal), /cancel|abort/i);
		intervention = (child) => child.kill("SIGKILL");
		await assert.rejects(execute(h, "document_parse", { path, ocr: "off" }), /worker|signal|crash/i);
		const recovered = await execute(h, "document_search", { path, phrase: "Pi", ocr: "off", dpi: 72 });
		assert.equal(recovered.details.hits[0].text, "Pi", "worker failure does not terminate Pi or poison FIFO executor");
		assert.ok(workers.length >= 6, "native cancellation/crash were active-worker tests, not pre-aborted shortcuts");
		for (const worker of workers) assert.equal(await realpath(worker), join(release, "dist/pi-docparser/native-worker.mjs"));
		// LiteParse is import-only (no CommonJS require export). Resolve with
		// Node's actual ESM resolver from the staged worker's module directory.
		const liteparse = childProcess.execFileSync(process.execPath, ["--input-type=module", "-e",
			'process.stdout.write(import.meta.resolve("@llamaindex/liteparse"))'],
			{ cwd: join(release, "dist/pi-docparser"), env: process.env, encoding: "utf8" });
		assert.ok((await realpath(new URL(liteparse))).startsWith(join(release, "node_modules") + "/"), "worker resolves NEW release dependency tree");
		assert.equal(existsSync(join(release, "node_modules/@earendil-works")), false);
	} finally { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); }
}

async function footerAndFocus(h) {
	const ui = await mount(h);
	try {
		assert.ok(ui.mounted.has("footer"));
		// Real loop command, held busy so its immediate dispatch remains pending;
		// no provider turn is needed to prove the footer/status ownership boundary.
		const ctx = h.session.extensionRunner.createCommandContext();
		const busy = Object.defineProperty(Object.create(ctx), "isIdle", { value: () => false });
		await command(h, "loop").handler("1m local synthetic reminder", busy);
		assert.equal(ui.statuses.get("local-loop"), "loops: 1");
		const task = (await execute(h, "bg_run", { name: "Footer local task", command: 'node -e "setInterval(()=>{},1000)"',
			notifyOnCompletion: false, triggerOnCompletion: false })).details.task;
		assert.match(ui.statuses.get("background-tasks"), /Footer local task|1/);
		let footer = ui.mounted.get("footer").render(120).join("\n");
		assert.match(footer, /loops: 1/); assert.match(footer, /Shift↓|Footer local task/);
		await command(h, "tasks").handler("", h.session.extensionRunner.createCommandContext());
		const dock = ui.interactions.at(-1);
		assert.equal(dock.options.overlay, true); assert.equal(dock.options.overlayOptions.anchor, "center");
		assert.equal(dock.handle.isFocused(), false, "completed interaction releases real TUI overlay focus");
		const shortcuts = h.session.extensionRunner.getShortcuts({});
		assert.ok(shortcuts.has("shift+down"), "bg dock keeps its shortcut owner");
		await shortcuts.get("shift+down").handler(h.session.extensionRunner.createContext());
		assert.equal(ui.interactions.at(-1).options.overlay, true);
		ui.nextAction = (component) => { assert.equal(component.focused, true, "UI panel owns focus while mounted"); component.handleInput?.("\u001b"); };
		await command(h, "ccstyle").handler("panel", h.session.extensionRunner.createCommandContext());
		assert.equal(ui.tui.hasOverlay(), false, "UI panel releases focus rather than leaving bg dock captured");
		assert.equal(ui.statuses.get("local-loop"), "loops: 1", "UI overlays do not clear loop's status");
		assert.ok(ui.statuses.has("background-tasks"), "UI overlays do not clear bg's status");
		await execute(h, "bg_kill", { taskId: task.id });
		assert.match(ui.statuses.get("background-tasks"), /stopped/, "an unseen stopped-task notice is retained");
		ui.statuses.set("foreign-status", "another extension");
		await command(h, "bg-clear").handler("", h.session.extensionRunner.createCommandContext());
		assert.equal(ui.statuses.has("background-tasks"), false, "/bg-clear acknowledges only background notices");
		assert.equal(ui.statuses.get("local-loop"), "loops: 1");
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		assert.equal(ui.statuses.has("local-loop"), false);
		assert.equal(ui.statuses.has("background-tasks"), false);
		assert.equal(ui.statuses.get("foreign-status"), "another extension", "module cleanup does not impersonate the host's global UI reset");
		assert.equal(ui.mounted.has("footer"), false);
	} finally { ui.dispose(); }
}

async function addDir(h) {
	const external = join(dirname(cwd), "external");
	const skillPath = join(external, ".pi", "skills", "demo", "SKILL.md");
	const validPath = join(external, ".pi", "skills", "ok", "SKILL.md");
	const brokenPath = join(external, ".pi", "skills", "broken", "SKILL.md");
	const defaultSkillPath = join(agentDir, "skills", "demo", "SKILL.md");
	await mkdir(join(external, ".pi", "skills", "demo"), { recursive: true });
	await mkdir(join(external, ".pi", "skills", "ok"), { recursive: true });
	await mkdir(join(external, ".pi", "skills", "broken"), { recursive: true });
	await mkdir(join(agentDir, "skills", "demo"), { recursive: true });
	// A default skill with the same name, a valid external skill, and an invalid candidate.
	await writeFile(defaultSkillPath, "---\nname: demo\ndescription: Default fixture skill\n---\n\nDefault body.\n");
	await writeFile(skillPath, "---\nname: demo\ndescription: External fixture skill\n---\n\nDemo skill body.\n");
	await writeFile(validPath, "---\nname: ok\ndescription: Valid external fixture skill\n---\n\nOk body.\n");
	await writeFile(brokenPath, "# Broken skill\n\nNo frontmatter description.\n");
	await writeFile(join(external, "AGENTS.md"), "External AGENTS marker for pi-add-dir.\n");
	const global = join(dirname(cwd), "global-external");
	const configPath = join(agentDir, "config", "pi-add-dir", "config.json");
	assert.equal(existsSync(join(agentDir, "config", "pi-add-dir")), false, "startup creates no configuration before the first persistent write");
	await mkdir(global, { recursive: true });
	const ctx = h.session.extensionRunner.createCommandContext();
	await command(h, "dir-add").handler(external, ctx);
	const states = h.session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "add-dir:state");
	assert.equal(states.length, 1, "session scope persists exactly one state entry");
	assert.deepEqual(states[0].data.dirs, [{ absolutePath: external, label: "external" }]);
	// Global scope exercises the bundled config store and its CJS lock closure.
	await command(h, "dir-add").handler(`--global ${global}`, ctx);
	assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { directories: [global] });
	assert.equal((await stat(configPath)).mode & 0o777, 0o600, "global configuration is private");
	for (const name of ["add_directory", "search_external_files"]) {
		assert.equal(h.session.getToolDefinition(name), undefined, "no model tool was migrated: " + name);
	}
	assert.ok(!h.session.extensionRunner.getRegisteredCommands().some((item) => item.invocationName === "dir-reload"), "/dir-reload is not registered");
	assert.ok(!h.loader.getSkills().skills.some((skill) => skill.name === "demo"), "external skills wait for the host reload boundary");
	await h.session.reload();
	const skillState = h.loader.getSkills();
	assert.deepEqual(skillState.skills.map((skill) => skill.name).sort(), ["demo", "ok"], "the invalid candidate is dropped");
	const demo = skillState.skills.find((skill) => skill.name === "demo");
	assert.equal(await realpath(demo.filePath), await realpath(defaultSkillPath), "the default skill wins the name collision");
	assert.equal(await realpath(skillState.skills.find((skill) => skill.name === "ok").filePath), await realpath(validPath));
	const diagnostics = JSON.stringify(skillState.diagnostics);
	assert.match(diagnostics, /demo/, "the host reports the collision it resolved");
	assert.match(diagnostics, /broken/, "the host reports the invalid external skill");
	// A real synthetic turn proves the external instructions reach the model prompt.
	await h.session.prompt("Local synthetic reply");
	const promptState = globalThis[Symbol.for("serraly.sdk-fixture")];
	assert.match(promptState.lastSystemPrompt, /External AGENTS marker for pi-add-dir\./);
	assert.match(promptState.lastSystemPrompt, /External Directories \(added via pi-add-dir\)/);
	assert.deepEqual(promptState.skillCommands, [
		{ name: "skill:demo", path: await realpath(defaultSkillPath) },
		{ name: "skill:ok", path: await realpath(validPath) },
	], "the module reconciles against the host's real skill command inventory");
	// Only a real TUI context owns the widget; print/RPC bindings must stay silent.
	const ui = await mount(h);
	try {
		assert.ok(ui.mounted.has("add-dir"), "external directories own a widget in the TUI");
		const widget = ui.mounted.get("add-dir");
		assert.match(widget.render(120).join("\n"), /external/);
		// Selecting a directory removes it from its own scope, through the real host context.
		const tuiCtx = h.session.extensionRunner.createCommandContext();
		const selecting = Object.defineProperty(Object.create(tuiCtx), "ui", {
			value: { ...tuiCtx.ui, select: async (_title, choices) => choices.find((choice) => choice.includes(global)) },
		});
		await command(h, "dir-ls").handler("", selecting);
		assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { directories: [] });
		const afterRemoval = ui.mounted.get("add-dir")?.render(120).join("\n") ?? "";
		assert.match(afterRemoval, /1 external dir/);
		assert.match(afterRemoval, /external/);
		assert.ok(!afterRemoval.includes("global-external"), "the removed directory leaves the live widget");
		// The host rejected one candidate and loaded the rest, so no reload is owed.
		const plain = join(dirname(cwd), "plain-external");
		await mkdir(plain, { recursive: true });
		const tuiCtx2 = h.session.extensionRunner.createCommandContext();
		await command(h, "dir-add").handler(plain, tuiCtx2);
		assert.ok(
			!(ui.mounted.get("add-dir")?.render(200).join("\n") ?? "").includes("/reload pending"),
			"rejected candidates never keep asking for a reload",
		);
		const fresh = join(dirname(cwd), "fresh-external");
		await mkdir(join(fresh, ".pi", "skills", "fresh"), { recursive: true });
		await writeFile(join(fresh, ".pi", "skills", "fresh", "SKILL.md"), "---\nname: fresh\ndescription: Newly added fixture skill\n---\n\nFresh body.\n");
		await command(h, "dir-add").handler(fresh, tuiCtx2);
		assert.match(
			ui.mounted.get("add-dir")?.render(200).join("\n") ?? "",
			/\/reload pending/,
			"a genuinely new skill still asks for a reload",
		);
	} finally { ui.dispose(); }
}

if (scenario === "filters") {
	for (let disabled = 0; disabled < entries.length; disabled++) {
		const indices = allIndices.filter((index) => index !== disabled);
		const h = await open(indices, ["-" + entries[disabled].slice(2)]);
		let mounted;
		try {
			inventory(h, indices);
			if (disabled === 0) {
				assert.deepEqual((await execute(h, "bg_status", {})).details.tasks, [], "UI-disabled package retains background execution");
				const patch = await execute(h, "apply_patch", { input: patchInput });
				assert.equal(patch.details.format, "apply_patch.v1", "UI-disabled package retains file mutation/report contract");
				assert.equal((await execute(h, "AskUserQuestion", questionArgs)).details.questions.length, 1);
			} else {
				mounted = await mount(h);
				assert.ok(mounted.mounted.has("footer") && mounted.mounted.has("header"), "disabling a business entry does not disable UI");
			}
		} finally { await h.close(); mounted?.dispose(); }
	}
} else {
	const h = await open();
	try {
		if (scenario === "inventory") inventory(h, config.indices ?? allIndices);
		else if (scenario === "subagents-contracts") {
			inventory(h, config.indices ?? allIndices);
			await assert.rejects(execute(h, "Agent", { prompt: "fixture", agent: "no-such-agent" }), /Unknown agent type: no-such-agent/);
			await assert.rejects(execute(h, "StopAgent", { agent_id: "missing" }), /Agent missing not found/);
			const status = await execute(h, "AgentStatus", {});
			assert.equal(status.content[0].text, "No agents running or completed.\n\nDon't poll — you'll receive notifications when agents complete.");
			assert.deepEqual(h.session.messages, [], "validation errors and empty status do not spawn a child or a provider turn");
			const ui = await mount(h);
			try {
				const renderer = h.session.extensionRunner.getMessageRenderer("subagent-result");
				assert.equal(typeof renderer, "function");
				const row = new SDK.CustomMessageComponent({ role: "custom", customType: "subagent-result",
					content: "Local synthetic completion", display: true, timestamp: Date.now(),
					details: { type: "general-purpose", description: "Dedicated local completion card" } }, renderer);
				for (const width of [40, 80, 120]) {
					const lines = row.render(width);
					assert.match(lines.join("\n"), /Subagent Result/);
					assert.match(lines.join("\n"), /Dedicated local completion card/);
					for (const line of lines) assert.ok(TUI.visibleWidth(line) <= width);
				}
			} finally { ui.dispose(); }
		}
		else if (scenario === "contracts") await contracts(h);
		else if (scenario === "background") await background(h);
		else if (scenario === "documents") await documents(h);
		else if (scenario === "footer-focus") await footerAndFocus(h);
		else if (scenario === "add-dir") await addDir(h);
		else if (scenario === "discovery") {
			inventory(h, allIndices);
			const searched = await execute(h, "tool_search", { query: "+AskUserQuestion +bg_run +document_parse" });
			assert.ok(searched.content[0].text.includes("AskUserQuestion"));
			for (const name of ["AskUserQuestion", "bg_run", "document_parse"]) assert.ok(h.session.getActiveToolNames().includes(name), "tool_search discovers and activates " + name);
		} else assert.fail("Unknown worker scenario " + scenario);
	} finally { await h.close(); }
}
assert.deepEqual(await credentials.list(), []);
assert.equal(existsSync(join(agentDir, "auth.json")), false);
await report("complete", { scenario });
