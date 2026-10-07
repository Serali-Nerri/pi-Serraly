import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	createAgentSession, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { TuiMainScreen, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
// Test-only pinned host imports: these are not root-exported by Pi 1.0.4.
import { AuthStorage } from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
import { theme } from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import contextView from "../../src/index.ts";

export const strip = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

/** Real SDK/session/command boundary; only the terminal and request-local transport are scripted. */
export async function host(options: { factories?: ExtensionFactory[]; mode?: "tui" | "print" } = {}) {
	assert.ok(process.env.PI_CODING_AGENT_DIR, "Use the isolated runner");
	const base = await mkdtemp(join(process.env.TMPDIR!, "context-view-host-"));
	const cwd = join(base, "cwd"), agentDir = join(base, "agent");
	await mkdir(cwd, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	let requests = 0, executions = 0, runs = 0;
	const bodies: unknown[] = [];
	const api = "context-view-test-anthropic";
	const providerOwner = "context-view-test";
	const fetch: typeof globalThis.fetch = async (_input, init) => {
		requests++;
		const body = JSON.parse(String(init?.body));
		bodies.push(body);
		const events = [
			{ type: "message_start", message: { id: `msg_${requests}`, type: "message", role: "assistant", content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Local fixture reply." } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } },
			{ type: "message_stop" },
		];
		return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
			status: 200, headers: { "content-type": "text/event-stream" },
		});
	};
	registerApiProvider({ api,
		stream: (model, context, opts) => stream({ ...model, api: "anthropic-messages" }, context, { ...opts, fetch, apiKey: "fixture", maxRetries: 0, timeoutMs: 5000 }),
		streamSimple: (model, context, opts) => streamSimple({ ...model, api: "anthropic-messages" }, context, { ...opts, fetch, apiKey: "fixture", maxRetries: 0, timeoutMs: 5000 }),
	}, providerOwner);
	const credentials = AuthStorage.inMemory();
	const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null,
		modelsStorePath: join(base, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
	modelRuntime.registerProvider("context-view-fixture", {
		api, apiKey: "fixture", baseUrl: "https://example.invalid",
		models: [{ id: "local", name: "Local fake model", reasoning: false, input: ["text"], contextWindow: 65536, maxTokens: 2048,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	});
	const settingsManager = SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false },
		enableAnalytics: false, enableInstallTelemetry: false, defaultProjectTrust: "never" });
	const fixture: ExtensionFactory = (pi) => {
		pi.registerTool({ name: "fixture_tool", label: "fixture_tool", description: "Local operation", exposure: "direct",
			parameters: Type.Object({}), async execute() { executions++; return { content: [{ type: "text", text: "done" }], details: {} }; } });
		pi.on("before_agent_start", () => ({ systemPrompt: `${++runs === 1 ? "FIRST" : "SECOND"}_CJK_指令\n\nLocal fixture prompt.` }));
		pi.on("context", (event) => ({ messages: [...event.messages,
			{ role: "custom", customType: "fixture-injection", content: "INITIAL_PRIVATE_CONTENT", display: false, timestamp: 1234 }] }));
	};
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true,
		noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [fixture, ...options.factories ?? [contextView]] });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const sessionManager = SessionManager.inMemory(cwd);
	const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model: modelRuntime.getModel("context-view-fixture", "local"),
		settingsManager, resourceLoader: loader, sessionManager, noTools: "builtin", thinkingLevel: "off" });
	const errors: unknown[] = [], notices: string[] = [], overlays: Component[] = [];
	const terminal = { columns: 80, rows: 44, write() {}, start() {}, stop() {}, hideCursor() {}, showCursor() {},
		moveBy() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, kittyProtocolActive: false, drainInput: async () => {} };
	const tui = new TuiMainScreen(terminal);
	tui.requestRender = () => {};
	initTheme("dark", false);
	const uiContext: any = {
		theme, notify: (message: string) => notices.push(message), getToolsExpanded: () => false, getThinkingVisible: () => false,
		getEditorText: () => "", setEditorText() {}, requestRender() {}, onTerminalInput: () => () => {},
		setStatus() {}, setTitle() {}, setWidget() {}, setHeader() {}, setFooter() {}, setWorkingVisible() {},
		custom(factory: any) {
			return new Promise((done) => {
				const component: Component = factory(tui, theme, {}, done);
				for (const width of [40, 80, 120]) for (const line of component.render(width))
					assert.ok(visibleWidth(line) <= width, `overlay fits ${width}`);
				overlays.push(component);
				queueMicrotask(() => done(undefined));
			});
		},
	};
	await session.bindExtensions({ uiContext, mode: options.mode ?? "tui", onError: (error) => errors.push(error) });
	return {
		session, sessionManager, loader, settingsManager, credentials, overlays, notices, errors, bodies, base,
		get requests() { return requests; }, get executions() { return executions; },
		text() { return strip(overlays.at(-1)!.render(100).join("\n")); },
		async close() {
			await session.abort();
			await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
			await settingsManager.flush();
			unregisterApiProviders(providerOwner);
			await rm(base, { recursive: true, force: true });
		},
	};
}
