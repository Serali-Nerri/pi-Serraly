import assert from "node:assert/strict";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { buildOrder, discoverPackages, selectExtensions } from "../../scripts/lib/packages.mjs";
import { workspaceFixture } from "./helpers/workspace.mjs";

/** A valid extension manifest; `undefined` overrides delete the field under test. */
function extensionManifest(overrides = {}) {
	const manifest = {
		name: "pi-ui", version: "0.2.0", private: true, type: "module",
		files: ["dist/"], engines: { node: ">=22.19.0" },
		peerDependencies: { "@earendil-works/pi-coding-agent": "*" },
		devDependencies: {},
		pi: { extensions: ["./dist/index.js"] },
		serraly: { build: { kind: "bundle", entry: "./src/index.ts" }, licenses: ["LICENSE"] },
	};
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) delete manifest[key];
		else manifest[key] = value;
	}
	return manifest;
}

function libraryManifest(overrides = {}) {
	const manifest = {
		name: "pi-ui-kit", version: "0.1.0", private: true, type: "module",
		files: ["dist/"], engines: { node: ">=22.19.0" },
		exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
		devDependencies: {},
		serraly: { build: { kind: "tsc", project: "./tsconfig.build.json" }, licenses: ["LICENSE"] },
	};
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) delete manifest[key];
		else manifest[key] = value;
	}
	return manifest;
}

const license = { "LICENSE": "MIT\n" };
const uiKit = { directory: "packages/pi-ui-kit", manifest: libraryManifest(), files: license };
const loop = { directory: "extensions/pi-loop", manifest: extensionManifest({ name: "pi-loop" }), files: license };
const ui = (overrides = {}) => ({ directory: "extensions/pi-ui", manifest: extensionManifest(overrides), files: license });

test("discovery reads the real workspace layout and keeps a stable order", async (t) => {
	const { root } = await workspaceFixture(t, [ui({ devDependencies: { "pi-ui-kit": "0.1.0" } }), loop, uiKit]);
	const packages = await discoverPackages(root);
	assert.deepEqual(packages.map((pkg) => pkg.name), ["pi-loop", "pi-ui", "pi-ui-kit"]);
	assert.deepEqual(packages.map((pkg) => pkg.kind), ["extension", "extension", "library"]);
	const found = packages.find((pkg) => pkg.name === "pi-ui");
	assert.equal(found.relativeDirectory, "extensions/pi-ui");
	assert.equal(found.directory, join(root, "extensions/pi-ui"));
});

test("unmatched workspace globs are empty, not an error", async (t) => {
	const { root } = await workspaceFixture(t, [uiKit]);
	assert.deepEqual((await discoverPackages(root)).map((pkg) => pkg.name), ["pi-ui-kit"]);
});

test("build order places internal dependencies first and keeps independent packages stable", async (t) => {
	const { root } = await workspaceFixture(t, [ui({ devDependencies: { "pi-ui-kit": "0.1.0" } }), loop, uiKit]);
	const packages = await discoverPackages(root);
	assert.deepEqual(buildOrder(packages, ["pi-ui"]).map((pkg) => pkg.name), ["pi-ui-kit", "pi-ui"]);
	assert.deepEqual(buildOrder(packages).map((pkg) => pkg.name), ["pi-loop", "pi-ui-kit", "pi-ui"]);
	assert.throws(() => buildOrder(packages, ["pi-loop", "pi-loop"]), /duplicate/i);
	assert.throws(() => buildOrder(packages, ["pi-missing"]), /unknown/i);
});

test("release selection takes extensions only and rejects library, unknown or duplicate names", async (t) => {
	const { root } = await workspaceFixture(t, [ui({ devDependencies: { "pi-ui-kit": "0.1.0" } }), loop, uiKit]);
	const packages = await discoverPackages(root);
	assert.deepEqual(selectExtensions(packages).map((pkg) => pkg.name), ["pi-loop", "pi-ui"]);
	assert.deepEqual(selectExtensions(packages, ["pi-ui"]).map((pkg) => pkg.name), ["pi-ui"]);
	assert.throws(() => selectExtensions(packages, ["pi-ui-kit"]), /library/i);
	assert.throws(() => selectExtensions(packages, ["pi-ui", "pi-ui"]), /duplicate/i);
	assert.throws(() => selectExtensions(packages, ["pi-unknown"]), /unknown/i);
	assert.throws(() => selectExtensions(packages, [""]), /non-empty/i);
});

