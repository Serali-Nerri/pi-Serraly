import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { testEnvironment } from "../../scripts/lib/environment.mjs";
import { sealPackageArtifact } from "../../scripts/lib/package-artifacts.mjs";
import { workspaceFixture } from "./helpers/workspace.mjs";

const project = resolve(import.meta.dirname, "../..");

async function workspace(t) {
	const definition = (name, body) => ({
		directory: `extensions/${name}`,
		manifest: {
			name, version: "0.1.0", private: true, type: "module",
			engines: { node: ">=22.19.0" }, files: ["dist/"],
			peerDependencies: { "@earendil-works/pi-coding-agent": "*" },
			pi: { extensions: ["./dist/index.js"] },
			serraly: {
				build: { kind: "script", script: "./build.mjs" },
				licenses: ["LICENSE"], test: { directory: "test" },
			},
		},
		files: {
			"LICENSE": "MIT fixture\n",
			"src/index.js": "export const answer = 42;\n",
			"build.mjs": 'throw new Error("Compiler unavailable in this fixture");\n',
			"test/behavior.test.mjs": body,
		},
	});
	const selected = definition("pi-fixture",
		'import test from "node:test"; import assert from "node:assert/strict";\n' +
		'import { answer } from "../src/index.js";\n' +
		'test("source behavior reached", () => assert.equal(answer, 42));\n');
	const unrelated = definition("pi-unrelated", 'throw new Error("Unselected suite must not run");\n');
	const { root } = await workspaceFixture(t, [selected, unrelated]);
	await cp(join(project, "scripts"), join(root, "scripts"), { recursive: true });
	// Development tools only; these links are never part of a runtime payload.
	await symlink(join(project, "node_modules"), join(root, "node_modules"), "dir");
	return { root, pkg: { name: selected.manifest.name, manifest: selected.manifest,
		directory: join(root, selected.directory) } };
}

test("selected source tests run without artifacts or an available compiler", { timeout: 30000 }, async (t) => {
	const { root } = await workspace(t);
	const result = spawnSync(process.execPath, ["scripts/test.mjs", "--package", "pi-fixture"], {
		cwd: root, env: testEnvironment(join(root, "isolated")), encoding: "utf8", timeout: 25000,
	});
	assert.equal(result.status, 0, result.stderr || result.stdout);
	assert.match(result.stdout, /source behavior reached/);
});

test("release assembly consumes sealed artifacts without invoking a compiler", { timeout: 30000 }, async (t) => {
	const { root, pkg } = await workspace(t);
	await mkdir(join(pkg.directory, "dist"));
	await writeFile(join(pkg.directory, "dist/index.js"), "export default () => 42;\n");
	await sealPackageArtifact(pkg);
	const { createRelease } = await import(pathToFileURL(join(root, "scripts/lib/package.mjs")).href);
	const output = join(dirname(root), `${root.split("/").at(-1)}-release`);
	t.after(() => rm(output, { recursive: true, force: true }));
	await createRelease(output, { packages: ["pi-fixture"] });
	const entry = join(output, "extensions/pi-fixture/dist/index.js");
	assert.equal((await import(pathToFileURL(entry).href)).default(), 42);

	const corrupted = "export default () => -1;\n";
	await writeFile(join(pkg.directory, "dist/index.js"), corrupted);
	await assert.rejects(createRelease(`${output}-rejected`, { packages: ["pi-fixture"] }), /integrity mismatch/);
	assert.equal(await readFile(join(pkg.directory, "dist/index.js"), "utf8"), corrupted,
		"assembly must report corruption, not repair it by rebuilding");
});
