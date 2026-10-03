import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { releaseFixture, sandboxFixture, diagnostics } from "./helpers/runtime.mjs";
import { runChild } from "../../scripts/preview.mjs";

let stage;
before(async () => { stage = await releaseFixture(); }, { timeout: 180000 });
after(async () => { await stage?.cleanup(); });
const peek = "mcp__fixture__peek", effect = "mcp__fixture__effect", late = "mcp__fixture__late";
const call = (name, args = {}, extra = {}) => ({ name, arguments: args, ...extra });
const code = (source, extra) => call("codemode", { code: source }, extra);
const search = (query) => call("tool_search", { query, limit: 8 });
const searchPeek = [search("fixture peek sentinel"), call(peek)];
const resourceCode = `text(await tools.mcp__fixture__peek({})); text(await tools.read_mcp_resource({server:"fixture",uri:"fixture://sentinel"}));`;

async function run(scenario, config = {}) {
	const sandbox = await sandboxFixture(stage.release, config);
	try {
		// Gates belong to this sandbox, not shared /tmp paths or real sessions.
		if (config.startupGate) config.startupGate = join(sandbox.base, "release-startup");
		if (config.factoryGate) config.factoryGate = join(sandbox.base, "release-factory");
		if (config.readyGate) config.readyGate = join(sandbox.base, "release-ready");
		if (config.cleanupGate) config.cleanupGate = join(sandbox.base, "release-cleanup");
		if (config.providerGate) {
			config.providerGate = join(sandbox.base, "release-provider");
			for (const plan of Object.values(config.plans)) for (const step of plan) if (step.gate) step.gate = config.providerGate;
		}
		await writeFile(sandbox.env.SERRALY_CONFIG, JSON.stringify(config));
		const result = await runChild(sandbox, [join(sandbox.base, "fixtures/subagents-worker.mjs"), stage.host.directory, scenario], "", 60000);
		const log = await diagnostics(sandbox);
		assert.equal(result.code, 0, `${scenario}: ${result.stderr}\n${JSON.stringify(log.filter((item) => ["worker-error", "fixture-error", "cleanup-error", "forced-cleanup"].includes(item.phase)))}`);
		assert.equal(result.stdout, "", "SDK/MCP probes never contaminate protocol stdout");
		assert.equal(result.stderr, "");
		assert.ok(!log.some((item) => ["network-denied", "fixture-error", "forced-cleanup", "worker-deadline"].includes(item.phase)), JSON.stringify(log));
		assert.ok(log.some((item) => item.phase === "complete" && item.scenario === scenario), "worker reached behavior assertions");
		assert.ok(log.filter((item) => item.phase === "mcp-start").every((item) => item.guarded), "every MCP worker inherits network-deny preload");
		for (const { pid } of starts(log)) assert.equal(log.filter((item) => item.phase === "mcp-exit" && item.pid === pid).length, 1, "owned MCP process exited once");
		return log;
	} finally { await sandbox.cleanup(); }
}
const results = (log, marker = "main") => log.filter((item) => item.phase === "provider-request" && item.marker === marker).at(-1)?.results ?? [];
const requests = (log, marker = "main") => log.filter((item) => item.phase === "provider-request" && item.marker === marker);
const starts = (log) => log.filter((item) => item.phase === "mcp-start");
const calls = (log, name) => log.filter((item) => item.phase === "mcp-call" && item.name === name);

// Omitting native factories, freezing the initial registry, or copying parent
// closures breaks these returned sentinels through the production Agent path.
for (const [name, config, wanted] of [
	["search activates a deferred MCP tool", { exposure: "deferred", plans: { main: searchPeek } }, /mcp-sentinel:user:peek/],
	["codemode calls MCP and reads a resource", { exposure: "codemode", plans: { main: [code(resourceCode)] } }, /resource-sentinel:user/],
	["direct MCP tools activate after startup with empty defaultTools", { exposure: "direct", settings: { defaultTools: [] }, plans: { main: [call(peek, {}, { waitForTool: peek })] } }, /mcp-sentinel:user:peek/],
	["codemode-only and zero inline budget preserve MCP calls", { exposure: "codemode", settings: { codemode: { mode: "only", inlineBudget: 0 } }, plans: { main: [code(resourceCode)] } }, /resource-sentinel:user/],
	["toolExposure exposes only selected tools of a hidden server", { exposure: "hidden", server: { toolExposure: { peek: "direct" } }, plans: { main: [call(peek, {}, { waitForTool: peek }), code(`try { text(await tools.${effect}({})); } catch(e) { text(e.message); }`)] } }, /mcp-sentinel:user:peek/],
]) test(name, { timeout: 70000 }, async () => {
	const log = await run("roundtrip", config);
	assert.match(log.find((item) => item.phase === "agent-result").text, wanted);
	assert.equal(calls(log, "peek").length, 1, "real MCP call, not just inventory");
	assert.equal(starts(log).length, 1, "one independent child connection");
	if (name.includes("resource") || name.includes("inline")) assert.equal(log.filter((item) => item.phase === "mcp-resource").length, 1);
	if (config.settings?.codemode?.mode === "only") {
		assert.deepEqual(requests(log)[0].declared.map((tool) => tool.name), ["tool_search", "codemode"], "target codemode settings affect actual child requests");
	}
	if (config.exposure === "hidden") assert.equal(calls(log, "effect").length, 0, "hidden tools cannot execute even by explicit name");
});

