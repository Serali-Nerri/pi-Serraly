import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { isolatedEnvironment } from "../../scripts/preview.mjs";

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
