import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const host = process.argv[2], base = process.env.TMPDIR, cwd = process.cwd();
const SDK = await import(pathToFileURL(join(host, "dist/index.js")).href);
const require = createRequire(join(host, "package.json"));
const { Text, Container, TuiAltScreen } = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href);
const { Type } = await import(pathToFileURL(require.resolve("typebox")).href);
// Pinned test-only imports: no auth file lookup and the same merge used by InteractiveMode.
const { AuthStorage } = await import(pathToFileURL(join(host, "dist/core/auth-storage.js")).href);
const { withBuiltInRenderers } = await import(pathToFileURL(join(host, "dist/core/tools/renderers/index.js")).href);
const credentials = AuthStorage.inMemory();
const runtime = await SDK.ModelRuntime.create({ credentials, modelsPath: null,
	modelsStorePath: join(base, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
runtime.registerProvider("renderer-probe", { api: "renderer-probe", apiKey: "synthetic", baseUrl: "https://invalid.invalid",
	models: [{ id: "fixture", name: "Fixture", input: ["text"], reasoning: false, contextWindow: 32768,
		maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	streamSimple() { throw new Error("renderer acceptance must never request a model"); } });
const settings = SDK.SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false } });
const retained = "OUTPUT_START\n" + Array.from({ length: 60 }, (_, index) => `retained output ${index + 1}`).join("\n") + "\nOUTPUT_END <retained>";
const renderers = (label) => ({
	renderShell: "self",
	renderCall: (args) => new Text(`${label} input: ${args.query}`, 0, 0),
	renderResult: (result, { expanded }) => new Text(`${label} output:\n${expanded ? result.content[0].text : result.content[0].text.split("\n").slice(0, 3).join("\n")}`, 0, 0),
});
const loader = new SDK.DefaultResourceLoader({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager: settings,
	noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	additionalExtensionPaths: [process.env.PI_UI_STAGE],
	extensionFactories: [
		(pi) => pi.registerToolRenderer((name, next) => {
			const downstream = next();
			if (name !== "plain_probe" && name !== "mcp__synthetic__unconnected") return downstream;
			return { ...downstream, renderCall: (args) => new Text(`FIRST input: ${args.query}`, 0, 0) };
		}),
		(pi) => {
			pi.registerToolRenderer((name, next) => {
				const downstream = next();
				// A registered definition is truthy even without renderer functions.
				return (name === "plain_probe" || name === "mcp__synthetic__unconnected") && !downstream?.renderCall && !downstream?.renderResult
					? renderers("PUBLIC") : downstream;
			});
			pi.registerTool({ name: "plain_probe", label: "Plain probe", description: "Synthetic rendererless operation", exposure: "deferred",
				parameters: Type.Object({ query: Type.String() }),
				execute: async (_id, args) => {
					await appendFile(join(cwd, "executed.txt"), `${args.query}\n`);
					return { content: [{ type: "text", text: retained }], details: { retained: true } };
				},
			});
			pi.registerTool({ name: "read", label: "Read override", description: "Same name, different schema", exposure: "deferred",
				parameters: Type.Object({ query: Type.String() }), ...renderers("OVERRIDE"),
				execute: async (_id, args) => ({ content: [{ type: "text", text: `answer to ${args.query}` }], details: {} }),
			});
		},
	],
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const sm = SDK.SessionManager.create(cwd, join(base, "sessions"));
const { session } = await SDK.createAgentSession({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR,
	modelRuntime: runtime, model: runtime.getModel("renderer-probe", "fixture"), resourceLoader: loader,
	settingsManager: settings, sessionManager: sm, thinkingLevel: "off" });
SDK.initTheme("dark", false);
const { theme } = await import(pathToFileURL(join(host, "dist/modes/interactive/theme/theme.js")).href);
const terminal = { columns: 120, rows: 44, write() {}, start() {}, stop() {}, hideCursor() {}, showCursor() {},
	moveBy() {}, clearLine() {}, clearFromCursor() {}, setTitle() {}, drainInput: async () => {} };
const tui = new TuiAltScreen(terminal), root = new Container(), mounted = new Map(), errors = [];
tui.requestRender = () => {};
tui.addChild(root);
const plain = (component) => component.render(120).map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")).join("\n");
const resolve = (name) => session.extensionRunner.resolveToolRenderers(name, () => withBuiltInRenderers(name, session.getToolDefinition(name)));
const row = (name, id, args, result) => {
	const component = new SDK.ToolExecutionComponent(name, id, args, { showImages: false }, resolve(name), tui, cwd);
	component.markExecutionStarted(); component.updateResult(result); root.addChild(component);
	return component;
};
try {
	await session.bindExtensions({ mode: "tui", onError: (error) => errors.push(error), uiContext: {
		...session.extensionRunner.getUIContext(), theme, getToolsExpanded: () => false,
		setHeader: (factory) => factory ? mounted.set("header", factory(tui, theme)) : mounted.delete("header"),
		setFooter: (factory) => {
			mounted.get("footer")?.dispose?.();
			if (!factory) mounted.delete("footer");
			else mounted.set("footer", factory(tui, theme, { onBranchChange: () => () => {},
				getExtensionStatuses: () => new Map(), getGitBranch: () => undefined }));
		},
		setWidget: (name, factory) => factory ? mounted.set(name, factory(tui, theme)) : mounted.delete(name),
	} });
	assert.deepEqual(errors, []);
	assert.ok(mounted.has("footer"), "actual compiled UI extension starts under this host");
	const command = session.extensionRunner.getRegisteredCommands().find((item) => item.name === "ccstyle");
	await command.handler("off", session.extensionRunner.createCommandContext());
	const native = row("bash", "builtin", { command: "synthetic-only" }, { content: [{ type: "text", text: retained }], details: {} });
	assert.match(plain(native), /earlier lines/);
	assert.match(plain(native), /OUTPUT_END/);
	native.setExpanded(true); assert.match(plain(native), /OUTPUT_START/);
	const unknown = row("mcp__synthetic__unconnected", "history", { query: "no server needed" }, { content: [{ type: "text", text: "unconnected result" }], details: {} });
	assert.match(plain(unknown), /FIRST input: no server needed/);
	assert.match(plain(unknown), /PUBLIC output/);
	assert.match(plain(unknown), /unconnected result/);
	const overridden = session.getToolDefinition("read");
	const overrideResult = await overridden.execute("override", { query: "not a path" });
	const custom = row("read", "override", { query: "not a path" }, overrideResult);
	assert.match(plain(custom), /OVERRIDE input: not a path/);
	assert.match(plain(custom), /answer to not a path/);

	const args = { query: "INPUT_START <synthetic> INPUT_END" };
	const definition = session.getToolDefinition("plain_probe");
	const result = await definition.execute("exported", args);
	const displayed = row("plain_probe", "exported", args, result);
	assert.match(plain(displayed), /FIRST input: INPUT_START/);
	assert.doesNotMatch(plain(displayed), /OUTPUT_END/);
	displayed.setExpanded(true); assert.match(plain(displayed), /OUTPUT_END/);
	await definition.execute("second", args);
	assert.equal(await readFile(join(cwd, "executed.txt"), "utf8"), "INPUT_START <synthetic> INPUT_END\nINPUT_START <synthetic> INPUT_END\n");
	assert.deepEqual(args, { query: "INPUT_START <synthetic> INPUT_END" });
	assert.deepEqual(result, { content: [{ type: "text", text: retained }], details: { retained: true } });
	const info = session.getAllTools().find((tool) => tool.name === "plain_probe");
	assert.equal(info.exposure, "deferred");
	assert.equal(session.getActiveToolNames().includes("plain_probe"), false);
	assert.deepEqual(JSON.parse(JSON.stringify(info.parameters)), {
		type: "object", properties: { query: { type: "string" } }, required: ["query"],
	});

	sm.appendMessage({ role: "user", content: "Synthetic export probe only", timestamp: 1 });
	sm.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "exported", name: "plain_probe", arguments: args }],
		api: "renderer-probe", provider: "renderer-probe", model: "fixture", stopReason: "toolUse", timestamp: 2,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
	sm.appendMessage({ role: "toolResult", toolCallId: "exported", toolName: "plain_probe", ...result, isError: false, timestamp: 3 });
	const exported = await session.exportToHtml(join(base, "renderer-export.html"));
	const html = await readFile(exported, "utf8");
	const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
	assert.ok(encoded, "real exporter emitted its page payload");
	// Inspect the rendered HTML fragments consumed by the export page, NOT entries/messages.
	const fragments = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")).renderedTools.exported;
	assert.match(fragments.callHtml, /FIRST input: INPUT_START &lt;synthetic&gt; INPUT_END/);
	assert.match(fragments.resultHtmlExpanded, /PUBLIC output:/);
	assert.match(fragments.resultHtmlExpanded, /OUTPUT_START/);
	assert.match(fragments.resultHtmlExpanded, /OUTPUT_END &lt;retained&gt;/);
	assert.doesNotMatch(fragments.resultHtmlCollapsed, /OUTPUT_END/);
	assert.deepEqual(errors, []);
} finally {
	await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	session.dispose();
	for (const component of mounted.values()) component.dispose?.();
	tui.stopSelectionAutoScroll(); tui.stopScrollbarHover(); tui.stopScrollbarDrag();
}
assert.deepEqual(await credentials.list(), []);
assert.equal(existsSync(join(process.env.PI_CODING_AGENT_DIR, "auth.json")), false);