test("hidden MCP tools cannot be searched, directly called or nested-called", { timeout: 70000 }, async () => {
	const log = await run("roundtrip", { exposure: "hidden", plans: { main: [search("fixture peek sentinel"), call(peek),
		code(`try { text(await tools.${peek}({})); } catch(e) { text(e.message); }`)] } });
	assert.equal(starts(log).length, 1);
	assert.equal(calls(log, "peek").length, 0);
	assert.match(results(log)[0].text, /No matching tools/);
	assert.equal(results(log)[1].isError, true);
	assert.ok(!requests(log).at(-1).active.includes(peek));
});

test("project defaultTools modifiers reach the child without freezing later MCP activation", { timeout: 70000 }, async () => {
	const log = await run("roundtrip", { trusted: true, exposure: "direct", settings: { defaultTools: ["+codemode", "-edit"] },
		projectSettings: { defaultTools: ["+tool_search", "-write"] }, plans: { main: [call(peek, {}, { waitForTool: peek })] } });
	const active = requests(log)[0].active;
	assert.ok(active.includes("read") && active.includes("codemode") && active.includes("tool_search"));
	assert.ok(!active.includes("edit") && !active.includes("write"));
	assert.equal(calls(log, "peek").length, 1);
});

test("late MCP additions become callable and withdrawn tools stop executing", { timeout: 70000 }, async () => {
	const log = await run("dynamic", { exposure: "codemode", plans: { main: [
		code(`text(await tools.mcp__fixture__mutate({action:"add"}));`),
		code(`text(await tools.${late}({}));`, { waitForTool: late }),
		code(`text(await tools.mcp__fixture__mutate({action:"withdraw"}));`),
		code(`try { text(await tools.${late}({})); } catch(e) { text(e.message); }`, { waitAbsent: late }),
		call(late),
	] } });
	assert.equal(calls(log, "late").length, 1, "neither nested nor direct call reaches withdrawn server tool");
	assert.match(results(log)[1].text, /mcp-sentinel:user:late/);
	assert.equal(results(log).at(-1).isError, true);
	assert.ok(log.filter((item) => item.phase === "mcp-list").some((item) => item.late));
});

test("continuation retains child search/store while sibling and parent stay isolated", { timeout: 70000 }, async () => {
	const log = await run("state", { exposure: "deferred", plans: {
		first: [...searchPeek, code(`store("child-token", "first-child-value"); text("stored");`)],
		continued: [code(`text({value:load("child-token") ?? null}); text(await tools.${peek}({}));`)],
		sibling: [code(`text({value:load("child-token") ?? null});`)],
		parent: [code(`text({value:load("child-token") ?? null});`)],
	} });
	assert.match(results(log, "continued")[0].text, /first-child-value/);
	assert.match(results(log, "sibling")[0].text, /"value":null/);
	assert.match(results(log, "parent")[0].text, /"value":null/);
	const first = requests(log, "first")[0], continuation = requests(log, "continued")[0];
	assert.equal(first.sessionId, continuation.sessionId);
	assert.equal(first.factory, continuation.factory, "provider file is not reloaded on continuation");
	assert.ok(continuation.active.includes(peek));
	assert.ok(!requests(log, "sibling")[0].active.includes(peek));
	assert.ok(!requests(log, "parent")[0].active.includes(peek));
	assert.notEqual(first.factory, requests(log, "sibling")[0].factory);
	assert.equal(starts(log).length, 2);
});

