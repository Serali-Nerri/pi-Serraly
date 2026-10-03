#!/usr/bin/env node
/** Stage-one acceptance sandbox. Nothing here installs or changes the user's Pi. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedEnvironment } from "./lib/environment.mjs";
import { expectedVersion, hostPackage } from "./lib/host.mjs";
import { runChild } from "./lib/process.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");


// A preload before the bundled CLI rejects accidental networking. Offline mode
// alone disables automatic activity, not model requests. Diagnostics stay off stdout.
const safetySource = String.raw`
import { appendFileSync } from "node:fs";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
const reject = (...args) => {
	appendFileSync(process.env.PI_UI_REPORT, JSON.stringify({ phase: "network-denied" }) + "\n");
	throw new Error("Stage-one fixture forbids network requests");
};
globalThis.fetch = reject;
net.Socket.prototype.connect = reject;
net.connect = net.createConnection = tls.connect = reject;
http.request = http.get = https.request = https.get = reject;
dns.lookup = dns.resolve = dns.promises.lookup = dns.promises.resolve = reject;
syncBuiltinESMExports();
`;

// Loaded BEFORE UI through Pi's own loader, so these references are the same
// embedded classes the bundled CLI uses. Capture factory/session side effects.
const guardSource = String.raw`
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { ToolExecutionComponent, AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
const key = Symbol.for("pi-ui.integration-state");
export default function (pi) {
	const state = globalThis[key] = {
		tool: ToolExecutionComponent.prototype,
		assistant: AssistantMessageComponent.prototype,
		toolMethods: {}, container: Container.prototype, containerMethods: {},
		assistantMethod: AssistantMessageComponent.prototype.updateContent,
		timers: 0, activeTimers: new Set(), starts: 0, calls: [], notices: [], providerCalls: 0,
	};
	for (const name of ["hasRendererDefinition", "getRenderShell", "getCallRenderer", "getResultRenderer", "updateDisplay"])
		state.toolMethods[name] = state.tool[name];
	for (const name of ["addChild", "removeChild", "clear"]) state.containerMethods[name] = state.container[name];
	state.report = (phase, extra = {}) => appendFileSync(process.env.PI_UI_REPORT,
		JSON.stringify({ phase, starts: state.starts, timers: state.timers, activeTimers: state.activeTimers.size,
			calls: state.calls, notices: state.notices, providerCalls: state.providerCalls, ...extra }) + "\n");
	for (const name of ["setTimeout", "setInterval"]) {
		const original = globalThis[name];
		globalThis[name] = function (callback, delay, ...args) {
			const own = new Error().stack.includes(process.env.PI_UI_STAGE);
			let timer;
			const wrapped = typeof callback === "function" ? (...values) => {
				if (name === "setTimeout") state.activeTimers.delete(timer);
				return callback(...values);
			} : callback;
			timer = original(wrapped, delay, ...args);
			if (own) { state.timers++; state.activeTimers.add(timer); }
			return timer;
		};
	}
	for (const name of ["clearTimeout", "clearInterval"]) {
		const original = globalThis[name];
		globalThis[name] = (timer) => { state.activeTimers.delete(timer); return original(timer); };
	}
	pi.on("session_start", (_event, ctx) => {
		state.starts++;
		state.startCallOffset = state.calls.length;
		state.mode = ctx.mode;
		state.hasUI = ctx.hasUI;
		if (state.ui !== ctx.ui) {
			state.ui = ctx.ui;
			for (const name of ["setWidget", "setHeader", "setFooter"]) {
				const original = ctx.ui[name];
				ctx.ui[name] = function (...args) {
					state.calls.push({ method: name, key: name === "setWidget" ? args[0] : undefined,
						install: (name === "setWidget" ? args[1] : args[0]) !== undefined });
					return original.apply(this, args);
				};
			}
			const notify = ctx.ui.notify;
			ctx.ui.notify = function (message, type) {
				state.notices.push({ message, type });
				state.report("notify");
				return notify.call(this, message, type);
			};
		}
	});
	state.report("guard-factory");
}
`;

const richOldText = [
	"export const preview = {",
	"\ttitle: \"Before edit\",",
	"\tstatus: \"draft\",",
	"\tlocale: \"en\",",
	"\ttools: [\"read\"],",
	"\twrap: false,",
	"\texpand: false,",
	"\tdescription: \"" + "Before: 界 café 🙂 — long diff line. ".repeat(8) + "\",",
	"};",
].join("\n");
const richNewText = [
	"export const preview = {",
	"\ttitle: \"After edit — 临时预览\",",
	"\tstatus: \"ready\",",
	"\tlocale: \"zh-CN\",",
	"\ttools: [\"read\", \"write\", \"edit\"],",
	"\twrap: true,",
	"\texpand: true,",
	"\tdescription: \"" + "After: 界 café 🙂 — wrapped diff line. ".repeat(8) + "\",",
	"};",
].join("\n");
const richFixture = {
	seedName: "rich-seed.txt", outputName: "rich-preview.ts",
	seed: "Rich preview seed: local temporary data only.\n" +
		"Wide text: 界 café 🙂 — deterministic rendering.\n".repeat(18) +
		"Long read line: " + "临时文件 / fullwidth ＡＢＣ / café 🙂 / ".repeat(12) + "\n",
	content: [
		"// Local temporary preview; the built-in write tool creates this file.",
		"export const wide = \"" + "界 café 🙂 — retained long-line content. ".repeat(12) + "\";",
		"", richOldText, "",
		...Array.from({ length: 24 }, (_, index) => `// Retained fixture line ${index + 1}: expand the native tool row to inspect all data.`),
		"",
	].join("\n"),
	edits: [{ oldText: richOldText, newText: richNewText }],
	markdown: [
		"Stage-one rich fixture complete.", "", "## Local file and diff previews", "",
		"The built-in tools read `rich-seed.txt`, created `rich-preview.ts`, and edited its known preview block.",
		"Expand the tool rows to inspect retained lines, Unicode wrapping, and the actual edit diff.", "",
		"| Tool | Temporary fixture | View |", "| --- | --- | --- |",
		"| read | rich-seed.txt | long-line text |",
		"| write | rich-preview.ts | new file card |",
		"| edit | rich-preview.ts | before/after diff |", "",
		"> [!NOTE]", "> This scripted conversation runs locally with temporary fixtures.", "",
		"> [!TIP]", "> Use Ctrl+O to expand or collapse tool output; compare on, compact, and off styles.", "",
		"> [!IMPORTANT]", "> File and diff rows come from Pi's real built-in read, write, and edit tools.", "",
		"> [!WARNING]", "> The sandbox and its preview files are removed on exit.", "",
		"> [!CAUTION]", "> Link targets use the reserved example.invalid domain; inspect destinations without opening them.", "",
		"## Chinese and fullwidth URL boundaries", "",
		"中文：https://example.invalid/路径?q=1，后文。",
		"全角（https://example.invalid/fullwidth）以及：https://example.invalid/next！结束。",
		"字面路径：www.example.invalid/a_b_c，后文；公式字符：www.example.invalid/$x$，后文。", "",
		"## Native reference destinations", "",
		"> [quoted]:", "> https://example.invalid/quoted/②，path", "> \"Quoted authoritative title\"", ">",
		"> Quoted reference: [quoted destination][quoted].", "",
		"- [listed]: https://example.invalid/listed/④，path", "",
		"  List reference: [listed destination][listed].", "",
		"Outside the containers: [quoted destination][quoted] and [listed destination][listed].", "",
		"## Native Mermaid and unknown-language fallback", "",
		"Compare Pi's native Mermaid off/final/streaming settings with this standard fence.", "",
		"```mermaid", "flowchart TD", "    A[Read seed] --> B[Write new file]", "    B --> C[Edit preview]", "```", "",
		"```stage-one-unknown", "Unknown-language fallback: 界 café 🙂", "Literal code: www.example.invalid/a_b_c and www.example.invalid/$x$", "```", "",
	].join("\n"),
};

// Loaded AFTER UI. It registers no tools or commands. A local provider drives
// genuine host-created built-in rows, followed by a deterministic Markdown reply.
const fixtureSource = String.raw`
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ToolExecutionComponent, AssistantMessageComponent, VERSION } from "@earendil-works/pi-coding-agent";
import { TuiMainScreen, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
const key = Symbol.for("pi-ui.integration-state");
const slots = ["pi-ui.lifecycle-owner", "claude-style-tools.global-tool-render-patch",
	"claude-style-tools.compact-thinking-owner", "claude-style-tools.compact-mode-patch",
	"claude-style-tools.message-display-patch", "claude-style-tools.tool-expanded-background-patch",
	"claude-style-tools.rendering-owner"];
function unpatched(state) {
	for (const [name, original] of Object.entries(state.toolMethods)) assert.equal(state.tool[name], original, name);
	for (const [name, original] of Object.entries(state.containerMethods)) assert.equal(state.container[name], original, name);
	assert.equal(AssistantMessageComponent.prototype.updateContent, state.assistantMethod);
	for (const name of slots) assert.equal(globalThis[Symbol.for(name)], undefined, name);
	// Grouping keeps an inactive reload tombstone. Validate restored methods and
	// released resources instead of incorrectly demanding deletion of that slot.
	const grouping = globalThis[Symbol.for("claude-style-tools.tool-grouping-patch")];
	if (grouping) {
		assert.equal(grouping.active, false);
		assert.equal(grouping.groups.size, 0);
		assert.equal(grouping.animationTimer, null);
	}
}
function walk(root) {
	const result = [], seen = new Set(), queue = [root];
	while (queue.length) {
		const value = queue.shift();
		if (!value || typeof value !== "object" || seen.has(value)) continue;
		seen.add(value); result.push(value);
		for (const child of value.children || []) queue.push(child);
		for (const name of ["child", "content", "contentContainer", "scrollView", "root"]) queue.push(value[name]);
	}
	return result;
}
export default function (pi) {
	const state = globalThis[key];
	assert.ok(state, "guard extension must precede UI");
	assert.equal(VERSION, "1.0.0");
	assert.equal(state.timers, 0, "UI factory starts no timers");
	unpatched(state);
	state.report("factory", { version: VERSION });
	pi.registerProvider("stage-one-fixture", {
		api: "stage-one-scripted", baseUrl: "https://invalid.invalid", apiKey: "synthetic-not-a-secret",
		models: [{ id: "fixture", name: "Stage-one synthetic fixture", reasoning: true, input: ["text"],
			contextWindow: 32768, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model, context, options) {
			state.providerCalls++;
			const stream = createAssistantMessageEventStream();
			const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
				timestamp: 1700000000000 + state.providerCalls, content: [], stopReason: "pending",
				usage: { input: 120, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 150,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			queueMicrotask(async () => {
				try {
					await options?.onPayload?.({ fixture: true }, model);
					await options?.onResponse?.({ status: 200, headers: new Headers() }, model);
					await options?.onProviderStreamEvent?.({ type: "synthetic-fixture" }, model);
					let nextTool;
					if (richFixture) {
						const results = context.messages.filter((message) => message.role === "toolResult");
						const plan = [
							{ name: "read", arguments: { path: join(process.cwd(), richFixture.seedName) } },
							{ name: "write", arguments: { path: join(process.cwd(), richFixture.outputName), content: richFixture.content } },
							{ name: "edit", arguments: { path: join(process.cwd(), richFixture.outputName), edits: richFixture.edits } },
						];
						assert.ok(results.length <= plan.length, "only the three scripted built-in calls are expected");
						for (const [index, result] of results.entries()) {
							assert.equal(result.toolName, plan[index].name);
							assert.equal(result.toolCallId, "fixture-" + plan[index].name);
							assert.equal(result.isError, false, "rich built-in " + result.toolName + " succeeded");
						}
						nextTool = plan[results.length];
						if (nextTool?.name === "write")
							assert.equal(existsSync(nextTool.arguments.path), false, "built-in write creates a NEW sandbox file");
						state.richResults = results.map((result) => result.toolName);
					} else if (!context.messages.some((message) => message.role === "toolResult")) {
						nextTool = { name: "read", arguments: { path: process.env.TMPDIR + "/fixture.txt" } };
					}
					const tool = !!nextTool;
					stream.push({ type: "start", partial: message });
					const thinking = richFixture
						? "Read the local seed, write a new temporary file, then edit its known content.\n**Fixture reasoning**\nAll three tools are Pi built-ins; no external services are used."
						: "Inspect the synthetic fixture only.\n**Fixture reasoning**\nNo external services are used.";
					message.content.push({ type: "thinking", thinking: "" });
					stream.push({ type: "thinking_start", contentIndex: 0, partial: message });
					message.content[0].thinking = thinking;
					stream.push({ type: "thinking_delta", contentIndex: 0, delta: thinking, partial: message });
					stream.push({ type: "thinking_end", contentIndex: 0, content: thinking, partial: message });
					if (tool) {
						const call = { type: "toolCall", id: "fixture-" + nextTool.name, name: nextTool.name, arguments: {} };
						message.content.push(call);
						stream.push({ type: "toolcall_start", contentIndex: 1, partial: message });
						call.arguments = nextTool.arguments;
						stream.push({ type: "toolcall_delta", contentIndex: 1, delta: JSON.stringify(call.arguments), partial: message });
						stream.push({ type: "toolcall_end", contentIndex: 1, toolCall: call, partial: message });
					} else {
						const text = richFixture?.markdown || "Stage-one fixture complete.\n\n## Synthetic report\n\n| Width | Result |\n| --- | --- |\n| narrow | wrapped |\n| wide | readable |\n\n- Unicode: 界 café 🙂\n- No real credentials, sessions, or provider requests.\n\n~~~ts\nconst stage = 1;\nconsole.log(stage);\n~~~";
						message.content.push({ type: "text", text: "" });
						stream.push({ type: "text_start", contentIndex: 1, partial: message });
						for (const delta of [text.slice(0, 45), text.slice(45)]) {
							message.content[1].text += delta;
							stream.push({ type: "text_delta", contentIndex: 1, delta, partial: message });
						}
						stream.push({ type: "text_end", contentIndex: 1, content: text, partial: message });
					}
					message.stopReason = options?.signal?.aborted ? "aborted" : tool ? "toolUse" : "stop";
					if (message.stopReason === "aborted") {
						message.errorMessage = "Fixture aborted";
						stream.push({ type: "error", reason: "aborted", error: message });
					} else stream.push({ type: "done", reason: message.stopReason, message });
					stream.end();
				} catch (error) {
					message.stopReason = "error";
					message.errorMessage = String(error);
					stream.push({ type: "error", reason: "error", error: message });
					stream.end();
					state.report("fixture-error", { error: String(error) });
				}
			});
			return stream;
		},
	});
	pi.on("session_start", async (_event, ctx) => {
		assert.deepEqual(pi.getCommands().map((command) => command.name).sort(), ["ccstyle", "context"]);
		if (richFixture) assert.deepEqual(pi.getActiveTools().slice().sort(), ["edit", "read", "write"]);
		else assert.deepEqual(pi.getActiveTools(), ["read"]);
		assert.ok(pi.getAllTools().every((tool) => tool.sourceInfo?.source === "builtin"), "UI does not re-register tools");
		if (ctx.mode !== "tui") {
			unpatched(state);
			assert.equal(state.timers, 0);
			assert.deepEqual(state.calls, []);
		} else {
			const patch = globalThis[Symbol.for("claude-style-tools.global-tool-render-patch")];
			assert.ok(globalThis[Symbol.for("pi-ui.lifecycle-owner")]);
			assert.equal(patch.prototype, ToolExecutionComponent.prototype, "UI patches the host-imported tool prototype");
			assert.equal(patch.active, true);
			assert.equal(patch.installed.getCallRenderer, ToolExecutionComponent.prototype.getCallRenderer);
			assert.notEqual(AssistantMessageComponent.prototype.updateContent, state.assistantMethod);
			const installed = state.calls.slice(state.startCallOffset).filter((call) => call.install);
			assert.deepEqual(installed.map((call) => call.method), ["setWidget", "setHeader", "setFooter"]);
			assert.equal(installed[0].key, "pi-ui-bridge");
			// Obtain the actual interactive-mode TUI without adding a persistent widget.
			await ctx.ui.custom((tui, _theme, _keys, done) => {
				state.tui = tui;
				assert.ok(tui instanceof TuiMainScreen || tui instanceof TuiAltScreen, "shared embedded TUI class identity");
				queueMicrotask(() => done(undefined));
				return { render: () => [], invalidate() {} };
			});
		}
		state.report("session-start", { mode: ctx.mode, hasUI: ctx.hasUI });
	});
	pi.on("agent_end", (_event, ctx) => {
		if (richFixture) {
			assert.deepEqual(state.richResults, ["read", "write", "edit"], "all three built-ins completed");
			assert.equal(readFileSync(join(process.cwd(), richFixture.outputName), "utf8"),
				richFixture.content.replace(richFixture.edits[0].oldText, richFixture.edits[0].newText), "actual sandbox edit content");
			state.report("rich-tools", { tools: state.richResults });
		}
		if (ctx.mode !== "tui") { unpatched(state); assert.equal(state.timers, 0); }
		else {
			const components = walk(state.tui);
			const tools = components.filter((component) => component instanceof ToolExecutionComponent);
			assert.ok(tools.length > 0, "host-created tool instance shares the patched class, not a physical duplicate");
			if (richFixture) assert.equal(tools.length, 3, "rich preview has three host-created built-in tool rows");
			const patch = globalThis[Symbol.for("claude-style-tools.global-tool-render-patch")];
			for (const tool of tools) {
				assert.equal(Object.getPrototypeOf(tool), patch.prototype);
				assert.equal(tool.getCallRenderer, patch.installed.getCallRenderer);
				assert.equal(tool.hasRendererDefinition(), true);
				const renderer = tool.getCallRenderer();
				assert.equal(typeof renderer, "function", "live row uses the UI renderer");
				// Positive control for the initial default-on fixture. Later manual
				// prompts may follow off/exclusion changes and must remain native.
				if (!state.fixtureValidated) assert.equal(tool[Symbol.for("claude-style-tools.component-tool-render-mode")], true);
				for (const width of [40, 80, 120]) for (const line of tool.render(width))
					assert.ok(visibleWidth(line) <= width, "live tool row fits " + width + " columns");
			}
			state.report("host-identity", { tuiClass: state.tui.constructor.name, toolCount: tools.length,
				columns: state.tui.terminal.columns, tuiMode: state.tui.mode });
		}
		state.fixtureValidated = true;
		state.report("agent-end", { mode: ctx.mode });
	});
	pi.on("session_shutdown", (_event, ctx) => {
		unpatched(state);
		assert.equal(state.activeTimers.size, 0, "UI timer cleanup is complete");
		state.report("shutdown", { mode: ctx.mode });
	});
}
`;

export async function createSandbox({ scenario = "default" } = {}) {
	assert.ok(["default", "rich"].includes(scenario), "Unknown preview scenario: " + scenario);
	const host = hostPackage();
	const base = await mkdtemp(join(tmpdir(), "pi-ui-acceptance-"));
	const env = isolatedEnvironment(base);
	// The preview owns its external stage and diagnostics paths; the generic
	// environment must stay free of preview-specific redirection.
	env.PI_UI_STAGE = join(base, "pi-ui/index.js");
	env.PI_UI_REPORT = join(base, "report.jsonl");
	if (scenario === "rich") env.PI_HYPERLINKS = "1"; // Native OSC8 inspection; targets use reserved example.invalid.
	const cwd = join(base, "cwd");
	try {
		assert.ok(!realpathSync(base).startsWith(root + sep), "stage must be outside the source dependency tree");
		await Promise.all([cwd, env.HOME, env.PI_CODING_AGENT_DIR, join(base, "pi-ui")].map((path) => mkdir(path, { recursive: true })));
		// Compile current stage-one source locally to avoid races with other agents'
		// build output. Runtime loads only this external ESM stage, never source.
		// Even esbuild's compiler service inherits only the isolated allowlist.
		await writeFile(join(base, "safety.mjs"), safetySource);
		const options = { entryPoints: [join(root, "extensions/pi-ui/src/index.ts")], outfile: env.PI_UI_STAGE,
			bundle: true, platform: "node", format: "esm", target: "node22", legalComments: "eof", metafile: true,
			external: ["@earendil-works/*", "typebox", "typebox/*"] };
		const compiler = join(base, "compile.mjs");
		await writeFile(compiler, `import { build } from ${JSON.stringify(import.meta.resolve("esbuild"))};\n` +
			`const result = await build(${JSON.stringify(options)});\nprocess.stdout.write(JSON.stringify(Object.keys(result.metafile.inputs)));\n`);
		const compiled = await runChild({ cwd, env }, ["--import", join(base, "safety.mjs"), compiler]);
		assert.equal(compiled.code, 0, compiled.stderr);
		assert.ok(!JSON.parse(compiled.stdout).some((path) => /node_modules\/(?:@earendil-works|typebox|grok-mermaid)\//.test(path)), "stage contains no physical host dependencies");
		assert.ok(!existsSync(join(base, "node_modules")));
		await writeFile(join(base, "package.json"), '{"type":"module"}\n');
		await writeFile(join(base, "pi-ui/package.json"), '{"type":"module"}\n');
		await cp(join(root, "extensions/pi-ui/licenses"), join(base, "pi-ui/licenses"), { recursive: true });
		await writeFile(join(base, "guard.js"), guardSource);
		await writeFile(join(base, "fixture.js"), `const richFixture = ${JSON.stringify(scenario === "rich" ? richFixture : null)};\n` + fixtureSource);
		if (scenario === "rich") await writeFile(join(cwd, richFixture.seedName), richFixture.seed);
		else await writeFile(join(base, "fixture.txt"), "Synthetic fixture only.\n" + "Wide text: 界 café 🙂 — deterministic rendering.\n".repeat(18));
		await writeFile(join(env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({
			theme: "dark", hideThinkingBlock: true, compaction: { enabled: false }, retry: { enabled: false },
			cacheWarming: "off", enableInstallTelemetry: false, enableAnalytics: false,
		}));
		return { base, cwd, env, host, scenario,
			async cleanup() { await rm(base, { recursive: true, force: true }); },
		};
	} catch (error) { await rm(base, { recursive: true, force: true }); throw error; }
}

export function cliArguments(sandbox, extra = []) {
	return ["--import", join(sandbox.base, "safety.mjs"), sandbox.host.cli,
		"--offline", "--no-extensions", "--no-session", "--no-skills", "--no-prompt-templates",
		"--no-themes", "--no-context-files", "--no-approve",
		"-e", join(sandbox.base, "guard.js"), "-e", sandbox.env.PI_UI_STAGE,
		"-e", join(sandbox.base, "fixture.js"),
		"--provider", "stage-one-fixture", "--model", "fixture", "--thinking", "low",
		"--tools", sandbox.scenario === "rich" ? "read,write,edit" : "read", ...extra];
}

export async function reports(sandbox) {
	try { return (await readFile(sandbox.env.PI_UI_REPORT, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
	catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

async function main() {
	const mode = process.argv[2] ?? "regular";
	const scenario = process.argv[3] ?? "default";
	assert.ok(process.argv.length <= 4 && ["regular", "fullscreen"].includes(mode) && ["default", "rich"].includes(scenario),
		"Usage: node scripts/preview.mjs [regular|fullscreen] [default|rich]");
	assert.ok(process.stdin.isTTY && process.stdout.isTTY, "Preview needs a terminal; use scripts/capture.mjs for automated PTY captures");
	const sandbox = await createSandbox({ scenario });
	console.error(`Isolated Pi ${expectedVersion}; local offline scripted provider only. /ccstyle status, /ccstyle panel, /context, /quit.\nTemporary sandbox: ${sandbox.base}`);
	if (scenario === "rich") console.error(`Rich profile: built-in read/write/edit use only ${sandbox.cwd}; files are removed on exit. Native OSC8 links target reserved example.invalid.`);
	try {
		const child = spawn(process.execPath, cliArguments(sandbox, ["--tui-mode", mode, "Show the synthetic fixture"]),
			{ cwd: sandbox.cwd, env: sandbox.env, stdio: "inherit" });
		process.exitCode = await new Promise((done, reject) => { child.once("error", reject); child.once("exit", (code) => done(code ?? 1)); });
		const diagnostics = await reports(sandbox);
		assert.ok(!diagnostics.some((entry) => entry.phase === "network-denied" || entry.phase === "fixture-error"));
		assert.ok(diagnostics.some((entry) => entry.phase === "host-identity"), "preview did not validate host identity");
		if (scenario === "rich") {
			assert.ok(diagnostics.some((entry) => entry.phase === "rich-tools"), "rich built-in execution assertions did not run");
			assert.ok(diagnostics.some((entry) => entry.phase === "shutdown" && entry.activeTimers === 0), "rich preview did not validate cleanup");
			const initial = diagnostics.find((entry) => entry.phase === "agent-end");
			assert.ok(initial && !initial.notices.some((notice) => ["warning", "error"].includes(notice.type)),
				"initial rich fixture emitted a warning/error notification");
		}
	} finally { await sandbox.cleanup(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => { console.error(error); process.exitCode = 1; });
}
