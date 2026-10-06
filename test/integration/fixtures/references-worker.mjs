import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { appendFileSync } from "node:fs";

const host = process.argv[2], scenario = process.argv[3];
const SDK = await import(pathToFileURL(join(host, "dist/index.js")).href);
const require = createRequire(join(host, "package.json"));
const TUI = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href);
const config = JSON.parse(await readFile(process.env.SERRALY_CONFIG, "utf8"));
const cwd = process.cwd(), agentDir = process.env.PI_CODING_AGENT_DIR;
const release = process.env.SERRALY_RELEASE;
const manifest = JSON.parse(await readFile(join(release, "package.json"), "utf8"));
const entries = Object.fromEntries(manifest.pi.extensions.map((entry) => [entry.split("/")[2], join(release, entry.slice(2))]));
const names = config.names ?? Object.keys(entries);
const report = (phase, extra = {}) => appendFileSync(process.env.SERRALY_REPORT, JSON.stringify({ phase, ...extra }) + "\n");
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const workspace = join(dirname(cwd), "historical-workspace");
const source = SDK.SessionManager.create(workspace, join(agentDir, "sessions", "--historical-workspace--"));
source.appendMessage({ role: "user", content: "AUTHORIZED HISTORY", timestamp: Date.now() });
source.appendMessage({ role: "assistant", api: "reference-scripted", provider: "fixture", model: "fixture",
	content: [{ type: "text", text: "VISIBLE ANSWER" }], stopReason: "stop", timestamp: Date.now(), usage });
source.appendSessionInfo("Shared reference title");
const root = source.getLeafId();
source.appendMessage({ role: "user", content: "ABANDONED BRANCH", timestamp: Date.now() });
source.branch(root);
const kept = source.appendMessage({ role: "user", content: "REPLACED TEXT", timestamp: Date.now() });
source.appendContextEdit(kept, { content: "EFFECTIVE EDITED HISTORY" });
source.appendCustomMessageEntry("session-reference", "NESTED REFERENCE GUIDANCE", true);
source.appendCustomMessageEntry("subagent-mention", "NESTED DELEGATION GUIDANCE", true);
source.appendCompaction("RETAINED COMPACTION SUMMARY", kept, 1000);
const sourceBytes = await readFile(source.getSessionFile());
const sourceStat = await stat(source.getSessionFile());
const other = SDK.SessionManager.create(workspace, join(agentDir, "sessions", "--historical-workspace--"));
other.appendMessage({ role: "user", content: "UNSELECTED HISTORY", timestamp: Date.now() });
other.appendMessage({ role: "assistant", api: "reference-scripted", provider: "fixture", model: "fixture",
	content: [{ type: "text", text: "UNSELECTED ANSWER" }], stopReason: "stop", timestamp: Date.now(), usage });
other.appendSessionInfo("Shared reference title");
const external = join(dirname(cwd), "external");
await mkdir(external);
for (const [directory, file, body] of [
	[cwd, "note.md", "NATIVE FILE"], [external, "note.md", "EXTERNAL FILE"],
	[external, "session:decoy", "NOT SESSION BACKGROUND"],
	[external, "subagent:[Example]", "NOT DELEGATION GUIDANCE"],
	[external, "subagent:[missing]", "NOT A VALID AGENT"],
	[join(agentDir, "agents"), "example.md", "---\nname: Example\ndescription: User example agent\n---\n\nFixture instructions.\n"],
	[join(agentDir, "agents"), "hidden.md", "---\nname: Hidden\nhidden: true\n---\n\nFixture instructions.\n"],
	[join(cwd, ".pi/agents"), "untrusted.md", "---\nname: ProjectOnly\n---\n\nUntrusted project instructions.\n"],
	[workspace, "AGENTS.md", "SOURCE WORKSPACE INSTRUCTIONS MUST STAY OUT"],
	[join(workspace, ".pi"), "settings.json", '{"defaultTools":[],"defaultProvider":"source-only-provider"}'],
	[join(workspace, ".pi/agents"), "source-only.md", "---\nname: SourceOnly\n---\n\nSource agent must stay out.\n"],
	[join(workspace, ".pi/extensions"), "source-only.js", 'export default function () { throw new Error("SOURCE FACTORY MUST NOT LOAD"); }'],
]) {
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, file), body);
}
if (scenario === "seed") {
	report("reference-seed", { id: source.getSessionId(), file: source.getSessionFile() });
	report("complete", { scenario });
	process.exit(0);
}
// No credentials path and no model network are needed at this seam.
const credentials = { read: async () => undefined, list: async () => [],
	modify: async (_id, fn) => fn(undefined), delete: async () => {} };
const modelRuntime = await SDK.ModelRuntime.create({ credentials, modelsPath: null,
	modelsStorePath: join(process.env.TMPDIR, "reference-model-cache.json"), allowModelNetwork: false, refreshOnCreate: false });
