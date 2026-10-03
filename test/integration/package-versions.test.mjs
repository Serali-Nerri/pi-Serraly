import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { checkPackageVersions, compareVersions } from "../../scripts/check-package-versions.mjs";
import { discoverPackages, selectExtensions } from "../../scripts/lib/packages.mjs";

/** A real Git repository so the gate is exercised against actual trees. */
async function gitFixture(t) {
	const base = await mkdtemp(join(tmpdir(), "serraly-versions-"));
	t.after(async () => { await rm(base, { recursive: true, force: true }); });
	const git = (...args) => execFileSync("git", args, { cwd: base, encoding: "utf8" });
	git("init", "-q");
	git("config", "user.email", "fixture@example.invalid");
	git("config", "user.name", "Fixture");
	git("config", "commit.gpgsign", "false");
	const write = async (path, contents) => {
		await mkdir(dirname(join(base, path)), { recursive: true });
		await writeFile(join(base, path), contents);
	};
	const commit = async (message) => {
		git("add", "-A");
		git("commit", "-q", "-m", message);
		return git("rev-parse", "HEAD").trim();
	};
	return { base, git, write, commit };
}

const manifest = (name, version, extra = {}) => JSON.stringify({
	name, version, private: true, type: "module", files: ["dist/"], engines: { node: ">=22.19.0" },
	pi: { extensions: ["./dist/index.js"] },
	serraly: { build: { kind: "bundle", entry: "./src/index.ts" }, licenses: ["LICENSE"], test: { directory: "test" } },
	...extra,
}, null, 2) + "\n";

async function firstCommit(fixture) {
	await fixture.write("package.json", JSON.stringify({ name: "fixture-root", private: true, workspaces: ["extensions/*", "packages/*"] }, null, 2) + "\n");
	await fixture.write("extensions/pi-alpha/package.json", manifest("pi-alpha", "1.0.0"));
	await fixture.write("extensions/pi-alpha/src/index.ts", "export const answer = 1;\n");
	await fixture.write("extensions/pi-alpha/test/alpha.test.ts", "// alpha test\n");
	await fixture.write("extensions/pi-alpha/LICENSE", "MIT\n");
	await fixture.write("packages/pi-alpha-kit/package.json", JSON.stringify({
		name: "pi-alpha-kit", version: "1.0.0", private: true, type: "module", files: ["dist/"], engines: { node: ">=22.19.0" },
		exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
		serraly: { build: { kind: "tsc", project: "./tsconfig.build.json" }, licenses: ["LICENSE"] },
	}, null, 2) + "\n");
	await fixture.write("packages/pi-alpha-kit/src/index.ts", "export const kit = 1;\n");
	await fixture.write("packages/pi-alpha-kit/LICENSE", "MIT\n");
	return fixture.commit("baseline");
}

test("a changed release surface needs a higher version", async (t) => {
	const fixture = await gitFixture(t);
	const baseline = await firstCommit(fixture);
	await fixture.write("extensions/pi-alpha/src/index.ts", "export const answer = 2;\n");
	const unchanged = await fixture.commit("change source without a bump");
	let offenders = await checkPackageVersions({ root: fixture.base, base: baseline, head: unchanged });
	assert.deepEqual(offenders.map((offender) => offender.name), ["pi-alpha"]);
	assert.match(offenders[0].reason, /release surface changed/);

	await fixture.write("extensions/pi-alpha/package.json", manifest("pi-alpha", "1.0.1"));
	const bumped = await fixture.commit("bump patch");
	offenders = await checkPackageVersions({ root: fixture.base, base: baseline, head: bumped });
	assert.deepEqual(offenders, []);

	await fixture.write("extensions/pi-alpha/package.json", manifest("pi-alpha", "1.0.0"));
	const regressed = await fixture.commit("regress the version");
	offenders = await checkPackageVersions({ root: fixture.base, base: bumped, head: regressed });
	assert.deepEqual(offenders.map((offender) => offender.name), ["pi-alpha"]);
});

