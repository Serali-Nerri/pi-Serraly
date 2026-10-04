import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const { createSandbox } = await import(new URL("../../../scripts/preview.mjs", import.meta.url).href);
const { runChild } = await import(new URL("../../../scripts/lib/process.mjs", import.meta.url).href);

const worker = String.raw`
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const host = process.argv[2], base = process.env.TMPDIR, cwd = process.cwd();
const SDK = await import(pathToFileURL(join(host, "dist/index.js")).href);
const require = createRequire(join(host, "package.json"));
const { Type } = await import(pathToFileURL(require.resolve("typebox")).href);
const { AuthStorage } = await import(pathToFileURL(join(host, "dist/core/auth-storage.js")).href);
const runtime = await SDK.ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null,
	modelsStorePath: join(base, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
runtime.registerProvider("reload-fixture", { api: "reload-fixture", apiKey: "synthetic", baseUrl: "https://invalid.invalid",
	models: [{ id: "fixture", name: "Fixture", input: ["text"], reasoning: false, contextWindow: 32768,
		maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	streamSimple() { throw new Error("reload acceptance must never make a provider request"); } });
let stored = { defaultTools: ["read"], cacheWarming: "off", compaction: { enabled: false } };
const settings = SDK.SettingsManager.fromStorage({
	withLock(scope, change) {
		const next = change(scope === "global" ? JSON.stringify(stored) : undefined);
		if (next !== undefined && scope === "global") stored = JSON.parse(next);
	},
});
const loader = new SDK.DefaultResourceLoader({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager: settings,
	noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	additionalExtensionPaths: [process.env.PI_UI_STAGE],
	extensionFactories: [(pi) => {
		for (const name of ["sample_one", "sample_two"]) pi.registerTool({
			name, label: name, description: "Synthetic reload-only definition.", defaultActive: false,
			parameters: Type.Object({}), execute() { throw new Error("must not execute during reload"); },
		});
	}],
});
await loader.reload();
const create = async (tools) => (await SDK.createAgentSession({
	cwd, agentDir: process.env.PI_CODING_AGENT_DIR, modelRuntime: runtime, settingsManager: settings,
	resourceLoader: loader, sessionManager: SDK.SessionManager.inMemory(cwd),
	model: runtime.getModel("reload-fixture", "fixture"), ...(tools ? { tools } : {}),
})).session;
const original = SDK.ToolExecutionComponent.prototype.getCallRenderer;
const session = await create();
try {
	await session.bindExtensions({ mode: "print" });
	assert.deepEqual(session.getActiveToolNames(), ["read"]);
	stored = { ...stored, defaultTools: ["read", "sample_one"] };
	await session.reload();
	assert.deepEqual(session.getActiveToolNames().sort(), ["read", "sample_one"]);
	stored = { ...stored, defaultTools: ["read"] };
	await session.reload();
	assert.ok(session.getActiveToolNames().includes("sample_one"), "removal does not disable an active tool");
	session.setActiveToolsByName(["read"]);
	stored = { ...stored, defaultTools: ["read", "sample_one"] };
	await session.reload();
	assert.ok(session.getActiveToolNames().includes("sample_one"), "newly re-added default enables the tool");
	session.setActiveToolsByName(["read"]);
	await session.reload();
	assert.deepEqual(session.getActiveToolNames(), ["read"], "unchanged default leaves manual disable intact");
	const loaded = loader.getExtensions().extensions.find((extension) => extension.path === process.env.PI_UI_STAGE);
	assert.equal(loaded.tools.size, 0, "UI never re-registers tools across actual reloads");
	assert.deepEqual([...loaded.commands.keys()].sort(), ["ccstyle", "context"]);
	assert.equal(SDK.ToolExecutionComponent.prototype.getCallRenderer, original, "print-mode reload stays unpatched");
} finally { await session.extensionRunner.emit({ type: "session_shutdown" }); session.dispose(); }
stored = { ...stored, defaultTools: ["read"] };
await settings.reload();
const explicit = await create(["read"]);
try {
	await explicit.bindExtensions({ mode: "print" });
	stored = { ...stored, defaultTools: ["read", "sample_two"] };
	await explicit.reload();
	assert.deepEqual(explicit.getActiveToolNames(), ["read"], "explicit CLI-style selection wins over new defaults");
} finally { await explicit.extensionRunner.emit({ type: "session_shutdown" }); explicit.dispose(); }
stored = { ...stored, defaultTools: ["read"] };
await settings.reload();
const interactive = await create(["read"]);
const { Container, TuiMainScreen, visibleWidth } = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href);
SDK.initTheme("dark", false);
const { theme } = await import(pathToFileURL(join(host, "dist/modes/interactive/theme/theme.js")).href);
const root = new Container(), mounted = new Map(), errors = [];
const terminal = { columns: 80, rows: 44, write() {}, start() {}, stop() {}, hideCursor() {}, showCursor() {},
	moveBy() {}, clearLine() {}, clearFromCursor() {}, setTitle() {}, drainInput: async () => {} };
const tui = new TuiMainScreen(terminal);
tui.requestRender = () => {};
tui.addChild(root);
const ui = { theme, notify() {}, getToolsExpanded: () => true, getThinkingVisible: () => false,
	getEditorText: () => "", setEditorText() {}, requestRender() {}, onTerminalInput: () => () => {},
	setStatus() {}, setTitle() {},
	setWidget(key, factory) { if (factory) mounted.set(key, factory(tui, theme)); else mounted.delete(key); },
	setHeader(factory) { if (factory) mounted.set("header", factory(tui, theme)); else mounted.delete("header"); },
	setFooter(factory) {
		mounted.get("footer")?.dispose?.();
		if (factory) mounted.set("footer", factory(tui, theme, {
			onBranchChange: () => () => {}, getExtensionStatuses: () => new Map(), getGitBranch: () => undefined,
		})); else mounted.delete("footer");
	},
};
const message = { role: "assistant", api: "reload-fixture", provider: "reload-fixture", model: "fixture",
	timestamp: 1700000000000, stopReason: "toolUse",
	content: [{ type: "toolCall", id: "reload-read", name: "read", arguments: { path: join(base, "fixture.txt") } }],
	usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
interactive.sessionManager.appendMessage(message);
let assistant, tool;
const rebuild = () => {
	root.clear();
	assistant = new SDK.AssistantMessageComponent(message, true);
	root.addChild(assistant);
	tool = new SDK.ToolExecutionComponent("read", "reload-read", { path: join(base, "fixture.txt") },
		{ showImages: false }, interactive.getToolDefinition("read"), tui, cwd);
	tool.markExecutionStarted();
	tool.updateResult({ content: [{ type: "text", text: "Synthetic retained row." }], details: {}, isError: false });
	root.addChild(tool);
};
try {
	rebuild();
	await interactive.bindExtensions({ mode: "tui", uiContext: ui, onError: (error) => errors.push(error) });
	await interactive.prompt("/ccstyle compact");
	for (let cycle = 0; cycle < 2; cycle++) {
		const oldTool = tool;
		await interactive.reload({ beforeSessionStart: async () => {
			assert.equal(SDK.ToolExecutionComponent.prototype.getCallRenderer, original, "reload releases old patches before native rebuild");
			rebuild();
		} });
		assert.notEqual(tool, oldTool);
		assert.deepEqual([...mounted.keys()].sort(), ["header", "footer", "pi-ui-bridge"].sort());
		assert.notEqual(SDK.ToolExecutionComponent.prototype.getCallRenderer, original);
		assert.equal(tool.getCallRenderer, SDK.ToolExecutionComponent.prototype.getCallRenderer);
		assert.equal(assistant.expanded, true, "new transcript follows global tool expansion after actual reload");
		for (const width of [40, 80, 120]) for (const line of tool.render(width))
			assert.ok(visibleWidth(line) <= width);
	}
	assert.deepEqual(errors, []);
} finally {
	await interactive.extensionRunner.emit({ type: "session_shutdown" });
	interactive.dispose();
	assert.deepEqual([...mounted.keys()], []);
	assert.equal(SDK.ToolExecutionComponent.prototype.getCallRenderer, original);
}
console.log("reload/defaultTools: addition, removal, manual disable, re-addition and explicit selection verified; two TUI transcript reloads verified");
`;

test("actual Pi 1.0.2 reload preserves defaultTools and replaces two TUI transcript generations", { timeout: 30000 }, async () => {
	const sandbox = await createSandbox();
	try {
		const path = join(sandbox.base, "reload-worker.mjs");
		await writeFile(path, worker);
		const result = await runChild(sandbox, ["--import", join(sandbox.base, "safety.mjs"), path, sandbox.host.directory]);
		assert.equal(result.code, 0, result.stderr);
		assert.match(result.stdout, /reload\/defaultTools: addition/);
		assert.equal(result.stderr, "");
	} finally { await sandbox.cleanup(); }
});
