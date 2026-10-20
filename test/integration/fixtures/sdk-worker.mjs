import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, realpath, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { toolsByName, commandsByName, questionArgs, patchInput } from "./contracts.mjs";

const host = process.argv[2], scenario = process.argv[3];
const SDK = await import(pathToFileURL(join(host, "dist/index.js")).href);
const require = createRequire(join(host, "package.json"));
const TUI = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href);
// Pi 1.3.0 declares this API but does not export it from the SDK root. This
// private, pinned import is TEST ONLY; no credentials path is ever consulted.
const { AuthStorage } = await import(pathToFileURL(join(host, "dist/core/auth-storage.js")).href);
const config = JSON.parse(await readFile(process.env.SERRALY_CONFIG, "utf8"));
const cwd = process.cwd(), agentDir = process.env.PI_CODING_AGENT_DIR, release = process.env.SERRALY_RELEASE;
// Members come from the packed release manifest, keyed by package name.
const releaseManifest = JSON.parse(await readFile(join(release, "package.json"), "utf8"));
const entryByName = Object.fromEntries(releaseManifest.pi.extensions.map((entry) => [entry.split("/")[2], join(release, entry.slice(2))]));
// A standalone packed consumer points at the installed sealed entry, not a workspace or release copy.
if (config.packedContextEntry) entryByName["context-view"] = config.packedContextEntry;
const allNames = Object.keys(entryByName).sort();
const baseline = Object.fromEntries(["getCallRenderer", "getResultRenderer", "getRenderShell", "updateDisplay"].map((name) => [name, SDK.ToolExecutionComponent.prototype[name]]));
const report = (phase, extra = {}) => import("node:fs").then(({ appendFileSync }) => appendFileSync(process.env.SERRALY_REPORT, JSON.stringify({ phase, ...extra }) + "\n"));
const credentials = AuthStorage.inMemory();
const modelRuntime = await SDK.ModelRuntime.create({ credentials, modelsPath: null,
	modelsStorePath: join(process.env.TMPDIR, "models-cache.json"), allowModelNetwork: false, refreshOnCreate: false });

// Request-local fake transport for the real adapter. No global SDK/provider/fetch replacement.
const schemaMarker = "CV_ARTIFACT_DEFERRED_C83D";
const adapterScenario = ["context-tools", "startup-lifecycle", "context-strict-fallback"].includes(scenario);
const toolState = { requests: 0, executions: 0, replies: [], bodies: [], latestBody: undefined, withdraw: false, rejectStrict: false };
const startupState = { starts: [], gate: undefined };
function contextToolsFixture(pi) {
	pi.registerTool({ name: "context_eager", label: "Eager", description: "Benign local eager operation",
		parameters: { type: "object", properties: {} }, async execute() {
			toolState.executions++; return { content: [{ type: "text", text: "local-eager-done" }], details: {} };
		} });
	pi.registerTool({ name: "context_deferred", label: "Deferred", description: "Xylophoton ledger lookup", exposure: "deferred",
		parameters: { type: "object", properties: { [schemaMarker]: { type: "string" } } },
		async execute() { assert.fail("Viewing/searching must not execute deferred business tools"); } });
	pi.on("before_agent_start", () => {
		if (toolState.withdraw) pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "context_deferred"));
	});
	if (scenario === "startup-lifecycle") {
		pi.on("before_agent_start", async (event, ctx) => {
			startupState.starts.push({ messageType: event.messageType, idle: ctx.isIdle(), prompt: event.prompt });
			if (startupState.gate) await startupState.gate.promise;
		});
	}
	if (scenario === "context-strict-fallback") {
		pi.registerTool({ name: "context_preferred_strict", label: "Preferred strict", description: "Local preferred-strict fixture",
			parameters: { type: "object", properties: {} }, constrainedSampling: { type: "json_schema", strict: "prefer" },
			async execute() { assert.fail("Observing a definition does not execute it"); } });
	}
}
async function registerContextAdapter() {
	// pi-ai's public api/* export is import-only; require.resolve cannot select it.
	const { streamSimple } = await import(pathToFileURL(join(dirname(host), "pi-ai/dist/api/anthropic-messages.js")).href);
	const fetch = async (_input, init) => {
		toolState.requests++;
		const body = toolState.latestBody = JSON.parse(String(init.body));
		toolState.bodies.push(body);
		if (toolState.rejectStrict && body.tools.some((tool) => tool.strict === true)) {
			toolState.rejectStrict = false;
			return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error",
				message: "Too many strict tools (local deterministic fixture)" } }), {
				status: 400, headers: { "content-type": "application/json" },
			});
		}
		const reply = toolState.replies.shift();
		const events = [
			{ type: "message_start", message: { id: `msg_${toolState.requests}`, type: "message", role: "assistant", content: [], model: body.model,
				stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: reply ? { type: "tool_use", id: `call_${toolState.requests}`, name: reply.name, input: {} } : { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: reply ? { type: "input_json_delta", partial_json: JSON.stringify(reply.input) } : { type: "text_delta", text: "Local adapter reply." } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: reply ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } },
			{ type: "message_stop" },
		];
		return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
			status: 200, headers: { "content-type": "text/event-stream" },
		});
	};
	modelRuntime.registerProvider("context-adapter-fixture", {
		api: "context-adapter-fixture", apiKey: "fixture", baseUrl: "https://example.invalid",
		models: [{ id: "local", name: "Local adapter fixture", reasoning: false, input: ["text"], contextWindow: 65536, maxTokens: 2048,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: { supportsMidConvoSystemMessages: config.native, supportsMidConvoToolChanges: config.native,
				supportsStrictTools: scenario === "context-strict-fallback" } }],
		streamSimple: (model, context, options) => streamSimple({ ...model, api: "anthropic-messages" }, context,
			{ ...options, fetch, apiKey: "fixture", maxRetries: 0, timeoutMs: 5000 }),
	});
}

