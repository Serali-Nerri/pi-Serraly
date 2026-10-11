import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Keep host and extension imports out of this process: npm test's environment
// can originate in a real session. Only the allowlisted children load Pi/UI.
const previewPath = fileURLToPath(new URL("../../../scripts/preview.mjs", import.meta.url));
const capturePath = fileURLToPath(new URL("../../../scripts/capture.mjs", import.meta.url));
const environmentPath = fileURLToPath(new URL("../../../scripts/lib/environment.mjs", import.meta.url));
const hostPath = fileURLToPath(new URL("../../../scripts/lib/host.mjs", import.meta.url));
const processPath = fileURLToPath(new URL("../../../scripts/lib/process.mjs", import.meta.url));
const { createSandbox, cliArguments, reports } = await import(pathToFileURL(previewPath).href);
const { isolatedEnvironment } = await import(pathToFileURL(environmentPath).href);
const { expectedVersion } = await import(pathToFileURL(hostPath).href);
const { runChild } = await import(pathToFileURL(processPath).href);
const { capturePty, ptyAvailability } = await import(pathToFileURL(capturePath).href);
type Diagnostic = { phase: string; starts: number; timers: number; activeTimers: number; providerCalls: number;
	mode?: string; hasUI?: boolean; columns?: number; tuiMode?: string; toolCount?: number;
	calls: { method: string; key?: string; install: boolean }[]; notices: { message: string; type: string }[] };
type Sandbox = { base: string; cwd: string; env: NodeJS.ProcessEnv; host: { directory: string; cli: string }; cleanup(): Promise<void> };

function diagnosticChecks(entries: Diagnostic[], mode?: string): Diagnostic {
	assert.ok(entries.some((entry) => entry.phase === "factory"), "the compiled ESM factory really loaded");
	assert.ok(!entries.some((entry) => ["network-denied", "fixture-error"].includes(entry.phase)), JSON.stringify(entries));
	const shutdown = [...entries].reverse().find((entry) => entry.phase === "shutdown");
	assert.ok(shutdown, "diagnostic shutdown assertions ran after UI cleanup");
	assert.equal(shutdown.activeTimers, 0);
	if (mode) assert.equal(shutdown.mode, mode);
	return shutdown;
}

async function noPersistentSession(sandbox: Sandbox, expectedFiles: string[] = []) {
	assert.deepEqual((await readdir(sandbox.cwd)).sort(), [...expectedFiles].sort(), "only the selected profile's temporary fixtures exist");
	const sessionDir = join(sandbox.env.PI_CODING_AGENT_DIR!, "sessions");
	if (existsSync(sessionDir)) assert.deepEqual(await readdir(sessionDir), [], "--no-session must not persist history");
	assert.equal(existsSync(join(sandbox.base, "node_modules")), false);
	assert.equal(existsSync(join(sandbox.base, "pi-ui/node_modules")), false);
	assert.ok(existsSync(join(sandbox.base, "pi-ui/licenses/LICENSES/marked.txt")), "the external runtime stage retains grammar attribution/license");
}

test("spawn environment is an allowlist, not a credential/session blacklist", () => {
	const env = isolatedEnvironment("/tmp/synthetic-environment-test");
	for (const key of Object.keys(env)) assert.ok(!/(API_KEY|TOKEN|SECRET|SESSION_|NODE_OPTIONS|PROXY|AWS_|GOOGLE_|AZURE_)/.test(key), key);
	assert.equal(env.PI_OFFLINE, "1");
	assert.equal(env.HOME, "/tmp/synthetic-environment-test/home");
});

test("actual bundled CLI version; --help loads factories but starts no session", { timeout: 30000 }, async () => {
	const sandbox: Sandbox = await createSandbox();
	try {
		const version = await runChild(sandbox, ["--import", join(sandbox.base, "safety.mjs"), sandbox.host.cli, "--offline", "--version"]);
		assert.equal(version.code, 0, version.stderr);
		assert.equal(version.stdout.trim(), expectedVersion);
		const help = await runChild(sandbox, cliArguments(sandbox, ["--help"]));
		assert.equal(help.code, 0, help.stderr);
		assert.equal(help.stderr, "");
		assert.match(help.stdout, /--no-extensions/);
		const entries: Diagnostic[] = await reports(sandbox);
		assert.deepEqual(entries.map((entry) => entry.phase), ["guard-factory", "factory"]);
		assert.ok(entries.every((entry) => entry.starts === 0 && entry.timers === 0 && entry.providerCalls === 0));
		await noPersistentSession(sandbox);
	} finally { await sandbox.cleanup(); }
});