for (const [name, profile, plan, denied] of [
	["exact MCP exclude blocks direct, search and codemode side effects", { exclude_tools: [effect] }, [
		call(effect), search("fixture effect observable mutation"), call(effect), code(`try { text(await tools.${effect}({})); } catch(e) { text(e.message); }`), code(`text(await tools.${peek}({}));`),
	], "effect"],
	["tools false blocks every route", { tools: false }, [call(effect), search("fixture effect"), code(`text(await tools.${effect}({}));`), call("write", { path: "forbidden-write", content: "denied" })], "effect"],
	["empty tool allowlist blocks every route", { tools: [] }, [call(effect), search("fixture effect"), code(`text(await tools.${effect}({}));`), call("write", { path: "forbidden-write", content: "denied" })], "effect"],
	["Explore's readonly gate denies write, edit and recursion", { name: "Explore", extensions: ["PROVIDER"] }, [
		call("write", { path: "forbidden-write", content: "denied" }), call("edit", { path: "seed.txt", oldText: "seed", newText: "changed" }),
		call("Agent", { prompt: "forbidden" }), call("StopAgent", { agent_id: "missing" }), call("AgentStatus"), call("read", { path: "seed.txt" }),
	], "effect"],
	["late extension deny blocks newly registered side effects", { exclude_tools: ["subagents-provider/*"] }, [
		call("tool_search", { query: "Late local effect" }, { lateTool: true }), call("late_effect"), code(`try { text(await tools.late_effect({})); } catch(e) { text(e.message); }`),
	], "late-effect"],
]) test(name, { timeout: 70000 }, async () => {
	const log = await run("permissions", { profile, plans: { main: plan }, agent: profile.name ?? "fixture" });
	assert.equal(denied === "effect" ? calls(log, "effect").length : log.filter((item) => item.phase === "late-effect").length, 0);
	assert.ok(results(log).some((item) => item.isError || /not.*(found|available)|denied|Unknown tool/i.test(item.text)), "at least one denied attempt actually completed");
	if (profile.exclude_tools?.includes(effect)) assert.equal(calls(log, "peek").length, 1, "positive permission control");
	if (profile.name === "Explore") {
		assert.match(results(log).at(-1).text, /seed/);
		for (const name of ["write", "edit", "Agent", "StopAgent", "AgentStatus", "codemode", "tool_search"]) {
			assert.ok(!requests(log)[0].registered.includes(name), "Explore registry cannot admit " + name);
		}
		assert.equal(starts(log).length, 0, "Explore does not connect MCP implicitly");
	}
});

// Re-filling a false/empty extension selection, or executing candidates before
// selection, admits these native/ordinary calls despite an explicit empty set.
for (const extensions of [false, []]) test(`extensions ${JSON.stringify(extensions)} suppresses native and ordinary child factories before execution`, { timeout: 70000 }, async () => {
	const log = await run("permissions", { modelsJsonTransport: true, profile: { extensions }, plans: { main: [
		call("codemode", { code: `text(await tools.${effect}({}));` }), search("fixture effect"), call(effect),
		call("ordinary_effect"), call("read", { path: "seed.txt" }),
	] } });
	assert.equal(log.filter((item) => item.phase === "script-api-registered").length, 1, "root installs only the public global transport");
	assert.equal(log.filter((item) => item.phase === "provider-factory").length, 1, "root provider factory is not forced into children");
	assert.equal(log.filter((item) => item.phase === "provider-start").length, 1);
	assert.equal(log.filter((item) => item.phase === "ordinary-factory" || item.phase === "ordinary-effect").length, 0);
	assert.equal(starts(log).length, 0, "unselected native MCP never connects");
	assert.equal(calls(log, "effect").length, 0);
	assert.equal(requests(log).length, 6, "five actual child calls and a final response, no root prompt");
	assert.ok(requests(log).every((item) => item.factory === "models-json-transport"));
	assert.deepEqual(results(log).slice(0, 4).map((item) => item.isError), [true, true, true, true]);
	assert.match(results(log).at(-1).text, /seed/);
	const declared = requests(log)[0].declared.map((tool) => tool.name);
	assert.ok(declared.includes("read"), "base builtin remains available without any extension");
	for (const name of ["codemode", "tool_search", effect, "ordinary_effect"]) assert.ok(!declared.includes(name));
});