async function open(names = config.names ?? allNames, packageFilter = config.packageFilter, discoverSettings = false) {
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
			...(!discoverSettings && packageFilter === undefined ? names.map((name) => entryByName[name]) : [])],
		extensionFactories: [{ name: "tool-search", builtin: true, factory: SDK.createToolSearchExtension() },
			{ name: "codemode", builtin: true, factory: SDK.createCodemodeExtension(adapterScenario ? { models: false } : {}) },
			...(adapterScenario ? [{ name: "context-diagnostics-fixture", factory: contextToolsFixture }] : [])],
	});
	await loader.reload();
	const loaded = loader.getExtensions();
	assert.deepEqual(loaded.errors, [], "actual loader resolves compiled entry and lazy/native closure");
	assert.deepEqual(loader.getSkills().skills, [], "packaged release declares no skills, so no companion skill activates");
	for (const { name, config } of loaded.runtime.pendingProviderRegistrations) modelRuntime.registerProvider(name, config);
	if (adapterScenario) await registerContextAdapter();
	const model = adapterScenario ? modelRuntime.getModel("context-adapter-fixture", "local") : modelRuntime.getModel("serraly-fixture", "fixture");
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

function inventory(h, names) {
	const extensions = h.loader.getExtensions().extensions.filter((extension) => extension.path.startsWith(release) || extension.path === config.packedContextEntry);
	assert.equal(extensions.length, names.length, "each manifest entry loads exactly once");
	const registeredTools = extensions.flatMap((extension) => [...extension.tools.keys()]).sort();
	const expectedTools = names.flatMap((name) => toolsByName[name]).sort();
	assert.deepEqual(registeredTools, expectedTools);
	assert.equal(new Set(registeredTools).size, registeredTools.length, "no duplicate tool registration");
	const commands = h.session.extensionRunner.getRegisteredCommands().map((command) => command.invocationName).sort();
	assert.deepEqual(commands, names.flatMap((name) => commandsByName[name]).sort());
	assert.equal(new Set(commands).size, commands.length, "no duplicate commands");
	const active = h.session.getActiveToolNames();
	assert.ok(active.includes("tool_search"), "builtin discovery remains enabled by +tool_search");
	for (const name of ["read", "bash", "edit", "write"]) assert.ok(active.includes(name), "+tool_search retains default built-ins");
	const exposures = { apply_patch: "direct", grep: "codemode", find: "codemode", ls: "codemode",
		bg_run: "codemode", bg_status: "codemode", bg_logs: "codemode", bg_kill: "codemode",
		Agent: "direct", StopAgent: "direct", MessageAgent: "direct", AgentStatus: "direct", ask_user_question: "model-only" };
	for (const tool of h.session.getAllTools().filter((tool) => expectedTools.includes(tool.name))) {
		const exposure = exposures[tool.name] ?? "deferred";
		assert.equal(tool.exposure, exposure);
		assert.equal(active.includes(tool.name), exposure === "direct" || exposure === "model-only",
			"direct and model-only tools are initially active");
	}
	const subagents = extensions.find((extension) => extension.path.endsWith("/pi-subagents/dist/pi-subagents.js"));
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
	const ask = h.session.getToolDefinition("ask_user_question");
	assert.equal(ask.exposure, "model-only");
	assert.equal(ask.executionMode, "sequential");
	assert.equal(ask.promptSnippet, undefined);
	assert.equal(ask.promptGuidelines, undefined);
	assert.deepEqual(ask.parameters.required, ["questions"]);
	assert.equal(ask.parameters.properties.questions.minItems, 1);
	assert.equal(ask.parameters.properties.questions.maxItems, 4);
	assert.deepEqual(ask.parameters.properties.questions.items.required, ["question", "header", "options"]);
	assert.equal(ask.parameters.properties.questions.items.properties.header.maxLength, 16);
	assert.equal(ask.parameters.properties.questions.items.properties.options.minItems, 2);
	assert.equal(ask.parameters.properties.questions.items.properties.options.maxItems, 4);
	assert.equal(ask.parameters.properties.questions.items.properties.options.items.properties.label.maxLength, 60);
	const noUi = await execute(h, "ask_user_question", questionArgs);
	assert.deepEqual(noUi.details, { answers: [], cancelled: true, error: "no_ui" });
	const ui = await mount(h);
	try {
		const tooFew = await execute(h, "ask_user_question", {
			questions: [{ ...questionArgs.questions[0], options: [questionArgs.questions[0].options[0]] }],
		});
		assert.equal(tooFew.details.error, "empty_options");
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
		// Drive the real compiled dialog through the host custom UI: Enter picks the
		// first option, Escape abandons the questionnaire.
		ui.nextAction = (component) => component.handleInput("\r");
		const answered = await execute(h, "ask_user_question", questionArgs);
		assert.deepEqual(answered.details, {
			answers: [{ questionIndex: 0, question: "Which local database?", kind: "option", answer: "SQLite" }], cancelled: false,
		});
		assert.equal(answered.content[0].text,
			'User has answered your questions: "Which local database?"="SQLite". You can now continue with the user\'s answers in mind.');
		ui.nextAction = (component) => component.handleInput("\u001b");
		const declined = await execute(h, "ask_user_question", questionArgs);
		assert.deepEqual(declined.details, { answers: [], cancelled: true });
	} finally { ui.dispose(); }
}