for (const mode of ["print", "json"] as const) {
	test(`bundled CLI ${mode}: commands and scripted tool loop never patch TUI or start UI timers`, { timeout: 30000 }, async () => {
		const sandbox: Sandbox = await createSandbox();
		try {
			const args = mode === "print" ? ["--print"] : ["--mode", "json"];
			const result = await runChild(sandbox, cliArguments(sandbox, [...args, "/ccstyle status", "Show the synthetic fixture"]));
			assert.equal(result.code, 0, result.stderr);
			assert.equal(result.stderr, "");
			const entries: Diagnostic[] = await reports(sandbox);
			const final = diagnosticChecks(entries, mode);
			assert.equal(final.providerCalls, 2, "real agent loop: tool call, built-in read, final response");
			assert.equal(final.timers, 0);
			assert.deepEqual(final.calls, []);
			assert.ok(final.notices.some((notice) => /mode=on/.test(notice.message)), "/ccstyle status executed");
			const start = entries.find((entry) => entry.phase === "session-start");
			assert.equal(start?.hasUI, false);
			if (mode === "print") assert.match(result.stdout, /Stage-one fixture complete/);
			else {
				// LF-only framing: U+2028/U+2029 are legal JSON string contents.
				const records = result.stdout.trim().split("\n").map((line: string) => JSON.parse(line));
				assert.equal(records[0].type, "session");
				assert.equal(records[0].cwd, sandbox.cwd);
				assert.ok(records.some((record: any) => record.type === "tool_execution_end" && record.toolName === "read" && !record.isError));
				assert.ok(records.some((record: any) => record.type === "agent_settled"));
				assert.ok(records.some((record: any) => record.type === "message_end" && record.message.role === "assistant" && record.message.stopReason === "stop"));
			}
			await noPersistentSession(sandbox);
		} finally { await sandbox.cleanup(); }
	});
}

test("bundled RPC: hasUI=true is not TUI; exact command surface, handled commands, orderly stdin shutdown", { timeout: 30000 }, async () => {
	const sandbox: Sandbox = await createSandbox();
	const child = spawn(process.execPath, cliArguments(sandbox, ["--mode", "rpc"]), { cwd: sandbox.cwd, env: sandbox.env, stdio: "pipe" });
	const records: any[] = [];
	const decoder = new StringDecoder("utf8");
	let buffer = "", stderr = "", parseError: Error | undefined;
	child.stdout.on("data", (chunk: Buffer) => {
		buffer += decoder.write(chunk);
		while (buffer.includes("\n")) {
			const index = buffer.indexOf("\n");
			const line = buffer.slice(0, index).replace(/\r$/, "");
			buffer = buffer.slice(index + 1);
			try { records.push(JSON.parse(line)); } catch (error) { parseError = error as Error; }
		}
	});
	child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
	const closed = new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("close", done); });
	// Attach the rejection handler immediately, before the first polling await.
	void closed.catch(() => {});
	const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
	async function waitFor(predicate: (record: any) => boolean) {
		const deadline = Date.now() + 15000;
		while (!records.some(predicate)) {
			if (parseError) throw parseError;
			assert.equal(child.exitCode, null, stderr);
			assert.ok(Date.now() < deadline, `RPC deadline: ${stderr}\n${JSON.stringify(records)}`);
			await new Promise((done) => setTimeout(done, 10));
		}
		return records.find(predicate);
	}
	async function request(id: string, type: string, data = {}) {
		child.stdin.write(JSON.stringify({ id, type, ...data }) + "\n");
		const result = await waitFor((record) => record.type === "response" && record.id === id);
		assert.equal(result.success, true, JSON.stringify(result));
		return result.data;
	}
	try {
		const state = await request("state", "get_state");
		assert.equal(state.sessionFile, undefined);
		assert.equal(state.model.provider, "stage-one-fixture");
		const commands = await request("commands", "get_commands");
		assert.deepEqual(commands.commands.map((command: any) => command.name).sort(), ["ccstyle"]);
		for (const [id, message] of [["status", "/ccstyle status"], ["panel", "/ccstyle panel"]]) {
			assert.equal((await request(id, "prompt", { message })).disposition, "handled");
		}
		assert.equal((await request("run", "prompt", { message: "Show the synthetic fixture" })).disposition, "started");
		await waitFor((record) => record.type === "agent_settled");
		const messages = await request("messages", "get_messages");
		assert.ok(messages.messages.some((message: any) => message.role === "toolResult" && message.toolName === "read" && !message.isError));
		child.stdin.end(); // Pi 1.1.0 RPC's documented explicit exit mechanism.
		assert.equal(await closed, 0, stderr);
		buffer += decoder.end();
		assert.equal(buffer, "", "strict JSONL final record is LF terminated");
		assert.equal(parseError, undefined);
		assert.equal(stderr, "");
		assert.ok(!records.some((record) => record.type === "extension_error"));
		const notices = records.filter((record) => record.type === "extension_ui_request");
		assert.ok(notices.every((record) => record.method === "notify"), "no TUI bridge/widget/status calls in RPC");
		assert.ok(notices.some((record) => /requires TUI mode/.test(record.message)));
		const final = diagnosticChecks(await reports(sandbox), "rpc");
		assert.equal(final.timers, 0);
		assert.equal(final.providerCalls, 2);
		assert.deepEqual(final.calls, []);
		assert.equal((await reports(sandbox)).find((entry: Diagnostic) => entry.phase === "session-start").hasUI, true);
		await noPersistentSession(sandbox);
	} finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); await closed.catch(() => {}); await sandbox.cleanup(); }
});