for (const [label, definition, pattern, extras = [uiKit]] of [
	["an undeclared internal dependency", ui({ devDependencies: { "pi-ui-kit": "0.1.0" } }), /not part of the workspace/i, []],
	["a mismatched internal version", ui({ devDependencies: { "pi-ui-kit": "9.9.9" } }), /exact version/i],
	["a cross-extension dependency", ui({ devDependencies: { "pi-loop": "0.2.0" } }), /extension cannot depend on extension/i, [loop, uiKit]],
	["an installable runtime dependency", ui({ dependencies: { diff: "8.0.4" } }), /runtime dependencies/i],
	["a bundled library declared as a peer", ui({ peerDependencies: { "pi-ui-kit": "*" } }), /devDependency/i],
	["an escaping extension entry", ui({ pi: { extensions: ["./dist/../outside.js"] } }), /entry/i],
	["an absolute extension entry", ui({ pi: { extensions: ["/dist/index.js"] } }), /entry/i],
	["a missing build recipe", ui({ serraly: undefined }), /serraly/i],
	["a non-array license list", ui({ serraly: { build: { kind: "bundle", entry: "./src/index.ts" }, licenses: "LICENSE" } }), /serraly\.licenses/i],
	["an unknown build recipe", ui({ serraly: { build: { kind: "wat" }, licenses: ["LICENSE"] } }), /build recipe/i],
	["a non-private package", ui({ private: false }), /private/i],
	["a missing dist allowlist entry", ui({ files: ["README.md"] }), /files/i],
	["a missing Pi entry", ui({ pi: {} }), /pi\.extensions/i],
	["a bundled leaf without an output", ui({ devDependencies: { "pi-ui-kit": "0.1.0" }, serraly: { build: { kind: "script", script: "./scripts/build.mjs", bundles: { "src/ui/cards.ts": "dist/src/ui/cards.js" } }, licenses: ["LICENSE"] } }), /must declare its output/i],
	["a bundled leaf without packages", ui({ devDependencies: { "pi-ui-kit": "0.1.0" }, serraly: { build: { kind: "script", script: "./scripts/build.mjs", bundles: { "src/ui/cards.ts": { output: "dist/src/ui/cards.js" } } }, licenses: ["LICENSE"] } }), /bundled packages/i],
	["a bundled leaf with an unknown package", ui({ serraly: { build: { kind: "script", script: "./scripts/build.mjs", bundles: { "src/ui/cards.ts": { output: "dist/src/ui/cards.js", packages: ["pi-missing-kit"] } } }, licenses: ["LICENSE"] } }), /devDependency/i],
	["a bundled leaf with a non-workspace package", ui({ serraly: { build: { kind: "script", script: "./scripts/build.mjs", bundles: { "src/ui/cards.ts": { output: "dist/src/ui/cards.js", packages: ["esbuild"] } } }, licenses: ["LICENSE"] } }), /non-workspace/i],
	["a bundled leaf escaping the package", ui({ devDependencies: { "pi-ui-kit": "0.1.0" }, serraly: { build: { kind: "script", script: "./scripts/build.mjs", bundles: { "src/ui/cards.ts": { output: "../outside.js", packages: ["pi-ui-kit"] } } }, licenses: ["LICENSE"] } }), /escapes the package/i],
]) {
	test(`discovery rejects ${label}`, async (t) => {
		const { root } = await workspaceFixture(t, [definition, ...extras]);
		await assert.rejects(discoverPackages(root), pattern);
	});
}

test("discovery accepts absent inherited license texts", async (t) => {
	const { root } = await workspaceFixture(t, [ui({ serraly: { build: { kind: "bundle", entry: "./src/index.ts" } } })]);
	const packages = await discoverPackages(root);
	assert.equal(packages[0]?.manifest.serraly.licenses, undefined);
});

test("discovery rejects duplicate package names", async (t) => {
	const { root } = await workspaceFixture(t, [
		ui(),
		{ directory: "packages/pi-ui", manifest: libraryManifest({ name: "pi-ui" }), files: license },
	]);
	await assert.rejects(discoverPackages(root), /duplicate package name/i);
});

test("discovery keeps libraries independent of other workspace packages", async (t) => {
	const { root } = await workspaceFixture(t, [
		{ directory: "packages/pi-ui-kit", manifest: libraryManifest({ devDependencies: { "pi-config-core": "0.1.0" } }), files: license },
		{ directory: "packages/pi-config-core", manifest: libraryManifest({ name: "pi-config-core" }), files: license },
	]);
	await assert.rejects(discoverPackages(root), /library cannot depend on the workspace package/i);
});

test("discovery rejects a symlinked workspace package", async (t) => {
	const { root } = await workspaceFixture(t, [uiKit]);
	await mkdir(join(root, "extensions"), { recursive: true });
	await symlink(join(root, "packages/pi-ui-kit"), join(root, "extensions/pi-ui"), "dir");
	await assert.rejects(discoverPackages(root), /real directory|symlink/i);
});

test("discovery rejects an unsupported workspace pattern instead of guessing", async (t) => {
	const { root } = await workspaceFixture(t, [uiKit], { workspaces: ["modules/*"] });
	await assert.rejects(discoverPackages(root), /unsupported workspace pattern/i);
});
