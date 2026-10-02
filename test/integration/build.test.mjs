import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { isolatedEnvironment } from "../../scripts/preview.mjs";

const root = resolve(import.meta.dirname, "../..");

// A missing entry breaks package discovery even if the UI-only bundle succeeds.
test("build produces executable ESM for every entry allowed by the package manifest", async () => {
	const base = await mkdtemp(join(tmpdir(), "serraly-build-test-"));
	try {
		const env = isolatedEnvironment(base);
		const built = spawnSync(process.execPath, [join(root, "scripts/build.mjs")], {
			cwd: root, env, encoding: "utf8", timeout: 90000,
		});
		assert.equal(built.status, 0, built.stderr || built.stdout);
		const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
		for (const entry of manifest.pi.extensions) {
			const checked = spawnSync(process.execPath, ["--check", join(root, entry)], {
				cwd: base, env, encoding: "utf8", timeout: 10000,
			});
			assert.equal(checked.status, 0, `${entry}: ${checked.stderr}`);
		}
	} finally { await rm(base, { recursive: true, force: true }); }
});