// A real SDK session and real public ExtensionRunner, but a synthetic terminal.
// This is intentionally separate from the live CLI PTY identity checks below.
const sdkWorker = String.raw`
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const host = process.argv[2];
const SDK = await import(pathToFileURL(join(host, "dist/index.js")).href);
const require = createRequire(join(host, "package.json"));
const { TuiMainScreen, visibleWidth } = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href);
const { ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader, createAgentSession } = SDK;
// 1.1.0 declares AuthStorage.inMemory in dist/core/auth-storage.d.ts but does
// not re-export AuthStorage from its SDK root. This test-only import is pinned.
const { AuthStorage } = await import(pathToFileURL(join(host, "dist/core/auth-storage.js")).href);
const cwd = process.cwd(), agentDir = process.env.PI_CODING_AGENT_DIR, base = process.env.TMPDIR;
const settingsManager = SettingsManager.inMemory({ theme: "dark", hideThinkingBlock: true,
	cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } });
const credentials = AuthStorage.inMemory();
const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null,
	modelsStorePath: join(base, "sdk-models-cache.json"), allowModelNetwork: false, refreshOnCreate: false });
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true,
	noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	additionalExtensionPaths: [join(base, "guard.js"), process.env.PI_UI_STAGE, join(base, "fixture.js")] });
await loader.reload();
const loaded = loader.getExtensions();
assert.deepEqual(loaded.errors, []);
assert.equal(loaded.extensions.length, 3);
const uiExtension = loaded.extensions.find((extension) => extension.path === process.env.PI_UI_STAGE);
assert.equal(uiExtension.tools.size, 0);
assert.deepEqual([...uiExtension.commands.keys()].sort(), ["ccstyle"]);
assert.equal(uiExtension.flags.size, 0);
assert.equal(uiExtension.shortcuts.size, 0);
for (const [event, handlers] of uiExtension.handlers) assert.equal(handlers.length, 1, "one lifecycle router: " + event);
const command = uiExtension.commands.get("ccstyle");
assert.deepEqual(command.getArgumentCompletions("").map((item) => item.value), ["on", "compact", "off", "status", "panel"]);
assert.deepEqual(command.getArgumentCompletions("o").map((item) => item.value), ["on", "off"]);
const sessionManager = SessionManager.inMemory(cwd);
// SDK startup selects a model before the runner flushes queued registrations;
// install the same deterministic provider in the explicit runtime first.
for (const { name, config } of loaded.runtime.pendingProviderRegistrations) modelRuntime.registerProvider(name, config);
const model = modelRuntime.getModel("stage-one-fixture", "fixture");
assert.ok(model);
const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, resourceLoader: loader,
	settingsManager, sessionManager, tools: ["read"], model, thinkingLevel: "off" });
assert.equal(session.model.provider, "stage-one-fixture");
const state = globalThis[Symbol.for("pi-ui.integration-state")];
const errors = [], notices = [], mounted = new Map(), overlays = [];
const terminal = { columns: 80, rows: 44, write() {}, start() {}, stop() {}, hideCursor() {}, showCursor() {},
	moveBy() {}, clearLine() {}, clearFromCursor() {}, setTitle() {}, drainInput: async () => {} };
const tui = new TuiMainScreen(terminal);
tui.requestRender = () => {};
SDK.initTheme("dark", false);
const { theme } = await import(pathToFileURL(join(host, "dist/modes/interactive/theme/theme.js")).href);
const ui = { theme, notify: (message, type) => notices.push({ message, type }), getToolsExpanded: () => false,
	getThinkingVisible: () => false, getEditorText: () => "", setEditorText() {}, requestRender() {},
	onTerminalInput: () => () => {}, setStatus() {}, setTitle() {},
	setWidget(key, factory) { if (!factory) mounted.delete(key); else mounted.set(key, factory(tui, theme)); },
	setHeader(factory) { if (!factory) mounted.delete("header"); else mounted.set("header", factory(tui, theme)); },
	setFooter(factory) {
		mounted.get("footer")?.dispose?.();
		if (!factory) mounted.delete("footer");
		else mounted.set("footer", factory(tui, theme, { onBranchChange: () => () => {},
			getExtensionStatuses: () => new Map(), getGitBranch: () => undefined }));
	},
	custom(factory) {
		return new Promise((done) => {
			const component = factory(tui, theme, {}, done);
			for (const width of [40, 80, 120]) for (const line of component.render(width))
				assert.ok(visibleWidth(line) <= width, "synthetic overlay fits " + width);
			overlays.push(component);
			queueMicrotask(() => done(undefined));
		});
	},
};
try {
	await session.bindExtensions({ uiContext: ui, mode: "print", onError: (error) => errors.push(error) });
	assert.equal(state.timers, 0);
	assert.deepEqual([...mounted.keys()], []);
	await session.prompt("/ccstyle status");
	assert.match(notices.at(-1).message, /mode=on/);
	assert.equal(state.providerCalls, 0, "status never requests a model");
	const events = [];
	const unsubscribe = session.subscribe((event) => events.push(event));
	await session.prompt("Show the synthetic fixture");
	unsubscribe();
	assert.equal(state.providerCalls, 2);
	assert.ok(events.some((event) => event.type === "agent_settled"));
	assert.equal(session.sessionFile, undefined);
	assert.equal(session.settingsManager, settingsManager);
	assert.equal(session.sessionManager, sessionManager);
	assert.deepEqual(await credentials.list(), [], "synthetic provider requires no saved auth");
	const baseline = state.toolMethods;
	for (let cycle = 0; cycle < 3; cycle++) {
		const offset = state.calls.length;
		await session.bindExtensions({ uiContext: ui, mode: "tui" });
		assert.deepEqual([...mounted.keys()].sort(), ["footer", "pi-ui-bridge"].sort());
		assert.deepEqual(state.calls.slice(offset).filter((call) => call.install).map((call) => call.method), ["setWidget", "setFooter"]);
		assert.ok(state.timers > 0, "guard observes the real UI scheduler");
		assert.equal(state.activeTimers.size, 1, "one scheduler timer serves all UI jobs");
		for (const component of mounted.values()) for (const width of [40, 80, 120]) for (const line of component.render(width))
			assert.ok(visibleWidth(line) <= width, "mounted shell fits " + width);
		await session.prompt("/ccstyle compact");
		await session.prompt("/ccstyle off");
		await session.prompt("/ccstyle on");
		await session.prompt("/ccstyle panel");
		assert.match(overlays.at(-1).render(80).join("\n"), /Original renderers/, "settings panel opens in each TUI cycle");
		assert.equal(state.providerCalls, 2, "style commands and panel never request a model");
		// A second routed start while active replaces, rather than stacks, owners.
		const restartOffset = state.calls.length;
		await session.extensionRunner.emit({ type: "session_start", reason: "reload" });
		assert.deepEqual(state.calls.slice(restartOffset).map((call) => [call.method, call.install]),
			[["setFooter", false], ["setWidget", false],
				["setWidget", true], ["setFooter", true]]);
		assert.equal(mounted.size, 2);
		await session.extensionRunner.emit({ type: "session_shutdown" });
		assert.equal(state.activeTimers.size, 0);
		assert.deepEqual([...mounted.keys()], []);
		for (const [name, original] of Object.entries(baseline)) assert.equal(SDK.ToolExecutionComponent.prototype[name], original);
	}
	// Even a context with mode=tui must not activate when the host has no UI.
	const noUI = Object.defineProperties(Object.create(session.extensionRunner.createContext()), { hasUI: { value: false } });
	const callsBefore = state.calls.length, timersBefore = state.timers;
	await uiExtension.handlers.get("session_start")[0]({ type: "session_start", reason: "new" }, noUI);
	assert.equal(state.calls.length, callsBefore);
	assert.equal(state.timers, timersBefore);
	await session.extensionRunner.emit({ type: "session_shutdown" });
	assert.deepEqual(errors, []);
	assert.ok(!notices.some((notice) => notice.type === "warning" || notice.type === "error"), JSON.stringify(notices));
	state.report("sdk-complete", { cycles: 3, overlays: overlays.length });
} finally { await session.extensionRunner.emit({ type: "session_shutdown" }); session.dispose(); }
`;

