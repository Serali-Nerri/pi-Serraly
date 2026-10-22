import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { names, releaseEntries, releaseFixture, sdkScenario, sandboxFixture, cliArgs, diagnostics } from "./helpers/runtime.mjs";
import { runChild } from "../../scripts/lib/process.mjs";
import { runRpc, captureReleasePty } from "./helpers/host-cli.mjs";
import { ptyAvailability } from "../../scripts/capture.mjs";

let stage;
before(async () => { stage = await releaseFixture(); }, { timeout: 180000 });
after(async () => { await stage?.cleanup(); });

// Break caught: a missing compiled entry/lazy module or a release that still loads
// through workspace dependencies cannot reach any real loader scenario.
test("release manifest exposes only compiled extensions, never companion skills", async () => {
	const manifest = JSON.parse(await readFile(join(stage.release, "package.json"), "utf8"));
	assert.deepEqual(manifest.pi, { extensions: releaseEntries });
});

for (const name of names) {
	test(`compiled ${name} loads independently through Pi 1.3.0`, { timeout: 30000 }, async () => {
		await sdkScenario(stage, "inventory", { names: [name] });
	});
}

test("actual package settings can disable the compiled UI entry independently", { timeout: 60000 }, async () => {
	await sdkScenario(stage, "filters", {}, 55000);
});

for (const mode of ["print", "json", "rpc"]) {
	test(`compiled release in bundled CLI ${mode} has no UI-owned stdout/timer/prototype pollution`, { timeout: 30000 }, async () => {
		const sandbox = await sandboxFixture(stage.release);
		try {
			let records;
			if (mode === "rpc") records = await runRpc(sandbox, cliArgs(sandbox, stage.host, ["--mode", "rpc"]));
			else {
				const result = await runChild(sandbox, cliArgs(sandbox, stage.host, [...(mode === "print" ? ["--print"] : ["--mode", "json"]), "Local synthetic reply"]));
				assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, "");
				if (mode === "print") assert.equal(result.stdout.trim(), "Serraly synthetic fixture complete.");
				else {
					records = result.stdout.trim().split("\n").map(JSON.parse);
					assert.equal(records[0].type, "session");
					assert.ok(records.some((record) => record.type === "agent_settled"));
				}
			}
			if (records) assert.ok(!records.some((record) => record.type === "extension_error"));
			const reports = await diagnostics(sandbox);
			assert.ok(!reports.some((report) => ["network-denied", "fixture-error"].includes(report.phase)), JSON.stringify(reports));
			const final = reports.find((report) => report.phase === "shutdown");
			assert.ok(final, "post-cleanup assertions reached shutdown");
			assert.equal(final.mode, mode); assert.equal(final.timers, 0); assert.deepEqual(final.uiCalls, []);
			assert.equal(final.providerCalls, 1);
			assert.ok(reports.some((report) => report.phase === "settled"));
		} finally { await sandbox.cleanup(); }
	});
}

// Break caught: loading the package must not force regular mode when the host
// defaults to fullscreen; explicit regular/fullscreen selections still work.
for (const [selection, mode] of [["default", "fullscreen"], ["regular", "regular"], ["fullscreen", "fullscreen"]]) {
	for (const width of selection === "default" ? [80] : [40, 80, 120]) {
			test(`final release under bundled CLI ${selection}/${width}: compiled UI renders host-owned TUI rows`,
			{ timeout: 40000, skip: ptyAvailability() }, async () => {
				const sandbox = await sandboxFixture(stage.release, { tui: true });
				try {
					const settings = JSON.parse(await readFile(join(sandbox.env.PI_CODING_AGENT_DIR, "settings.json"), "utf8"));
					assert.equal(settings.tuiMode, undefined, "isolated settings do not override the host default");
					const modeArgs = selection === "default" ? [] : ["--tui-mode", selection];
					const result = await captureReleasePty(sandbox, cliArgs(sandbox, stage.host, [...modeArgs, "Local fixture tool sequence"]), width);
					assert.ok(result.reports.some((report) => report.phase === "host-identity" && report.tuiMode === mode), JSON.stringify(result.reports));
					assert.ok(result.reports.some((report) => report.phase === "host-identity" && report.fullscreen === (mode === "fullscreen")));
					assert.ok(result.reports.some((report) => report.phase === "settled" && report.providerCalls === 3));
					assert.ok(result.reports.some((report) => report.phase === "shutdown"));
					assert.ok(!result.reports.some((report) => ["network-denied", "fixture-error"].includes(report.phase)));
					assert.match(result.ansi, /Read seed\.txt/);
				} finally { await sandbox.cleanup(); }
			});
	}
}
