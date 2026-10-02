import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { isolatedEnvironment } from "../../scripts/preview.mjs";

const root = resolve(import.meta.dirname, "../..");

test("release installs a locked runtime-only tree outside the workspace", { timeout: 180000 }, async () => {
	const base = await mkdtemp(join(tmpdir(), "serraly-release-test-"));
	try {
		const output = join(base, "release");
		const result = spawnSync(process.execPath, [
			join(root, "scripts/release.mjs"), "--output", output, "--build-id", "integration-fixture",
		], { cwd: root, env: isolatedEnvironment(base), encoding: "utf8", timeout: 150000 });
		assert.equal(result.status, 0, result.stderr || result.stdout);
		const manifest = JSON.parse(await readFile(join(output, "package.json"), "utf8"));
		assert.equal(manifest.private, true);
		assert.equal(manifest.devDependencies, undefined);
		assert.equal(manifest.workspaces, undefined);
		assert.deepEqual(manifest.dependencies, { "@llamaindex/liteparse": "2.10.1" });
		const lock = JSON.parse(await readFile(join(output, "package-lock.json"), "utf8"));
		assert.ok(Object.keys(lock.packages).some((path) => path.endsWith("liteparse-linux-x64-gnu")),
			"platform optional dependencies remain locked for native execution");
		assert.ok(Object.keys(lock.packages).every((path) =>
			!/(?:@earendil-works|typebox|typescript|esbuild|tsx|(?:^|\/)modules\/)/.test(path)), "no physical host or development closure");
		const dep = JSON.parse(await readFile(join(output, "node_modules/@llamaindex/liteparse/package.json"), "utf8"));
		assert.equal(dep.version, "2.10.1");
		const attemptedOverwrite = spawnSync(process.execPath, [
			join(root, "scripts/release.mjs"), "--output", output, "--build-id", "replacement",
		], { cwd: root, env: isolatedEnvironment(base), encoding: "utf8", timeout: 15000 });
		assert.notEqual(attemptedOverwrite.status, 0, "a live release must never be overwritten");
		assert.match(attemptedOverwrite.stderr, /already exists/i);
		assert.equal(JSON.parse(await readFile(join(output, "release.json"), "utf8")).buildId, "integration-fixture");
	} finally { await rm(base, { recursive: true, force: true }); }
});

// Break caught: a release named by an opaque digest instead of the package
// version, or a CLI that silently accepts unknown/malformed options.
test("release target defaults to the package version, not a digest", async () => {
	const { releaseTarget } = await import("../../scripts/release.mjs");
	const home = join(tmpdir(), "serraly-release-home");
	assert.deepEqual(releaseTarget([], { version: "0.1.0", home }),
		{ output: join(home, ".local/share/pi-Serraly/releases/0.1.0"), buildId: "0.1.0" });
	assert.deepEqual(releaseTarget(["--build-id", "1.2.3"], { version: "0.1.0", home }),
		{ output: join(home, ".local/share/pi-Serraly/releases/1.2.3"), buildId: "1.2.3" });
	assert.deepEqual(releaseTarget(["--output", "relative/out"], { version: "0.1.0", home }),
		{ output: resolve("relative/out"), buildId: "0.1.0" });
	assert.deepEqual(releaseTarget(["--output", join(home, "elsewhere"), "--build-id", "2.0.0"], { version: "0.1.0", home }),
		{ output: join(home, "elsewhere"), buildId: "2.0.0" });
	assert.throws(() => releaseTarget(["--nope"], { version: "0.1.0", home }), /Usage/);
	assert.throws(() => releaseTarget(["--build-id"], { version: "0.1.0", home }), /Usage/);
});