test("an explicit enabled extension set can execute the ordinary and native suppression controls", { timeout: 70000 }, async () => {
	const log = await run("roundtrip", { modelsJsonTransport: true, profile: { extensions: true }, plans: { main: [
		call("ordinary_effect"), code(resourceCode), call("read", { path: "seed.txt" }),
	] } });
	assert.equal(log.filter((item) => item.phase === "ordinary-factory").length, 1, "the suppressed candidate is a real executable factory");
	assert.equal(log.filter((item) => item.phase === "ordinary-effect").length, 1);
	assert.match(results(log)[0].text, /ordinary-executed/);
	assert.equal(starts(log).length, 1);
	assert.equal(calls(log, "peek").length, 1);
	assert.match(results(log)[1].text, /resource-sentinel:user/);
	assert.match(results(log)[2].text, /seed/);
});

// Late *exact* control names are an adversarial third-party registration, not
// harmless namespaced MCP names. Removing unconditional SDK exclusions permits
// these real direct/search/codemode calls to run the fixture execute functions.
test("late exact Agent/StopAgent/AgentStatus registration cannot execute through direct or native nested routes", { timeout: 70000 }, async () => {
	const controls = ["Agent", "StopAgent", "AgentStatus"];
	const log = await run("permissions", { plans: { main: [
		call("read", { path: "seed.txt" }, { lateControlTools: true }),
		...controls.map((name) => call(name)),
		...controls.flatMap((name) => [search(`Late local effect ${name}`), call(name)]),
		code(`for (const name of ["Agent","StopAgent","AgentStatus"]) { text({search:await searchTools("Late local effect " + name)}); try { text(await tools[name]({})); } catch(e) { text(e.message); } }`),
		code(`text(await tools.${peek}({}));`),
	] } });
	const registration = log.find((item) => item.phase === "late-controls-registered");
	assert.ok(registration, "malicious factory attempted late registration after binding");
	assert.equal(log.filter((item) => item.phase === "recursive-effect").length, 0, "none of the three real execute side effects ran");
	for (const item of requests(log)) for (const name of controls) assert.ok(!item.registered.includes(name), "child registry excludes " + name);
	const outcome = results(log);
	assert.match(outcome[0].text, /seed/);
	for (const index of [1, 2, 3, 5, 7, 9]) assert.equal(outcome[index].isError, true, "direct/search-then-call denied");
	for (const index of [4, 6, 8]) {
		assert.equal(outcome[index].isError, false, "real native search ran rather than being disabled");
		for (const name of controls) assert.doesNotMatch(outcome[index].text, new RegExp(`^- ${name}:`, "m"), "search cannot expose exact control name");
	}
	for (const name of controls) assert.match(outcome[10].text, new RegExp(`tools\\.${name} does not exist`), "actual codemode denies " + name);
	assert.doesNotMatch(outcome[10].text, /"name"\s*:\s*"(?:Agent|StopAgent|AgentStatus)"/, "codemode's actual searchTools cannot rediscover denied control names");
	assert.equal(log.filter((item) => item.phase === "child-tool-result" && item.name === "tool_search").length, 3, "native tool_search executed before direct denied calls");
	assert.equal(calls(log, "peek").length, 1, "allowed native call is a positive control");
	assert.ok(log.some((item) => item.phase === "child-tool-result" && item.name === peek && item.parentToolCallId), "allowed nested route actually executed");
});

for (const trusted of [false, true]) test(`${trusted ? "trusted" : "untrusted"} child resolves user/project same-name MCP in custom agentDir`, { timeout: 70000 }, async () => {
	const log = await run("trust", { trusted, projectMcp: true, plans: { main: searchPeek } });
	assert.equal(starts(log).length, 1);
	assert.equal(starts(log)[0].label, trusted ? "project" : "user");
	assert.match(results(log).at(-1).text, trusted ? /mcp-sentinel:project:peek/ : /mcp-sentinel:user:peek/);
	assert.ok(!starts(log).some((item) => item.label === "wrong-home"));
});

test("host-disabled MCP wins over an explicit child native selection", { timeout: 70000 }, async () => {
	const log = await run("permissions", { settings: { extensions: ["-builtin:mcp"] }, plans: { main: [search("fixture peek"), call(peek)] } });
	assert.equal(starts(log).length, 0);
	assert.equal(results(log).at(-1).isError, true);
});

test("exact write/edit exclusions survive search and nested execution", { timeout: 70000 }, async () => {
	const log = await run("permissions", { profile: { exclude_tools: ["write", "edit"] }, plans: { main: [
		call("write", { path: "forbidden-write", content: "denied" }),
		search("write edit files"),
		code(`for (const [name,args] of [["write",{path:"forbidden-write",content:"denied"}],["edit",{path:"seed.txt",oldText:"seed",newText:"changed"}]]) { try { text(await tools[name](args)); } catch(e) { text(e.message); } }`),
		call("read", { path: "seed.txt" }),
	] } });
	assert.equal(results(log)[0].isError, true);
	assert.match(results(log)[2].text, /tools.write does not exist/);
	assert.match(results(log)[2].text, /tools.edit does not exist/);
	assert.match(results(log).at(-1).text, /seed/);
});

