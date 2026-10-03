import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { isolatedEnvironment } from "../../scripts/lib/environment.mjs";
import { createRelease, validateRelease } from "../../scripts/lib/package.mjs";

const root = resolve(import.meta.dirname, "../..");
const base = await mkdtemp(join(tmpdir(), "serraly-selected-release-"));
const env = isolatedEnvironment(base);
await mkdir(env.HOME, { recursive: true });
process.on("exit", () => { void rm(base, { recursive: true, force: true }); });

const present = async (path) => {
	try { await lstat(path); return true; }
	catch (error) { if (error.code === "ENOENT") return false; throw error; }
};

async function release(name, packages) {
	const output = join(base, name);
	await createRelease(output, { buildId: name, packages });
	await validateRelease(output);
	return { output, manifest: JSON.parse(await readFile(join(output, "package.json"), "utf8")),
		record: JSON.parse(await readFile(join(output, "release.json"), "utf8")) };
}

test("a subset release declares and ships exactly the selected members", { timeout: 300000 }, async () => {
	const selected = await release("ui-only", ["pi-ui"]);
	assert.deepEqual(selected.manifest.pi.extensions, ["./extensions/pi-ui/dist/index.js"]);
	assert.deepEqual(Object.keys(selected.record.packages), ["pi-ui"]);
	assert.equal(await present(join(selected.output, "extensions/pi-ui")), true);
	for (const absent of ["pi-background-shell", "pi-subagents", "pi-tools"]) {
		assert.equal(await present(join(selected.output, "extensions", absent)), false, absent);
	}
	// The aggregate peer union still describes the host contract of the selection.
	assert.deepEqual(Object.keys(selected.manifest.peerDependencies).sort(),
		["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]);

	const background = await release("background-only", ["pi-background-shell"]);
	assert.deepEqual(background.manifest.pi.extensions, ["./extensions/pi-background-shell/dist/extensions/background-tasks.js"]);
	assert.deepEqual(Object.keys(background.record.packages), ["pi-background-shell"]);

	const pair = await release("questions-subagents", ["pi-ask-user-question", "pi-subagents"]);
	assert.deepEqual(pair.manifest.pi.extensions, [
		"./extensions/pi-ask-user-question/dist/index.js",
		"./extensions/pi-subagents/dist/index.js",
	]);
	assert.deepEqual(Object.keys(pair.record.packages), ["pi-ask-user-question", "pi-subagents"]);
});

test("invalid selections fail before any target, staging or build side effect", { timeout: 120000 }, async () => {
	for (const [label, packages, pattern] of [
		["an unknown package", ["pi-nope"], /unknown package/i],
		["a duplicate package", ["pi-ui", "pi-ui"], /duplicate package selection/i],
		["a library", ["pi-ui-kit"], /unknown package|library/i],
		["an empty name", [""], /non-empty/i],
	]) {
		const output = join(base, `invalid-${label.replaceAll(" ", "-")}`);
		await assert.rejects(createRelease(output, { packages }), pattern, label);
		assert.equal(await present(output), false, `${label}: no target was created`);
		assert.deepEqual((await import("node:fs/promises").then(({ readdir }) => readdir(base)))
			.filter((entry) => entry.startsWith(".serraly-pending-")), [], `${label}: no staging remained`);
	}
});

test("a release that still declares runtime dependencies is never shipped", { timeout: 300000 }, async () => {
	const fixture = await release("dependency-fixture", ["pi-loop"]);
	const manifest = JSON.parse(await readFile(join(fixture.output, "package.json"), "utf8"));
	manifest.dependencies = { "foreign-package": "1.0.0" };
	await writeFile(join(fixture.output, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
	await assert.rejects(validateRelease(fixture.output), /runtime-only|dependenc/i);
	const candidate = join(base, "dependency-member");
	await cp(fixture.output, candidate, { recursive: true });
	const member = JSON.parse(await readFile(join(candidate, "extensions/pi-loop/package.json"), "utf8"));
	member.dependencies = { "foreign-package": "1.0.0" };
	await writeFile(join(candidate, "extensions/pi-loop/package.json"), JSON.stringify(member, null, 2) + "\n");
	await assert.rejects(validateRelease(candidate), /integrity mismatch|identity mismatch|installable/i);
});

test("the release CLI reports the selected members without touching settings", { timeout: 300000 }, async () => {
	const output = join(base, "cli-selection");
	const result = spawnSync(process.execPath, [join(root, "scripts/release.mjs"),
		"--output", output, "--build-id", "cli-selection", "--package", "pi-loop", "--package", "pi-tools"],
	{ cwd: root, env, encoding: "utf8", timeout: 290000 });
	assert.equal(result.status, 0, result.stderr || result.stdout);
	const manifest = JSON.parse(await readFile(join(output, "package.json"), "utf8"));
	assert.deepEqual(manifest.pi.extensions, ["./extensions/pi-loop/dist/index.js", "./extensions/pi-tools/dist/index.js"]);
	const rejected = spawnSync(process.execPath, [join(root, "scripts/release.mjs"), "--output", join(base, "cli-invalid"), "--package", "pi-nope"],
		{ cwd: root, env, encoding: "utf8", timeout: 60000 });
	assert.notEqual(rejected.status, 0);
	assert.match(rejected.stderr, /unknown package/i);
	assert.equal(await present(join(base, "cli-invalid")), false);
});