test("Pi SDK in-memory boundaries: sole ccstyle command, routed bridge/footer and cleanup", { timeout: 30000 }, async () => {
	const sandbox: Sandbox = await createSandbox();
	try {
		const worker = join(sandbox.base, "sdk-worker.mjs");
		await writeFile(worker, sdkWorker);
		const result = await runChild(sandbox, ["--import", join(sandbox.base, "safety.mjs"), worker, sandbox.host.directory]);
		assert.equal(result.code, 0, result.stderr);
		assert.equal(result.stderr, "");
		const entries: Diagnostic[] = await reports(sandbox);
		assert.ok(entries.some((entry) => entry.phase === "sdk-complete"));
		diagnosticChecks(entries);
		assert.equal(existsSync(join(sandbox.env.PI_CODING_AGENT_DIR!, "auth.json")), false, "SDK AuthStorage.inMemory creates no auth file");
		await noPersistentSession(sandbox);
	} finally { await sandbox.cleanup(); }
});

const ptySkip = ptyAvailability();
for (const mode of ["regular", "fullscreen"] as const) for (const width of [40, 80, 120]) {
	test(`actual bundled CLI ${mode} PTY ${width}x44: shared host ToolExecutionComponent/TUI identity and live patched row`,
		{ timeout: 35000, skip: ptySkip }, async () => {
			const sandbox: Sandbox = await createSandbox();
			try {
				const result = await capturePty(sandbox, mode, width);
				const final = diagnosticChecks(result.diagnostics, "tui");
				assert.equal(final.providerCalls, 2);
				assert.ok(final.timers > 0, "positive control: real TUI timer attribution works");
				assert.equal(result.diagnostics.find((entry: Diagnostic) => entry.phase === "session-start").activeTimers, 1);
				const identity = result.diagnostics.find((entry: Diagnostic) => entry.phase === "host-identity");
				assert.equal(identity.columns, width);
				assert.equal(identity.tuiMode, mode);
				assert.ok(identity.toolCount > 0);
				assert.match(result.ansi, /fixture/);
				assert.ok(final.notices.some((notice: { message: string }) => notice.message.includes("mode=on")));
				assert.ok(!final.notices.some((notice: { type: string }) => notice.type === "warning" || notice.type === "error"));
				assert.deepEqual(final.calls.filter((call) => call.install).map((call) => call.method), ["setWidget", "setFooter"]);
				assert.deepEqual(final.calls.filter((call) => !call.install).map((call) => call.method), ["setFooter", "setWidget"]);
				assert.equal(/\x1b\[\?1049h/.test(result.ansi), mode === "fullscreen", "actual alternate-screen terminal mode");
				await noPersistentSession(sandbox);
			} finally { await sandbox.cleanup(); }
		});
}

for (const mode of ["regular", "fullscreen"] as const) {
	test(`actual bundled CLI ${mode} rich PTY 80x44: native temporary file/diff rows and Markdown fixtures`,
		{ timeout: 35000, skip: ptySkip }, async () => {
			const sandbox: Sandbox = await createSandbox({ scenario: "rich" });
			try {
				const result = await capturePty(sandbox, mode, 80);
				const final = diagnosticChecks(result.diagnostics, "tui");
				assert.equal(final.providerCalls, 4, "read, write, edit, final response use the real local agent loop");
				const identity = result.diagnostics.find((entry: Diagnostic) => entry.phase === "host-identity");
				assert.equal(identity.toolCount, 3);
				assert.equal(identity.tuiMode, mode);
				const executed = result.diagnostics.find((entry: Diagnostic) => entry.phase === "rich-tools");
				assert.deepEqual(executed.tools, ["read", "write", "edit"]);
				assert.match(result.ansi, /Stage-one rich fixture complete/);
				assert.ok(result.ansi.includes("\x1b]8;"), "native OSC8 is enabled only in this reserved-domain profile");
				assert.ok(!final.notices.some((notice: { type: string }) => ["warning", "error"].includes(notice.type)));
				assert.deepEqual(final.calls.filter((call) => call.install).map((call) => call.method), ["setWidget", "setFooter"]);
				assert.deepEqual(final.calls.filter((call) => !call.install).map((call) => call.method), ["setFooter", "setWidget"]);
				await noPersistentSession(sandbox, ["rich-seed.txt", "rich-preview.ts"]);
			} finally { await sandbox.cleanup(); }
		});
}