test("test-only and root-only changes do not require a package bump", async (t) => {
	const fixture = await gitFixture(t);
	const baseline = await firstCommit(fixture);
	await fixture.write("extensions/pi-alpha/test/alpha.test.ts", "// updated alpha test\n");
	await fixture.write("README.md", "# fixture root\n");
	await fixture.write("scripts/tooling.mjs", "export const tooling = 1;\n");
	const changed = await fixture.commit("test and root-only changes");
	assert.deepEqual(await checkPackageVersions({ root: fixture.base, base: baseline, head: changed }), []);
});

test("a moved package directory keeps its identity and baseline version", async (t) => {
	const fixture = await gitFixture(t);
	const baseline = await firstCommit(fixture);
	const moved = JSON.parse(await readFile(join(fixture.base, "extensions/pi-alpha/package.json"), "utf8"));
	await fixture.write("extensions/pi-beta/package.json", JSON.stringify(moved, null, 2) + "\n");
	await fixture.write("extensions/pi-beta/src/index.ts", "export const answer = 3;\n");
	await fixture.write("extensions/pi-beta/LICENSE", "MIT\n");
	await fixture.write("extensions/pi-beta/test/alpha.test.ts", "// alpha test\n");
	await rm(join(fixture.base, "extensions/pi-alpha"), { recursive: true, force: true });
	const head = await fixture.commit("move the package without a bump");
	const offenders = await checkPackageVersions({ root: fixture.base, base: baseline, head });
	assert.deepEqual(offenders.map((offender) => offender.name), ["pi-alpha"]);
	assert.match(offenders[0].reason, /baseline 1\.0\.0/);
});

async function libraryBump(fixture, consumerVersion, libraryVersion) {
	await fixture.write("extensions/pi-alpha/package.json",
		manifest("pi-alpha", consumerVersion, { devDependencies: { "pi-alpha-kit": libraryVersion } }));
	await fixture.write("packages/pi-alpha-kit/package.json", JSON.stringify({
		name: "pi-alpha-kit", version: libraryVersion, private: true, type: "module", files: ["dist/"], engines: { node: ">=22.19.0" },
		exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
		serraly: { build: { kind: "tsc", project: "./tsconfig.build.json" }, licenses: ["LICENSE"] },
	}, null, 2) + "\n");
	await fixture.write("packages/pi-alpha-kit/src/index.ts", `export const kit = ${libraryVersion};\n`);
}

test("a bundled library bump needs its consumer to move too", async (t) => {
	const fixture = await gitFixture(t);
	const baseline = await firstCommit(fixture);
	await libraryBump(fixture, "1.0.0", "1.1.0");
	const offenders = await checkPackageVersions({ root: fixture.base, base: baseline,
		head: await fixture.commit("bump only the library") });
	assert.deepEqual(offenders.map((offender) => offender.name), ["pi-alpha"]);
	assert.match(offenders[0].reason, /bundled library pi-alpha-kit/);
});

test("moving the library and its consumer together is accepted", async (t) => {
	const fixture = await gitFixture(t);
	const baseline = await firstCommit(fixture);
	await libraryBump(fixture, "1.0.1", "1.1.0");
	assert.deepEqual(await checkPackageVersions({ root: fixture.base, base: baseline,
		head: await fixture.commit("bump the library and the consumer") }), []);
});

test("the working tree is compared when no head ref is given", async (t) => {
	const fixture = await gitFixture(t);
	const baseline = await firstCommit(fixture);
	await fixture.write("extensions/pi-alpha/src/index.ts", "export const answer = 9;\n");
	const offenders = await checkPackageVersions({ root: fixture.base, base: baseline });
	assert.deepEqual(offenders.map((offender) => offender.name), ["pi-alpha"]);
});

test("the current repository satisfies the gate against its own baseline shape", async () => {
	// The real workspace is only compared against itself here: identity must be
	// readable from the current tree without the legacy module layout.
	const packages = await discoverPackages();
	const extensions = selectExtensions(packages);
	assert.deepEqual(extensions.map((pkg) => pkg.manifest.version), extensions.map(() => "0.2.0"));
	for (const library of packages.filter((pkg) => pkg.kind === "library")) {
		assert.match(library.manifest.version, /^\d+\.\d+\.\d+$/, `${library.name} declares a readable version`);
	}
	assert.ok(compareVersions("0.2.0", "0.1.0") > 0);
	assert.ok(compareVersions("1.0.0", "1.0.1") < 0);
	assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
});
