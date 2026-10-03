import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { buildPackage, buildPackages, bundleEntry } from "../../scripts/lib/build-package.mjs";
import { copyPackageArtifact, packFiles, sealPackageArtifact, verifyPackageArtifact } from "../../scripts/lib/package-artifacts.mjs";
import { discoverPackages } from "../../scripts/lib/packages.mjs";
import { workspaceFixture } from "./helpers/workspace.mjs";

const libraryTsconfig = JSON.stringify({
	compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true, declaration: true, sourceMap: true },
	include: ["src"],
}, null, 2);

const library = (overrides = {}) => ({
	directory: "packages/pi-fixture-kit",
	manifest: {
		name: "pi-fixture-kit", version: "0.1.0", private: true, type: "module",
		files: ["dist/"], engines: { node: ">=22.19.0" },
		exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
		devDependencies: {},
		serraly: { build: { kind: "tsc", project: "./tsconfig.build.json" }, licenses: ["LICENSE"] },
		...overrides,
	},
	files: { "LICENSE": "MIT fixture\n", "tsconfig.build.json": libraryTsconfig, "src/index.ts": "export const answer = 42;\n" },
});

const extension = (overrides = {}) => ({
	directory: "extensions/pi-fixture",
	manifest: {
		name: "pi-fixture", version: "0.2.0", private: true, type: "module",
		files: ["dist/"], engines: { node: ">=22.19.0" },
		peerDependencies: { "@earendil-works/pi-coding-agent": "*" },
		devDependencies: { "pi-fixture-kit": "0.1.0" },
		pi: { extensions: ["./dist/index.js"] },
		serraly: { build: { kind: "bundle", entry: "./src/index.ts" }, licenses: ["LICENSE"] },
		...overrides,
	},
	files: { "LICENSE": "MIT fixture\n", "src/index.ts": 'import { answer } from "pi-fixture-kit";\nexport default () => answer;\n' },
});

/** Discover a synthetic workspace and link its library the way npm install would. */
async function workspace(t, definitions, { link = ["pi-fixture-kit"] } = {}) {
	const { root } = await workspaceFixture(t, definitions);
	await mkdir(join(root, "node_modules"), { recursive: true });
	for (const name of link) {
		const source = join(root, "packages", name);
		await symlink(source, join(root, "node_modules", name), "dir");
	}
	const packages = await discoverPackages(root);
	return { root, packages, byName: new Map(packages.map((pkg) => [pkg.name, pkg])) };
}

async function importDefault(entry) {
	return (await import(`${pathToFileURL(entry).href}?${Date.now()}`)).default;
}

test("builds a bundled extension with its internal library and runs the sealed copy", { timeout: 120000 }, async (t) => {
	const { packages, byName } = await workspace(t, [library(), extension()]);
	assert.deepEqual(await buildPackages(packages, ["pi-fixture"]), ["pi-fixture-kit", "pi-fixture"]);
	const extensionPackage = byName.get("pi-fixture");
	const built = await importDefault(join(extensionPackage.directory, "dist/index.js"));
	assert.equal(built(), 42);
	const payload = await packFiles(extensionPackage.directory);
	assert.ok(payload.includes("dist/licenses/pi-fixture-kit/LICENSE"), "a bundled library ships its own license text");
	assert.ok(payload.includes("dist/artifacts.json"));
	const target = join(await mkdtemp(join(tmpdir(), "serraly-copy-")), "pi-fixture");
	t.after(async () => { await rm(join(target, ".."), { recursive: true, force: true }); });
	await copyPackageArtifact(extensionPackage, target);
	assert.equal((await importDefault(join(target, "dist/index.js")))(), 42, "the copied artifact runs outside the workspace");
	assert.equal(await readFile(join(target, "dist/index.js"), "utf8").then((text) => text.includes("42")), true,
		"the library is bundled instead of left as a runtime import");
});

test("verification rejects a missing payload file", { timeout: 120000 }, async (t) => {
	const { packages, byName } = await workspace(t, [library(), extension()]);
	await buildPackages(packages, ["pi-fixture"]);
	const target = await mkdtemp(join(tmpdir(), "serraly-missing-file-"));
	t.after(async () => { await rm(target, { recursive: true, force: true }); });
	const copy = join(target, "pi-fixture");
	await copyPackageArtifact(byName.get("pi-fixture"), copy);
	await rm(join(copy, "dist/licenses/pi-fixture-kit/LICENSE"));
	await assert.rejects(verifyPackageArtifact(copy), /licenses\/pi-fixture-kit\/LICENSE/);
});

