import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { isolatedEnvironment } from "../../scripts/lib/environment.mjs";
import { discoverPackages, selectExtensions } from "../../scripts/lib/packages.mjs";

const root = resolve(import.meta.dirname, "../..");

// A missing entry breaks package discovery even if another bundle succeeds.
test("build produces executable ESM for every entry allowed by the package manifest", { timeout: 300000 }, async () => {
	const base = await mkdtemp(join(tmpdir(), "serraly-build-test-"));
	try {
		const env = isolatedEnvironment(base);
		const built = spawnSync(process.execPath, [join(root, "scripts/build.mjs")], {
			cwd: root, env, encoding: "utf8", timeout: 280000,
		});
		assert.equal(built.status, 0, built.stderr || built.stdout);
		const packages = selectExtensions(await discoverPackages());
		assert.deepEqual(packages.map((pkg) => pkg.name), [
			"pi-add-dir", "pi-ask-user-question", "pi-background-shell", "pi-loop", "pi-session-reference", "pi-subagents", "pi-tools", "pi-ui",
		]);
		for (const pkg of packages) {
			const manifest = JSON.parse(await readFile(join(pkg.directory, "package.json"), "utf8"));
			for (const entry of manifest.pi?.extensions ?? []) {
				const path = join(pkg.directory, entry.slice(2));
				const checked = spawnSync(process.execPath, ["--check", path], { cwd: base, env, encoding: "utf8", timeout: 10000 });
				assert.equal(checked.status, 0, `${pkg.name} ${entry}: ${checked.stderr}`);
			}
			assert.equal(manifest.dependencies, undefined, `${pkg.name} declares no installable runtime dependencies`);
		}
	} finally { await rm(base, { recursive: true, force: true }); }
});
