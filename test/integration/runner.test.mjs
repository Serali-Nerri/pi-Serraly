import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { isolatedEnvironment } from "../../scripts/lib/environment.mjs";
import { isolatedRun } from "../../scripts/lib/workspace.mjs";

const root = resolve(import.meta.dirname, "../..");

test("test selection discovers loop regressions without running UI or fixture helpers", { timeout: 120000 }, async () => {
	const base = await mkdtemp(join(tmpdir(), "serraly-runner-test-"));
	try {
		const listed = spawnSync(process.execPath, [join(root, "scripts/test.mjs"), "--module", "loop", "--list"], {
			cwd: root, env: isolatedEnvironment(base), encoding: "utf8", timeout: 110000,
		});
		assert.equal(listed.status, 0, listed.stderr);
		const paths = listed.stdout.trim().split("\n");
		assert.ok(paths.length > 0 && paths.every((path) => /modules\/loop\/test\/.+\.test\.ts$/.test(path)), listed.stdout.slice(-1500));
	} finally { await rm(base, { recursive: true, force: true }); }
});

test("test selection lists subagents suites without executing fixtures or building dist", { timeout: 120000 }, async () => {
	const base = await mkdtemp(join(tmpdir(), "serraly-subagents-runner-"));
	try {
		const listed = spawnSync(process.execPath, [join(root, "scripts/test.mjs"), "--module", "subagents", "--list"], {
			cwd: root, env: isolatedEnvironment(base), encoding: "utf8", timeout: 110000,
		});
		assert.equal(listed.status, 0, listed.stderr);
		const paths = listed.stdout.trim().split("\n");
		assert.ok(paths.length > 0 && paths.every((path) => /modules\/subagents\/test\/.+\.test\.ts$/.test(path)),
			listed.stdout.slice(-1500));
		assert.ok(paths.some((path) => path.endsWith("/agent-manager.test.ts")));
		assert.ok(paths.some((path) => path.endsWith("/output-file.test.ts")));
	} finally { await rm(base, { recursive: true, force: true }); }
});

test("isolated runtime rejects a caught network attempt", { timeout: 30000 }, async () => {
	const base = await mkdtemp(join(tmpdir(), "serraly-caught-network-"));
	try {
		// A missing local Unix socket cannot reach an external service even before
		// the guard is installed. Catching its error must not hide a guard event.
		const script = `
			const { Socket } = require("node:net");
			try {
				const socket = new Socket();
				socket.on("error", () => {});
				socket.connect({ path: ${JSON.stringify(join(base, "missing.sock"))} });
			} catch {}
		`;
		await assert.rejects(isolatedRun(process.execPath, ["-e", script], root, { denyNetwork: true }), /network/i);
	} finally { await rm(base, { recursive: true, force: true }); }
});