async function contextTools(h) {
	inventory(h, config.names);
	const ui = await mount(h);
	const component = () => ui.interactions.at(-1).component;
	const plain = () => component().render(100).join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
	const preview = (label) => {
		component().handleInput("\x1b[H");
		for (let step = 0; step < 80; step++) {
			if (plain().split("\n").some((line) => line.includes("›") && line.includes(label))) {
				component().handleInput("\r"); return plain();
			}
			component().handleInput("\x1b[B");
		}
		assert.fail("Missing public diagnostic row: " + label);
	};
	try {
		const initialEntries = h.session.sessionManager.getEntries();
		await h.session.prompt("/context tools"); assert.match(plain(), /Not yet observed/);
		assert.deepEqual(h.session.sessionManager.getEntries(), initialEntries);
		await h.session.prompt("Local adapter plan.");
		assert.equal(toolState.requests, 1);
		assert.doesNotMatch(JSON.stringify(toolState.latestBody), new RegExp(schemaMarker), "schema-only marker absent globally initially");
		await h.session.prompt("/context tools");
		assert.match(plain(), config.native ? /Anthropic-shaped native/ : /Anthropic-shaped collapsed/);
		assert.match(preview("Registered context_eager"), /Active: active/);
		component().handleInput("\x1b");
		preview("Codemode description"); component().handleInput("\x1b[F");
		if (config.codemodeMode === "only") {
			assert.match(plain(), /context_eager/);
			assert.ok(!toolState.latestBody.tools.some((tool) => tool.name === "context_eager"));
		} else {
			component().handleInput("\x1b");
			assert.match(preview("Observed context_eager"), /input_schema/);
		}
		toolState.replies.push({ name: "codemode", input: { code: '// @options: {"timeout_ms":3000}\ntext(await tools.context_eager({})); text(await searchTools("Xylophoton", {limit: 1}));' } }, undefined);
		const active = h.session.getActiveToolNames();
		await h.session.prompt("Run the benign call and pure search.");
		assert.equal(toolState.executions, 1);
		assert.deepEqual(h.session.getActiveToolNames(), active);
		const result = h.session.messages.filter((message) => message.role === "toolResult" && message.toolName === "codemode").at(-1);
		assert.match(JSON.stringify(result), /Script completed.*local-eager-done/s);
		assert.match(JSON.stringify(result), new RegExp(schemaMarker));
		assert.ok(!toolState.latestBody.tools.some((tool) => tool.name === "context_deferred"));
		toolState.replies.push({ name: "tool_search", input: { query: "Xylophoton", limit: 1 } }, undefined);
		await h.session.prompt("Load the local deferred definition.");
		await h.session.prompt("/context tools");
		assert.match(preview("Observed context_deferred"), new RegExp(schemaMarker));
		component().handleInput("\x1b");
		if (config.native) {
			assert.match(preview("Update + context_deferred"), /Position: \$\.messages\[/);
			component().handleInput("\x1b");
			assert.match(preview("Adapter placeholder"), /Never callable/);
		}
		toolState.withdraw = true;
		await h.session.prompt("Withdraw the local deferred definition.");
		await h.session.prompt("/context tools");
		assert.match(preview("Registered context_deferred"), /Active: inactive/);
		component().handleInput("\x1b");
		if (config.native) assert.match(preview("Update − context_deferred"), /tool\.name/);
		const requests = toolState.requests, entries = h.session.sessionManager.getEntries();
		for (const view of ["usage", "injections"]) await h.session.prompt("/context " + view);
		if (config.names.includes("pi-ui")) {
			await h.session.prompt("/ccstyle panel");
			assert.match(plain(), /Original renderers/); assert.ok(ui.mounted.has("footer"));
		}
		assert.deepEqual(h.session.sessionManager.getEntries(), entries);
		await h.session.reload();
		await h.session.prompt("/context tools"); assert.match(plain(), /Not yet observed/);
		await h.session.prompt("/context injections"); assert.match(plain(), /Not captured.*Session estimate/s);
		assert.equal(toolState.requests, requests); assert.equal(toolState.executions, 1);
		assert.deepEqual(h.session.sessionManager.getEntries(), entries,
			"reloading and opening diagnostics do not append session data");
	} finally { ui.dispose(); }
}

async function startupLifecycle(h) {
	const ui = await mount(h);
	const plain = () => ui.interactions.at(-1).component.render(100).join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
	const instructionPreview = () => {
		const view = ui.interactions.at(-1).component;
		view.handleInput("\x1b[H");
		for (let index = 0; index < 100; index++) {
			if (plain().split("\n").some((line) => line.includes("→") && line.includes("pi_add_dir"))) {
				view.handleInput("\r");
				const text = plain();
				view.handleInput("\x1b");
				return text;
			}
			view.handleInput("\x1b[B");
		}
		assert.fail("Latest injections expose the external directory prompt section");
	};
	const external = join(process.env.TMPDIR, "startup-directory");
	const instructions = join(external, "AGENTS.md");
	let running;
	try {
		await mkdir(external, { recursive: true });
		await writeFile(instructions, "FIRST_CUSTOM_DIRECTORY_INSTRUCTIONS");
		await command(h, "dir-add").handler(external, h.session.extensionRunner.createCommandContext());
		await h.session.sendCustomMessage({ customType: "pending-next-turn", content: "PENDING_NEXT_TURN", display: false },
			{ deliverAs: "nextTurn" });
		toolState.replies.push({ name: "context_eager", input: {} });
		await h.session.sendCustomMessage({ customType: "first-wake", content: "FIRST_CUSTOM_WAKE", display: false },
			{ triggerTurn: true });
		assert.deepEqual(startupState.starts, [{ messageType: "custom", idle: false, prompt: undefined }]);
		assert.equal(toolState.executions, 1);
		assert.equal(toolState.bodies.length, 2);
		for (const body of toolState.bodies) {
			assert.match(JSON.stringify(body.system), /FIRST_CUSTOM_DIRECTORY_INSTRUCTIONS/);
			assert.match(JSON.stringify(body.messages), /PENDING_NEXT_TURN/);
		}
		await h.session.prompt("/context injections");
		assert.doesNotMatch(plain(), /Not captured/);
		assert.match(plain(), /\[LATEST\]/);
		assert.match(instructionPreview(), /FIRST_CUSTOM_DIRECTORY_INSTRUCTIONS/);

		await writeFile(instructions, "UPDATED_DIRECTORY_INSTRUCTIONS_WITH_A_DIFFERENT_LENGTH");
		startupState.gate = Promise.withResolvers();
		running = h.session.prompt("GATED_USER_START");
		await until(() => startupState.starts.length === 2, "startup handler entered");
		assert.equal(h.session.isIdle, false);
		assert.equal(startupState.starts[1].idle, false);
		await assert.rejects(h.session.sendUserMessage("MISSING_DELIVERY_MODE"), /streaming|deliverAs/i);

		const ready = join(process.env.TMPDIR, "startup-bg-ready"), finish = join(process.env.TMPDIR, "startup-bg-finish");
		const script = `const fs = require("node:fs"); setTimeout(() => process.exit(1), 10_000); fs.writeFileSync(${JSON.stringify(ready)}, "ready"); setInterval(() => { if (fs.existsSync(${JSON.stringify(finish)})) process.exit(0); }, 10);`;
		let taskId;
		const completion = eventOnce(h.eventBus, "pi-background-shell:terminal:v2", (frame) => frame.task.id === taskId);
		try {
			const launched = await execute(h, "bg_run", { name: "Startup completion", command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
				notifyOnCompletion: true, triggerOnCompletion: true });
			taskId = launched.details.task.id;
			await until(() => existsSync(ready), "local background task ready");
			await writeFile(finish, "finish");
			const terminal = await completion.promise;
			assert.equal(terminal.task.status, "completed");
		} finally {
			completion.cancel();
			await writeFile(finish, "finish");
		}
		assert.equal(startupState.starts.length, 2, "background completion cannot start a competing run during preparation");
		await h.session.sendUserMessage("QUEUED_USER_FOLLOWUP", { deliverAs: "followUp" });
		startupState.gate.resolve();
		await running;
		running = undefined;
		startupState.gate = undefined;
		assert.equal(startupState.starts.length, 2, "queued completion and follow-up drain inside the prepared run");
		assert.equal(h.session.isIdle, true);
		const notifications = h.session.sessionManager.getEntries().filter((entry) =>
			entry.type === "custom_message" && entry.customType === "background-task-notification" && entry.details.id === taskId);
		assert.equal(notifications.length, 1);
		assert.match(JSON.stringify(toolState.bodies.slice(2)), /QUEUED_USER_FOLLOWUP/);
		for (const body of toolState.bodies.slice(2)) assert.match(JSON.stringify(body.system), /UPDATED_DIRECTORY_INSTRUCTIONS_WITH_A_DIFFERENT_LENGTH/);
		await h.session.prompt("/context injections");
		const latestInstructions = instructionPreview();
		assert.match(latestInstructions, /UPDATED_DIRECTORY_INSTRUCTIONS_WITH_A_DIFFERENT_LENGTH/);
		assert.doesNotMatch(latestInstructions, /FIRST_CUSTOM_DIRECTORY_INSTRUCTIONS/);

		startupState.gate = Promise.withResolvers();
		running = h.session.prompt("GATED_LOOP_START");
		await until(() => startupState.starts.length === 3, "loop startup handler entered");
		await command(h, "loop").handler("1m PENDING_LOOP_REMINDER", h.session.extensionRunner.createCommandContext());
		assert.equal(startupState.starts.length, 3, "a pending loop cannot dispatch during startup preparation");
		startupState.gate.resolve();
		await running;
		running = undefined;
		startupState.gate = undefined;
		await until(() => startupState.starts.some((start) => start.prompt === "PENDING_LOOP_REMINDER") && h.session.isIdle,
			"pending loop completed after startup");
		assert.equal(h.session.isIdle, true);
		assert.equal(startupState.starts.filter((start) => start.prompt === "PENDING_LOOP_REMINDER").length, 1,
			"settlement dispatches the pending loop exactly once");

		const requests = toolState.requests;
		startupState.gate = Promise.withResolvers();
		running = h.session.prompt("CANCEL_DURING_STARTUP");
		await until(() => startupState.starts.length === 5, "cancellable startup handler entered");
		const aborted = h.session.abort();
		startupState.gate.resolve();
		await Promise.all([running, aborted]);
		running = undefined;
		assert.equal(h.session.isIdle, true);
		assert.equal(toolState.requests, requests, "abort during preparation prevents the provider request");
		assert.deepEqual(h.errors, []);
	} finally {
		startupState.gate?.resolve();
		if (running) await running.catch(() => {});
		ui.dispose();
	}
}

async function contextStrictFallback(h) {
	const ui = await mount(h);
	try {
		toolState.rejectStrict = true;
		await h.session.prompt("Observe a preferred-strict retry.");
		assert.equal(toolState.requests, 2);
		const original = toolState.bodies[0].tools.find((tool) => tool.name === "context_preferred_strict");
		const fallback = toolState.bodies[1].tools.find((tool) => tool.name === "context_preferred_strict");
		assert.equal(original.strict, true);
		assert.equal(fallback.strict, undefined);
		assert.equal(h.session.messages.at(-1).stopReason, "stop");
		await h.session.prompt("/context tools");
		const component = ui.interactions.at(-1).component;
		const plain = () => component.render(100).join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
		component.handleInput("\x1b[H");
		let opened = false;
		for (let step = 0; step < 80; step++) {
			if (plain().split("\n").some((line) => line.includes("›") && line.includes("Observed context_preferred_strict"))) {
				component.handleInput("\r"); opened = true; break;
			}
			component.handleInput("\x1b[B");
		}
		assert.ok(opened, "the public declaration diagnostic includes the successful retry");
		assert.match(plain(), /context_preferred_strict/);
		assert.doesNotMatch(plain(), /"strict": true/, "the latest pre-send observation replaced the rejected strict declaration");
		assert.equal(toolState.requests, 2, "opening diagnostics does not probe or replay the provider");
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
	const keybindings = { matches: (data, name) => TUI.matchesKey(data, {
		"tui.select.confirm": "enter", "tui.input.submit": "enter", "tui.select.cancel": "escape",
		"tui.select.up": "up", "tui.select.down": "down", "tui.input.newLine": "shift+enter",
		"tui.editor.cursorUp": "up", "tui.editor.cursorDown": "down",
		"tui.editor.deleteToLineStart": "ctrl+u", "app.editor.external": "ctrl+g",
	}[name] ?? name) };
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
				component = factory(tui, theme, keybindings, done);
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
	for (let disabled = 0; disabled < allNames.length; disabled++) {
		const disabledName = allNames[disabled];
		const names = allNames.filter((name) => name !== disabledName);
		const h = await open(names, ["-" + releaseManifest.pi.extensions.find((entry) => entry.split("/")[2] === disabledName).slice(2)]);
		let mounted;
		try {
			inventory(h, names);
			if (disabledName === "pi-ui") {
				assert.deepEqual((await execute(h, "bg_status", {})).details.tasks, [], "UI-disabled package retains background execution");
				const patch = await execute(h, "apply_patch", { input: patchInput });
				assert.equal(patch.details.format, "apply_patch.v1", "UI-disabled package retains file mutation/report contract");
			} else {
				mounted = await mount(h);
				assert.ok(mounted.mounted.has("footer"), "disabling a business entry does not disable UI");
			}
		} finally { await h.close(); mounted?.dispose(); }
	}
} else {
	const h = await open();
	try {
		if (scenario === "inventory") inventory(h, config.names ?? allNames);
		else if (scenario === "context-tools") await contextTools(h);
		else if (scenario === "startup-lifecycle") await startupLifecycle(h);
		else if (scenario === "context-strict-fallback") await contextStrictFallback(h);
		else if (scenario === "context-view") {
			inventory(h, config.names);
			const state = globalThis[Symbol.for("serraly.sdk-fixture")];
			const ui = await mount(h);
			const plain = (component) => component.render(100).join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
			try {
				assert.equal(ui.mounted.has("footer"), config.names.includes("pi-ui"));
				const entries = h.session.sessionManager.getEntries();
				for (const args of ["", "usage", "injections"]) {
					await h.session.prompt("/context" + (args ? " " + args : ""));
					assert.match(plain(ui.interactions.at(-1).component), /Not captured.*Session estimate/s);
				}
				assert.deepEqual(h.session.sessionManager.getEntries(), entries);
				assert.equal(state.providerCalls ?? 0, 0, "opening before capture never starts an agent turn");
				await h.session.prompt("Local synthetic reply");
				assert.equal(state.providerCalls, 1);
				const capturedEntries = h.session.sessionManager.getEntries();
				await h.session.prompt("/context injections");
				assert.doesNotMatch(plain(ui.interactions.at(-1).component), /Not captured/);
				const view = ui.interactions.at(-1).component;
				view.handleInput("\x1b[B"); view.handleInput("\r"); view.render(40); view.handleInput("\x1b");
				await h.session.prompt("/context usage");
				assert.match(plain(ui.interactions.at(-1).component), /Context Usage/);
				if (config.names.includes("pi-ui")) {
					await h.session.prompt("/ccstyle panel");
					assert.match(plain(ui.interactions.at(-1).component), /Original renderers/);
					assert.ok(ui.mounted.has("footer"), "viewer does not replace UI's Footer");
				}
				assert.deepEqual(h.session.sessionManager.getEntries(), capturedEntries);
				await h.session.reload();
				assert.deepEqual(h.session.extensionRunner.getRegisteredCommands().map((item) => item.invocationName).sort(),
					config.names.flatMap((name) => commandsByName[name]).sort(), "reload retains unique command ownership in TUI mode");
				await h.session.prompt("/context injections");
				assert.match(plain(ui.interactions.at(-1).component), /Not captured.*Session estimate/s);
				assert.equal(state.providerCalls, 1);
			} finally { ui.dispose(); }
		}
		else if (scenario === "subagents-contracts") {
			inventory(h, config.names ?? allNames);
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
		else if (scenario === "footer-focus") await footerAndFocus(h);
		else if (scenario === "add-dir") await addDir(h);
		else if (scenario === "discovery") {
			inventory(h, allNames);
			const active = h.session.getActiveToolNames();
			h.session.agent.state.messages.push({ role: "assistant", content: [], api: h.model.api, provider: h.model.provider, model: h.model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "toolUse", timestamp: Date.now() });
			const result = await execute(h, "codemode", { code: `const names = ["bg_run", "bg_status", "bg_logs", "bg_kill"];
				text({tools: ALL_TOOLS.filter(tool => names.includes(tool.name)).map(tool => tool.name).sort()});
				text(await tools.bg_status({}));` });
			assert.equal(result.isError, undefined);
			const text = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
			assert.match(text, /"tools":\["bg_kill","bg_logs","bg_run","bg_status"\]/);
			assert.match(text, /No background tasks in this Pi extension runtime/);
			assert.deepEqual(h.session.getActiveToolNames(), active, "script discovery and calls do not directly activate background tools");
		} else assert.fail("Unknown worker scenario " + scenario);
	} finally { await h.close(); }
}
assert.deepEqual(await credentials.list(), []);
assert.equal(existsSync(join(agentDir, "auth.json")), false);
await report("complete", { scenario });