if (config.retryRequests) {
	const settingsFile = join(agentDir, "settings.json");
	const settings = JSON.parse(await readFile(settingsFile, "utf8"));
	settings.retry = { enabled: true, maxRetries: 2, baseDelayMs: 1 };
	await writeFile(settingsFile, JSON.stringify(settings));
}
if (config.packageFilter) {
	const settingsFile = join(agentDir, "settings.json");
	const settings = JSON.parse(await readFile(settingsFile, "utf8"));
	settings.packages = [{ source: release, extensions: config.packageFilter }];
	await writeFile(settingsFile, JSON.stringify(settings));
}
const settingsManager = SDK.SettingsManager.create(cwd, agentDir, { projectTrusted: false });
const loader = new SDK.DefaultResourceLoader({ cwd, agentDir, settingsManager,
	noExtensions: !config.packageFilter, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	additionalExtensionPaths: [join(import.meta.dirname, "references-provider.js"),
		...(!config.packageFilter ? names.map((name) => entries[name]) : [])] });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, [], "real host loader loads selected compiled factories");
for (const { name, config } of loader.getExtensions().runtime.pendingProviderRegistrations) modelRuntime.registerProvider(name, config);
const model = modelRuntime.getModel("serraly-fixture", "fixture");
assert.ok(model);
const { session } = await SDK.createAgentSession({ cwd, agentDir, modelRuntime, settingsManager, model,
	resourceLoader: loader, sessionManager: SDK.SessionManager.inMemory(cwd), thinkingLevel: "off" });
const errors = [];
SDK.initTheme("dark", false);
const { theme } = await import(pathToFileURL(join(host, "dist/modes/interactive/theme/theme.js")).href);
const native = new TUI.CombinedAutocompleteProvider([], cwd, join(import.meta.dirname, "reference-fd.mjs"));
let provider = native;
const ui = { ...session.extensionRunner.getUIContext(), theme, notify() {}, setWidget() {},
	setStatus() {}, onTerminalInput: () => () => {}, getEditorText: () => "",
	addAutocompleteProvider(factory) { provider = factory(provider); } };