for (const [name, config, label, protectedFactories] of [
	["untrusted same-repo target cannot upgrade parent trust", { trusted: false, target: "same-repo" }, "user", 0],
	["undecided cross-repo target ignores project resources", { trusted: true, target: "cross" }, "user", 0],
	["explicit same-repo deny beats trusted parent", { trusted: true, target: "same-repo", targetTrusted: false }, "user", 0],
	["explicit trusted target loads project resources", { trusted: false, target: "cross", targetTrusted: true }, "target-project", 1],
]) test(name, { timeout: 70000 }, async () => {
	const log = await run("trust", { ...config, profile: { extensions: true }, plans: { main: searchPeek } });
	assert.equal(starts(log).length, 1);
	assert.equal(starts(log)[0].label, label);
	assert.equal(log.filter((item) => item.phase === "protected-factory").length, protectedFactories);
	assert.match(results(log).at(-1).text, new RegExp(`mcp-sentinel:${label}:peek`));
});

// Only reload below invokes an actual SDK replacement. The other reasons use
// the public shutdown-event seam and qualify compiled cleanup handlers, not
// persistence/fork/resume mechanics (those belong to SDK/runtime suites).
for (const reason of ["quit", "reload", "new", "resume", "fork"]) test(`${reason} drains retained MCP processes`, { timeout: 70000 }, async () => {
	const log = await run("shutdown", { reason, plans: { main: searchPeek } });
	assert.equal(calls(log, "peek").length, 1);
	const child = requests(log)[0].sessionId;
	assert.equal(log.filter((item) => item.phase === "provider-shutdown" && item.sessionId === child && item.reason === reason).length, 1);
	assert.equal(log.filter((item) => item.phase === "mcp-exit").length, 1);
});

test("unsupported MCP wildcard restrictions fail closed before execution", { timeout: 70000 }, async () => {
	const log = await run("invalid-permission", { profile: { exclude_tools: ["mcp/*"] }, plans: { main: [call(effect)] } });
	assert.equal(calls(log, "effect").length, 0);
});

test("SDK initialization failure after MCP start releases the allocated child", { timeout: 70000 }, async () => {
	const log = await run("initialization-failure", { plans: { main: searchPeek } });
	assert.equal(starts(log).length, 1);
	assert.equal(log.filter((item) => item.phase === "mcp-exit").length, 1);
	const child = log.find((item) => item.phase === "provider-resource-failure").sessionId;
	assert.equal(log.filter((item) => item.phase === "provider-shutdown" && item.sessionId === child).length, 1);
});

test("shutdown awaits a child allocated after its record was removed", { timeout: 70000 }, async () => {
	const log = await run("allocation-race", { factoryGate: true, readyGate: true, plans: { blocked: searchPeek } });
	assert.equal(starts(log).length, 1);
	assert.ok(log.findIndex((item) => item.phase === "shutdown-began") < log.findIndex((item) => item.phase === "mcp-start"));
	assert.equal(log.filter((item) => item.phase === "mcp-exit").length, 1);
});

test("parent shutdown drains MCP initialization completing after shutdown begins", { timeout: 70000 }, async () => {
	const log = await run("late-shutdown", { startupGate: true, providerGate: true,
		plans: { blocked: [call(peek, {}, { gate: true })] } });
	assert.equal(starts(log).length, 1);
	assert.equal(log.filter((item) => item.phase === "mcp-exit").length, 1);
});

test("Stop retains its independent MCP connection for continuation until Clear", { timeout: 70000 }, async () => {
	const log = await run("stop-retain", { providerGate: true, plans: {
		blocked: [call(peek, {}, { gate: true })], continued: searchPeek,
	} });
	assert.equal(starts(log).length, 1);
	assert.equal(calls(log, "peek").length, 1);
});

test("Clear closes MCP that was still initializing when Stop arrived", { timeout: 70000 }, async () => {
	const log = await run("late-stop-clear", { startupGate: true, providerGate: true,
		plans: { blocked: [call(peek, {}, { gate: true })] } });
	assert.equal(starts(log).length, 1);
	assert.equal(log.filter((item) => item.phase === "mcp-exit").length, 1);
});

