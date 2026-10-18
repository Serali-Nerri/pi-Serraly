import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const { createSandbox } = await import(new URL("../../../scripts/preview.mjs", import.meta.url).href);
const { runChild } = await import(new URL("../../../scripts/lib/process.mjs", import.meta.url).href);

const worker = String.raw`
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [host, phase] = process.argv.slice(2), base = process.env.TMPDIR, cwd = process.cwd();
const SDK = await import(pathToFileURL(join(host, "dist/index.js")).href);
const require = createRequire(join(host, "package.json"));
const { createAssistantMessageEventStream } = await import(pathToFileURL(join(host, "../pi-ai/dist/index.js")).href);
const { Container, TuiMainScreen } = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href);
const { CustomEntryComponent } = await import(pathToFileURL(join(host, "dist/modes/interactive/components/custom-entry.js")).href);
const { AuthStorage } = await import(pathToFileURL(join(host, "dist/core/auth-storage.js")).href);
SDK.initTheme("dark", false);
const { theme } = await import(pathToFileURL(join(host, "dist/modes/interactive/theme/theme.js")).href);
let requests = 0;
const runtime = await SDK.ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null,
	modelsStorePath: join(base, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
runtime.registerProvider("completion-fixture", { api: "completion-fixture", apiKey: "synthetic", baseUrl: "https://invalid.invalid",
	models: [{ id: "fixture", name: "Fixture", input: ["text"], reasoning: false, contextWindow: 32768,
		maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	streamSimple(model, context) {
		requests++;
		assert.deepEqual(context.messages.map((message) => message.role), phase === "record"
			? ["user"] : ["user", "assistant", "user"], "timing metadata must not enter the next provider request");
		const stream = createAssistantMessageEventStream();
		const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
			timestamp: Date.now(), stopReason: "stop", content: [{ type: "text", text: "Saved final response." }],
			usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message }); stream.end(); });
		return stream;
	},
});
const settings = SDK.SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } });
const loader = new SDK.DefaultResourceLoader({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager: settings,
	noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	additionalExtensionPaths: [process.env.PI_UI_STAGE] });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const pathFile = join(base, "completion-session-path");
const manager = phase === "record" ? SDK.SessionManager.create(cwd, join(base, "saved-sessions"))
	: SDK.SessionManager.open((await readFile(pathFile, "utf8")).trim());
const { session } = await SDK.createAgentSession({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR,
	modelRuntime: runtime, settingsManager: settings, resourceLoader: loader, sessionManager: manager,
	model: runtime.getModel("completion-fixture", "fixture"), tools: [] });
const root = new Container(), errors = [], mounted = new Map();
const terminal = { columns: 80, rows: 44, write() {}, start() {}, stop() {}, hideCursor() {}, showCursor() {},
	moveBy() {}, clearLine() {}, clearFromCursor() {}, setTitle() {}, drainInput: async () => {} };
const tui = new TuiMainScreen(terminal);
tui.requestRender = () => {};
tui.addChild(root);
const ui = { theme, notify(message, type) { if (type === "warning" || type === "error") errors.push(message); },
	getToolsExpanded: () => false, getThinkingVisible: () => false, getEditorText: () => "", setEditorText() {},
	requestRender() {}, onTerminalInput: () => () => {}, setStatus() {}, setTitle() {},
	setWidget(key, factory) { if (factory) mounted.set(key, factory(tui, theme)); else mounted.delete(key); },
	setFooter(factory) {
		mounted.get("footer")?.dispose?.();
		if (factory) mounted.set("footer", factory(tui, theme, {
			onBranchChange: () => () => {}, getExtensionStatuses: () => new Map(), getGitBranch: () => undefined,
		})); else mounted.delete("footer");
	},
};
const type = "pi-ui-activity-completion";
const renderEntry = (entry) => {
	if (entry.type === "message" && entry.message.role === "assistant")
		root.addChild(new SDK.AssistantMessageComponent(entry.message, false));
	if (entry.type === "custom") {
		const renderer = session.extensionRunner.getEntryRenderer(entry.customType);
		if (renderer) root.addChild(new CustomEntryComponent(entry, renderer));
	}
};
const records = () => manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === type);
const rows = () => root.render(80).map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim());
const completionRow = () => rows().find((line) => /^Worked for (?:<1s|\d+m? ?\d*s?) · \d{2}:\d{2}:\d{2}$/.test(line));
const unsubscribe = session.subscribe((event) => {
	if (event.type === "entry_appended") renderEntry(event.entry);
	if (event.type === "message_end" && event.message.role === "assistant")
		renderEntry({ type: "message", message: event.message });
});
try {
	await session.bindExtensions({ mode: "tui", uiContext: ui, onError: (error) => errors.push(error) });
	if (phase === "record") {
		await session.prompt("Show a synthetic final response.");
		assert.equal(requests, 1);
		assert.equal(records().length, 1);
		assert.ok(completionRow(), rows().join("\n"));
		assert.ok(rows().indexOf(completionRow()) > rows().findIndex((line) => line.includes("Saved final response.")));
		await writeFile(pathFile, manager.getSessionFile());
		await writeFile(join(base, "completion-row"), completionRow());
	} else {
		assert.equal(records().length, 1, "the saved activity reopens in another process");
		for (const entry of manager.getBranch()) renderEntry(entry);
		assert.equal(completionRow(), await readFile(join(base, "completion-row"), "utf8"));
		assert.ok(rows().indexOf(completionRow()) > rows().findIndex((line) => line.includes("Saved final response.")));
		await session.reload({ beforeSessionStart: async () => root.clear() });
		for (const entry of manager.getBranch()) renderEntry(entry);
		assert.equal(completionRow(), await readFile(join(base, "completion-row"), "utf8"));
		await session.prompt("Continue without timing metadata in the context.");
		assert.equal(requests, 1);
		assert.equal(records().length, 2, "reopening and reload must not create extra records");
	}
	assert.deepEqual(errors, []);
	console.log("completion " + phase + ": persisted transcript and context isolation verified");
} finally {
	unsubscribe();
	await session.extensionRunner.emit({ type: "session_shutdown" });
	session.dispose();
	assert.equal(mounted.size, 0);
}
`;

test("saved completion survives another host process and reload without entering model context", { timeout: 45000 }, async () => {
	const sandbox = await createSandbox();
	try {
		const path = join(sandbox.base, "completion-worker.mjs");
		await writeFile(path, worker);
		for (const phase of ["record", "replay"]) {
			const result = await runChild(sandbox, ["--import", join(sandbox.base, "safety.mjs"), path, sandbox.host.directory, phase]);
			assert.equal(result.code, 0, result.stderr);
			assert.match(result.stdout, new RegExp(`completion ${phase}: persisted transcript and context isolation verified`));
			assert.equal(result.stderr, "");
		}
	} finally { await sandbox.cleanup(); }
});