try {
	const mode = scenario === "completion" ? "tui" : config.mode ?? "print";
	await session.bindExtensions({ mode, ...(mode === "tui" ? { uiContext: ui } : {}), onError: (error) => errors.push(error) });
	const command = session.extensionRunner.getRegisteredCommands().find((item) => item.invocationName === "dir-add");
	await command.handler(external, session.extensionRunner.createCommandContext());
	if (scenario === "completion") {
		const options = () => ({ signal: new AbortController().signal });
		const suggest = (text) => provider.getSuggestions([text], 0, text.length, options());
		const files = await suggest("open @no");
		assert.equal(files.prefix, "@no");
		assert.deepEqual(files.items.map((item) => item.value), ["@note.md", `@${external}/note.md`]);
		for (const item of files.items) {
			assert.deepEqual(provider.applyCompletion(["open @no"], 0, 8, item, files.prefix),
				native.applyCompletion(["open @no"], 0, 8, item, files.prefix), "native/external attachment replacement stays delegated");
		}
		const plain = ["open ./no"];
		const ordinary = await provider.getSuggestions(plain, 0, plain[0].length, options());
		assert.ok(ordinary.items.some((item) => item.value === "./note.md"));
		assert.deepEqual(ordinary, await native.getSuggestions(plain, 0, plain[0].length, options()), "ordinary native path completion is unchanged");
		for (const [text, expected] of [
			["Use @session:", [`@session:[${source.getSessionId()}]`, `@session:[${other.getSessionId()}]`]],
			["Use @subagent:[exam", ["@subagent:[Example]"]],
		]) {
			const result = await suggest(text);
			assert.deepEqual(result.items.map((item) => item.value).sort(), expected.sort(), "explicit namespace must not be contaminated by external filenames");
			assert.equal(provider.shouldTriggerFileCompletion([text], 0, text.length), false);
			const selected = result.items.find((item) => item.value === expected[0]);
			const completion = provider.applyCompletion(["Keep this line", text + " then continue"], 1, text.length, selected, result.prefix);
			assert.equal(completion.lines[0], "Keep this line");
			assert.equal(completion.lines[1], "Use " + selected.value + " then continue", "stable ID/canonical agent insertion preserves user text, not a file attachment");
		}
		const agents = await suggest("@subagent:");
		assert.ok(!agents.items.some((item) => /Hidden|ProjectOnly|SourceOnly/.test(item.value)), "hidden, untrusted project and source-workspace agents are not selectable");
		assert.equal(await suggest("@subagent:[missing"), null, "unavailable explicit namespace is not an external file search");
		assert.equal(await suggest("@subagent:[Example]"), null, "a completed mention is not reinterpreted as an external attachment");
		assert.deepEqual((await suggest("@session:decoy")).items, [], "no matching session does not expose an external file with that namespace");
		assert.ok(!JSON.stringify(session.messages).includes("AUTHORIZED HISTORY"), "catalogue browsing does not inject transcript bodies");
	} else if (scenario === "requests") {
		const references = () => session.messages.filter((message) => message.role === "custom" && message.customType === "session-reference");
		const mentions = () => session.messages.filter((message) => message.role === "custom" && message.customType === "subagent-mention");
		const state = globalThis[Symbol.for("serraly.reference-fixture")];
		const active = session.getActiveToolNames();
		await session.prompt("Baseline without references");
		const system = session.systemPrompt;
		const prompt = `Use @session:[${source.getSessionId()}] @session:[${source.getSessionId()}] with @subagent:[example] @subagent:[Example].`;
		await session.prompt(prompt);
		const selectedSession = !config.disabled || config.disabled !== "pi-session-reference";
		const selectedAgent = !config.disabled || config.disabled !== "pi-subagents";
		assert.equal(references().length, selectedSession ? 1 : 0);
		assert.equal(mentions().length, selectedAgent ? 1 : 0);
		if (selectedSession) {
			const background = references()[0];
			assert.equal(background.details.requestBackground, true);
			assert.deepEqual(background.details.sources.map(({ id, workspace: selectedWorkspace }) => ({ id, workspace: selectedWorkspace })),
				[{ id: source.getSessionId(), workspace }]);
		}
		for (const request of state.requests.slice(1)) {
			const actual = JSON.stringify(request.messages);
			assert.ok(actual.includes(prompt), "the actual provider receives unchanged user text");
			if (selectedSession) {
				assert.match(actual, /untrusted background/i);
				assert.match(actual, /EFFECTIVE EDITED HISTORY/);
				assert.match(actual, /RETAINED COMPACTION SUMMARY/);
				assert.equal(actual.split("Referenced Pi sessions").length - 1, 1, "retries reuse one supplemental reference");
				for (const forbidden of ["AUTHORIZED HISTORY", "VISIBLE ANSWER", "ABANDONED BRANCH", "REPLACED TEXT", "UNSELECTED HISTORY",
					"NESTED REFERENCE GUIDANCE", "NESTED DELEGATION GUIDANCE", "NOT SESSION BACKGROUND", "NOT DELEGATION GUIDANCE",
					"SOURCE WORKSPACE INSTRUCTIONS MUST STAY OUT"])
					assert.ok(!actual.includes(forbidden), forbidden);
			} else assert.doesNotMatch(actual, /EFFECTIVE EDITED HISTORY|Referenced Pi sessions/);
			if (selectedAgent) {
				assert.ok(actual.includes('Agent {\\"agent\\":\\"Example\\"}'), "canonical Agent parameter guidance reaches actual provider");
				assert.equal(actual.split("Explicit subagent mentions").length - 1, 1, "retries reuse one supplemental mention");
				assert.doesNotMatch(actual, /subagent_type/);
			} else assert.doesNotMatch(actual, /Explicit subagent mentions|Delegation intent/);
			assert.deepEqual(request.tools, state.requests[0].tools, "reference guidance leaves the actual model tool declarations unchanged");
			assert.equal(request.systemPrompt, state.requests[0].systemPrompt);
			const originalSystem = state.requests[0].messages.filter((message) => message.role === "system");
			assert.deepEqual(request.messages.filter((message) => message.role === "system"), originalSystem,
				"references do not replace or promote history into the real system prompt");
		}
		assert.equal(state.requests.length, config.retryRequests ? 4 : 2, "baseline plus actual turn and sequential automatic retries");
		await session.prompt("Following prompt without new references");
		assert.equal(references().length, selectedSession ? 1 : 0, "no new reference background on the following prompt");
		assert.equal(mentions().length, selectedAgent ? 1 : 0, "no new delegation guidance on the following prompt");
		assert.deepEqual(session.getActiveToolNames(), active, "neither reference activates tools");
		assert.equal(session.systemPrompt, system);
		const status = session.getToolDefinition("AgentStatus");
		if (selectedAgent) {
			const result = await status.execute("reference-status", {}, undefined, undefined,
				session.extensionRunner.createToolContext("reference-status", undefined));
			assert.match(result.content[0].text, /No agents running or completed/);
		} else assert.equal(status, undefined);
		assert.deepEqual(await readFile(source.getSessionFile()), sourceBytes, "reference export does not rewrite or migrate source");
		const afterStat = await stat(source.getSessionFile());
		assert.equal(afterStat.mtimeMs, sourceStat.mtimeMs, "the source file was not written, even with identical content");
		assert.equal(afterStat.ctimeMs, sourceStat.ctimeMs);
		if (mode !== "tui") assert.equal(provider, native, "headless modes do not register autocomplete");
		report("reference-request-checked", { mode, references: references().length, mentions: mentions().length });
	} else assert.fail("Unknown reference worker scenario " + scenario);
} finally {
	await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	session.dispose();
}
assert.deepEqual(errors, []);
assert.deepEqual(await credentials.list(), []);
report("complete", { scenario });
