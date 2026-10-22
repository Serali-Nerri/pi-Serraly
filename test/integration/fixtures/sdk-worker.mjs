import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { toolsByName, commandsByName } from "./contracts.mjs";

const host = process.argv[2], scenario = process.argv[3];
const SDK = await import(pathToFileURL(join(host, "dist/index.js")).href);
// Pi 1.3.0 declares this API but does not export it from the SDK root. This
// private, pinned import is TEST ONLY; no credentials path is ever consulted.
const { AuthStorage } = await import(pathToFileURL(join(host, "dist/core/auth-storage.js")).href);
const config = JSON.parse(await readFile(process.env.SERRALY_CONFIG, "utf8"));
const cwd = process.cwd(), agentDir = process.env.PI_CODING_AGENT_DIR, release = process.env.SERRALY_RELEASE;
// Members come from the packed release manifest, keyed by package name.
const releaseManifest = JSON.parse(await readFile(join(release, "package.json"), "utf8"));
const entryByName = Object.fromEntries(releaseManifest.pi.extensions.map((entry) => [entry.split("/")[2], join(release, entry.slice(2))]));
const allNames = Object.keys(entryByName).sort();
const baseline = Object.fromEntries(["getCallRenderer", "getResultRenderer", "getRenderShell", "updateDisplay"].map((name) => [name, SDK.ToolExecutionComponent.prototype[name]]));
const report = (phase, extra = {}) => import("node:fs").then(({ appendFileSync }) => appendFileSync(process.env.SERRALY_REPORT, JSON.stringify({ phase, ...extra }) + "\n"));
const credentials = AuthStorage.inMemory();
const modelRuntime = await SDK.ModelRuntime.create({ credentials, modelsPath: null,
	modelsStorePath: join(process.env.TMPDIR, "models-cache.json"), allowModelNetwork: false, refreshOnCreate: false });

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
		additionalExtensionPaths: [join(import.meta.dirname, "sdk-provider.js"), "builtin:tool-search",
			...(!discoverSettings && packageFilter === undefined ? names.map((name) => entryByName[name]) : [])],
		extensionFactories: [{ name: "tool-search", builtin: true, factory: SDK.createToolSearchExtension() }],
	});
	await loader.reload();
	const loaded = loader.getExtensions();
	assert.deepEqual(loaded.errors, [], "actual loader resolves compiled entry and lazy/native closure");
	assert.deepEqual(loader.getSkills().skills, [], "packaged release declares no skills, so no companion skill activates");
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

function inventory(h, names) {
	const extensions = h.loader.getExtensions().extensions.filter((extension) => extension.path.startsWith(release));
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


if (scenario === "filters") {
	await writeFile(join(cwd, "search-marker.txt"), "filesystem fixture\n");
	for (const disabledName of allNames) {
		const names = allNames.filter((name) => name !== disabledName);
		const h = await open(names, ["-" + releaseManifest.pi.extensions.find((entry) => entry.split("/")[2] === disabledName).slice(2)]);
		try {
			inventory(h, names);
			const listing = await execute(h, "ls", {});
			assert.match(listing.content[0].text, /search-marker\.txt/, `disabling ${disabledName} retains filesystem tools`);
		} finally { await h.close(); }
	}
} else {
	const h = await open();
	try {
		if (scenario === "inventory") inventory(h, config.names ?? allNames);
		else assert.fail("Unknown worker scenario " + scenario);
	} finally { await h.close(); }
}
assert.deepEqual(await credentials.list(), []);
assert.equal(existsSync(join(agentDir, "auth.json")), false);
await report("complete", { scenario });