test("serial twelve retained connections and three active slots are separate resource budgets", { timeout: 70000 }, async () => {
	const log = await run("resources", { limit: 3, providerGate: true, plans: {
		serial: searchPeek, concurrent: [search("fixture peek sentinel"), call(peek, {}, { gate: true })],
	} });
	assert.deepEqual(log.filter((item) => item.phase === "resource-count").map(({ active, retained, live }) => ({ active, retained, live })), [
		{ active: 0, retained: 12, live: 12 }, { active: 3, retained: 0, live: 3 }, { active: 0, retained: 4, live: 4 },
	]);
	assert.equal(starts(log).length, 16);
	assert.equal(log.filter((item) => item.phase === "mcp-exit").length, 16);
});

// Expiring rows must not become an implicit session/MCP TTL. This is a public
// SDK TUI-style bind, not a claim about a real terminal/PTY interaction.
test("widget retention hides expired rows but keeps a continuable native connection until public Clear", { timeout: 70000 }, async () => {
	const log = await run("widget-retain", { plans: { first: searchPeek, continued: [call(peek)] } });
	assert.deepEqual(log.filter((item) => item.phase === "retention-count").map(({ point, rows, retained, live }) => ({ point, rows, retained, live })), [
		{ point: "visible", rows: 1, retained: 1, live: 1 },
		{ point: "expired", rows: 0, retained: 1, live: 1 },
		{ point: "cleared", rows: 0, retained: 0, live: 0 },
	]);
	assert.equal(starts(log).length, 1);
	assert.equal(calls(log, "peek").length, 2, "real MCP calls before and after row expiry");
	assert.equal(requests(log, "first")[0].sessionId, requests(log, "continued")[0].sessionId);
	assert.equal(requests(log, "first")[0].factory, requests(log, "continued")[0].factory);
	assert.match(results(log, "continued")[0].text, /mcp-sentinel:user:peek/);
	const pid = starts(log)[0].pid;
	assert.ok(log.findIndex((item) => item.phase === "retention-count" && item.point === "expired") < log.findIndex((item) => item.phase === "mcp-exit" && item.pid === pid), "expiry does not disconnect");
});

for (const scenario of ["timer-clear", "timer-shutdown"]) test(`${scenario} drains pending notifications and owned watchdog/cleanup timers`, { timeout: 70000 }, async (t) => {
	const log = await run(scenario, { cleanupGate: true, plans: { main: searchPeek } });
	const counts = log.filter((item) => item.phase === "timer-count");
	t.diagnostic(JSON.stringify({ scenario, timers: counts.map(({ point, watchdog, widget, notification, cleanup, sdk }) => ({ point, watchdog, widget, notification, cleanup, sdk })),
		connections: log.filter((item) => item.phase === "cleanup-count").map(({ point, live }) => ({ point, live })) }));
	assert.equal(counts.find((item) => item.point === "opened").watchdog, 1);
	assert.equal(counts.find((item) => item.point === "pending").notification, 1, "test reached a real pending nudge");
	assert.ok(counts.find((item) => item.point === "closing").cleanup > 0, "test reached real pending native cleanup timers");
	assert.deepEqual(log.filter((item) => item.phase === "cleanup-count").map(({ point, live }) => ({ point, live })), [
		{ point: "closing", live: 1 }, { point: "closed", live: 0 },
	]);
	if (scenario === "timer-clear") {
		const clear = counts.find((item) => item.point === "cleared");
		assert.equal(clear.watchdog, 1, "Clear does not dispose the still-live parent manager");
		assert.equal(clear.notification, 0);
		assert.equal(clear.cleanup, 0);
	}
	for (const point of ["shutdown", "settled"]) {
		const count = counts.find((item) => item.point === point);
		assert.deepEqual([count.watchdog, count.widget, count.notification, count.cleanup, count.sdk], [0, 0, 0, 0, 0], "no owned or SDK timer survives " + point);
	}
	assert.equal(log.filter((item) => item.phase === "parent-notification" || (item.phase === "ui-notification" && /Subagent/i.test(item.message))).length, 0);
	if (scenario === "timer-clear") assert.equal(log.filter((item) => item.phase === "ui-notification" && /^Cleared 1 finished agent/.test(item.message)).length, 1, "public Clear's own success notification is not a stale nudge");
	assert.equal(starts(log).length, 1);
	assert.equal(calls(log, "peek").length, 1);
	assert.equal(requests(log).length, 3, "child search/call/final only; no stale parent model request");
});
