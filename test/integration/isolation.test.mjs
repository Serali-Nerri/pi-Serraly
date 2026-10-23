import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { runIsolated } from "../../scripts/lib/workspace.mjs";

test("development commands cannot inherit operator credentials or leave their temporary home", async () => {
	process.env.PI_SERRALY_OPERATOR_SECRET = "must-not-inherit";
	try {
		const result = await runIsolated(process.execPath, ["--input-type=module", "-e", `
			import { writeFileSync } from "node:fs";
			writeFileSync(process.env.HOME + "/fixture", "owned");
			console.log(JSON.stringify({ home: process.env.HOME, secret: process.env.PI_SERRALY_OPERATOR_SECRET,
				agent: process.env.PI_CODING_AGENT_DIR, xdg: process.env.XDG_CONFIG_HOME }));
		`]);
		const data = JSON.parse(result.stdout);
		assert.equal(data.secret, undefined);
		assert.notEqual(data.home, process.env.HOME);
		assert(data.agent.startsWith(data.home + "/"));
		assert(data.xdg.startsWith(data.home + "/"));
		assert.equal(existsSync(data.home), false);
	} finally { delete process.env.PI_SERRALY_OPERATOR_SECRET; }
});

test("caught network attempts still fail an isolated command", async () => {
	await assert.rejects(runIsolated(process.execPath, ["--input-type=module", "-e", `
		try { await fetch("https://example.invalid/fixture"); } catch {}
	`]), /Network access denied/);
});

test("network denial follows Node child processes and timed-out processes are reaped", async () => {
	await assert.rejects(runIsolated(process.execPath, ["-e", `
		require("node:child_process").spawnSync(process.execPath, ["-e", 'try { require("node:https").get("https://example.invalid"); } catch {}']);
	`]), /Network access denied/);
	await assert.rejects(runIsolated(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 150 }), /timed out/);
});

test("a missing executable reports its startup error without crashing the runner", async () => {
	await assert.rejects(runIsolated("/nonexistent/pi-serraly-fixture", []), /ENOENT/);
	assert.equal((await runIsolated(process.execPath, ["-e", "console.log('still usable')"])).stdout.trim(), "still usable");
});