test("verification rejects a changed manifest version", { timeout: 120000 }, async (t) => {
	const { packages, byName } = await workspace(t, [library(), extension()]);
	await buildPackages(packages, ["pi-fixture"]);
	const copy = join(await mkdtemp(join(tmpdir(), "serraly-identity-")), "pi-fixture");
	t.after(async () => { await rm(join(copy, ".."), { recursive: true, force: true }); });
	await copyPackageArtifact(byName.get("pi-fixture"), copy);
	const manifest = JSON.parse(await readFile(join(copy, "package.json"), "utf8"));
	manifest.version = "9.9.9";
	await writeFile(join(copy, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
	await assert.rejects(verifyPackageArtifact(copy), /identity mismatch/);
});

for (const [label, mutate, pattern, reseal = false] of [
	["an extra file", async (copy) => { await writeFile(join(copy, "dist/extra.js"), "export default 1;\n"); }, /extra\.js/],
	["a symlinked payload file", async (copy, base) => {
		const external = join(base, "outside.js");
		await writeFile(external, "export default 1;\n");
		await symlink(external, join(copy, "dist/linked.js"));
	}, /symlink/i],
	// A tampered payload can be re-sealed; the executable closure must still refuse it.
	["a re-sealed encoded escape import", async (copy, base) => {
		await writeFile(join(base, "outside.js"), "export default 1;\n");
		await writeFile(join(copy, "dist/index.js"), 'export { default } from "./%2e%2e/%2e%2e/outside.js";\n');
	}, /specifier|closure|outside/i, true],
]) {
	test(`verification rejects ${label}`, { timeout: 120000 }, async (t) => {
		const { packages, byName } = await workspace(t, [library(), extension()]);
		await buildPackages(packages, ["pi-fixture"]);
		const base = await mkdtemp(join(tmpdir(), "serraly-reject-"));
		t.after(async () => { await rm(base, { recursive: true, force: true }); });
		const pkg = byName.get("pi-fixture");
		const copy = join(base, "pi-fixture");
		await copyPackageArtifact(pkg, copy);
		await mutate(copy, base);
		if (reseal) await sealPackageArtifact({ name: pkg.name, directory: copy, manifest: pkg.manifest });
		await assert.rejects(verifyPackageArtifact(copy), pattern);
	});
}

test("a failed rebuild keeps the previous complete artifact and leaves no residue", { timeout: 120000 }, async (t) => {
	const { packages, byName } = await workspace(t, [library(), extension()]);
	await buildPackages(packages, ["pi-fixture"]);
	const extensionPackage = byName.get("pi-fixture");
	assert.equal((await importDefault(join(extensionPackage.directory, "dist/index.js")))(), 42);
	await writeFile(join(extensionPackage.directory, "src/index.ts"), "export default () => {\n");
	await assert.rejects(buildPackage(extensionPackage));
	assert.equal((await importDefault(join(extensionPackage.directory, "dist/index.js")))(), 42, "the previous dist survives a failed rebuild");
	assert.deepEqual((await readdir(extensionPackage.directory)).filter((name) => name.startsWith(".build-")), []);
});

test("bundling refuses sibling extension sources, private library sources and deep library imports", { timeout: 120000 }, async (t) => {
	const sibling = { directory: "extensions/pi-fixture-other", manifest: { ...extension().manifest, name: "pi-fixture-other" }, files: { "LICENSE": "MIT fixture\n", "src/index.ts": "export default 1;\n" } };
	const deepExports = library({ exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }, "./src/*": "./src/*" } });
	const { packages, byName } = await workspace(t, [deepExports, extension(), sibling]);
	await buildPackages(packages, ["pi-fixture-kit"]);
	const extensionPackage = byName.get("pi-fixture");
	const entry = join(extensionPackage.directory, "src/index.ts");
	await writeFile(entry, 'export { default } from "../../pi-fixture-other/src/index.ts";\n');
	await assert.rejects(buildPackage(extensionPackage), /outside the package/);
	await writeFile(entry, 'export { answer } from "../../../packages/pi-fixture-kit/src/index.ts";\n');
	await assert.rejects(buildPackage(extensionPackage), /outside the package|private source/);
	await writeFile(entry, 'export { answer } from "pi-fixture-kit/src/index.ts";\n');
	await assert.rejects(buildPackage(extensionPackage), /private source/);
});

test("bundleEntry refuses a host package that is not a declared peer", { timeout: 120000 }, async (t) => {
	const { packages, byName, root } = await workspace(t, [library(), extension()]);
	await buildPackages(packages, ["pi-fixture-kit"]);
	const host = join(root, "node_modules/@earendil-works/pi-agent-core");
	await mkdir(host, { recursive: true });
	await writeFile(join(host, "package.json"), '{"name":"@earendil-works/pi-agent-core","version":"1.0.0","type":"module","exports":{".":"./index.js"}}\n');
	await writeFile(join(host, "index.js"), "export const host = true;\n");
	const extensionPackage = byName.get("pi-fixture");
	const entry = join(extensionPackage.directory, "src/index.ts");
	await writeFile(entry, 'import { host } from "@earendil-works/pi-agent-core";\nexport default () => host;\n');
	await assert.rejects(bundleEntry(extensionPackage, { entry, outfile: join(extensionPackage.directory, "probe.js") }),
		/bundled host package|Could not resolve/);
	assert.equal(await lstat(entry).then(() => true), true);
});
