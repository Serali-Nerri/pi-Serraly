import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { isolatedEnvironment } from "../../scripts/lib/environment.mjs";
import { names, releaseEntries } from "./fixtures/contracts.mjs";

const root = resolve(import.meta.dirname, "../..");

const present = async (path) => {
	try { await lstat(path); return true; }
	catch (error) { if (error.code === "ENOENT") return false; throw error; }
};

/**
 * The release must be reproducible without any install step. A package-manager
 * invocation finds this shim first, records it and fails, so "no install" is
 * observed rather than assumed.
 */
async function poisonPackageManager(base) {
	const bin = join(base, "poison-bin");
	const marker = join(base, "install-attempt");
	await mkdir(bin, { recursive: true });
	await writeFile(join(bin, "npm"), `#!/bin/sh\nprintf '%s' "$*" >> ${JSON.stringify(marker)}\nexit 1\n`);
	await chmod(join(bin, "npm"), 0o755);
	return { env: { ...isolatedEnvironment(base), PATH: bin }, marker };
}

test("release carries eight independent members prepared without a package manager", { timeout: 300000 }, async () => {
	const base = await mkdtemp(join(tmpdir(), "serraly-release-test-"));
	try {
		const output = join(base, "release");
		const { env, marker } = await poisonPackageManager(base);
		const result = spawnSync(process.execPath, [
			join(root, "scripts/release.mjs"), "--output", output, "--build-id", "integration-fixture",
		], { cwd: root, env, encoding: "utf8", timeout: 290000 });
		assert.equal(result.status, 0, result.stderr || result.stdout);
		assert.equal(await present(marker), false, "release preparation never shells out to a package manager");
		const manifest = JSON.parse(await readFile(join(output, "package.json"), "utf8"));
		assert.equal(manifest.private, true);
		assert.equal(manifest.devDependencies, undefined);
		assert.equal(manifest.workspaces, undefined);
		assert.deepEqual(manifest.dependencies, {}, "release manifest declares no installable runtime dependencies");
		assert.deepEqual(manifest.pi, { extensions: releaseEntries });
		const labels = releaseEntries.map((entry) => entry.slice(entry.lastIndexOf("/") + 1));
		assert.equal(new Set(labels).size, releaseEntries.length, "each extension entry must render as a distinct label");
		assert.equal(await present(join(output, "package-lock.json")), false);
		assert.equal(await present(join(output, "node_modules")), false);
		for (const name of names) {
			assert.equal(await present(join(output, "extensions", name, "package.json")), true, name);
			assert.equal(await present(join(output, "extensions", name, "dist/artifacts.json")), true, `${name} seal`);
		}
		const record = JSON.parse(await readFile(join(output, "release.json"), "utf8"));
		assert.equal(record.host, "1.2.0", "release metadata names the qualified Pi host, not an obsolete baseline");
		assert.deepEqual(Object.keys(record.packages).sort(), names);
		for (const [name, member] of Object.entries(record.packages)) {
			assert.equal(member.path, `extensions/${name}`);
			assert.match(member.digest, /^[0-9a-f]{64}$/);
		}
		const attemptedOverwrite = spawnSync(process.execPath, [
			join(root, "scripts/release.mjs"), "--output", output, "--build-id", "replacement",
		], { cwd: root, env, encoding: "utf8", timeout: 15000 });
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
		{ output: join(home, ".local/share/pi-Serraly/releases/0.1.0"), buildId: "0.1.0", packages: [] });
	assert.deepEqual(releaseTarget(["--build-id", "1.2.3"], { version: "0.1.0", home }),
		{ output: join(home, ".local/share/pi-Serraly/releases/1.2.3"), buildId: "1.2.3", packages: [] });
	assert.deepEqual(releaseTarget(["--output", "relative/out"], { version: "0.1.0", home }),
		{ output: resolve("relative/out"), buildId: "0.1.0", packages: [] });
	assert.deepEqual(releaseTarget(["--output", join(home, "elsewhere"), "--build-id", "2.0.0"], { version: "0.1.0", home }),
		{ output: join(home, "elsewhere"), buildId: "2.0.0", packages: [] });
	assert.deepEqual(releaseTarget(["--package", "pi-ui", "--package", "pi-loop"], { version: "0.1.0", home }),
		{ output: join(home, ".local/share/pi-Serraly/releases/0.1.0"), buildId: "0.1.0", packages: ["pi-ui", "pi-loop"] });
	assert.throws(() => releaseTarget(["--nope"], { version: "0.1.0", home }), /Usage/);
	assert.throws(() => releaseTarget(["--build-id"], { version: "0.1.0", home }), /Usage/);
});
