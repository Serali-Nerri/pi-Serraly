import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createRelease } from "../../scripts/lib/release.mjs";
import { releaseTarget } from "../../scripts/release.mjs";

const execFileAsync = promisify(execFile);
const repository = resolve(import.meta.dirname, "../..");
const cli = join(repository, "scripts/release.mjs");
const emptyPi = { extensions: [], skills: [], prompts: [], themes: [] };
const peers = { "@earendil-works/pi-coding-agent": "*", typebox: "*" };

const exists = async (path) => {
	try { await lstat(path); return true; }
	catch (error) { if (error.code === "ENOENT") return false; throw error; }
};

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const writeJson = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

async function run(command, args, { cwd, env, timeout = 120_000 } = {}) {
	try {
		return await execFileAsync(command, args, { cwd, env, encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024 });
	} catch (error) {
		throw new Error(`${command} ${args.join(" ")} failed: ${error.stderr || error.stdout || error.message}`, { cause: error });
	}
}

async function isolatedEnvironment(base, extra = {}) {
	const home = join(base, "home");
	const tmp = join(base, "tmp");
	await mkdir(home, { recursive: true });
	await mkdir(tmp, { recursive: true });
	const environment = {
		PATH: process.env.PATH,
		HOME: home,
		TMPDIR: tmp,
		LANG: "C.UTF-8",
		BUN_INSTALL_CACHE_DIR: join(base, "bun-cache"),
		...extra,
	};
	for (const key of ["NODE_OPTIONS", "PI_SERRALY_NETWORK_LOG"]) {
		if (process.env[key]) environment[key] = process.env[key];
	}
	return environment;
}

const specifications = [
	{ slug: "p-a" },
	{ slug: "p-b", dependencies: { "@fx/p-a": "1.0.0" }, bin: { "fx-p-b-worker": "./worker.mjs" } },
	{ slug: "p-c", dependencies: { "@fx/p-prod": "1.0.0", "@fx/p-e": "1.0.0" }, devDependencies: { "@fx/p-c-dev": "1.0.0" } },
	{ slug: "p-prod" },
	{ slug: "p-c-dev" },
	{ slug: "p-d" },
	{ slug: "p-e", peerDependencies: { "@fx/p-c": "1.0.0" }, peerDependenciesMeta: { "@fx/p-c": { optional: true } } },
	{ slug: "p-f" },
];

async function makeFixture(base) {
	const source = join(base, "source");
	const marker = join(base, "prepack-ran");
	for (const specification of specifications) {
		const directory = join(source, "packages", specification.slug);
		await mkdir(join(directory, "resources"), { recursive: true });
		await writeJson(join(directory, "package.json"), {
			name: `@fx/${specification.slug}`,
			version: "1.0.0",
			type: "module",
			files: ["index.js", "resources/**", "LICENSE", ...(specification.bin ? ["worker.mjs"] : [])],
			bin: specification.bin,
			pi: { extensions: ["./index.js"] },
			peerDependencies: { ...peers, ...specification.peerDependencies },
			peerDependenciesMeta: specification.peerDependenciesMeta,
			dependencies: specification.dependencies ?? {},
			devDependencies: specification.devDependencies ?? {},
			scripts: { prepack: "node prepack.mjs", postpack: "node prepack.mjs" },
		});
		await writeFile(join(directory, "index.js"), `export default ${JSON.stringify(specification.slug)};\n`);
		if (specification.bin) {
			await writeFile(join(directory, "worker.mjs"),
				`#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`${specification.slug}-worker`)} + "\\n");\n`,
				{ mode: 0o755 });
		}
		await writeFile(join(directory, "resources/runtime.json"), `${JSON.stringify({ member: specification.slug })}\n`);
		await writeFile(join(directory, "LICENSE"), "MIT\n");
		await writeFile(join(directory, "secret.txt"), "must not be packed\n");
		await writeFile(join(directory, "prepack.mjs"),
			`import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(specification.slug)} + "\\n");\n`);
	}
	await writeJson(join(source, "package.json"), {
		name: "fx-root",
		version: "0.4.0-preview.1",
		private: true,
		type: "module",
		workspaces: ["packages/*"],
		pi: emptyPi,
		dependencies: {},
		devDependencies: { "@fx/p-d": "1.0.0" },
	});
	const env = await isolatedEnvironment(base);
	await mkdir(env.BUN_INSTALL_CACHE_DIR, { recursive: true });
	await run("bun", ["install", "--lockfile-only", "--offline", "--omit", "peer", "--ignore-scripts"], { cwd: source, env });
	return { source, marker, env };
}

async function collectLinks(directory) {
	const links = [];
	const walk = async (current) => {
		for (const entry of await readdir(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			const stats = await lstat(path);
			if (stats.isSymbolicLink()) {
				links.push({ path, link: await readlink(path), target: await realpath(path) });
			} else if (stats.isDirectory()) await walk(path);
		}
	};
	await walk(directory);
	return links;
}

async function installedPackageNames(directory) {
	const names = new Set();
	const walk = async (current) => {
		for (const entry of await readdir(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.name === "node_modules" && entry.isDirectory()) {
				for (const child of await readdir(path, { withFileTypes: true })) {
					if (child.name.startsWith("@") && child.isDirectory()) {
						for (const scoped of await readdir(join(path, child.name), { withFileTypes: true })) {
							if (scoped.isDirectory() || scoped.isSymbolicLink()) names.add(`${child.name}/${scoped.name}`);
						}
					} else if (child.isDirectory() || child.isSymbolicLink()) names.add(child.name);
				}
			}
			const stats = await lstat(path);
			if (stats.isDirectory()) await walk(path);
		}
	};
	await walk(directory);
	return names;
}

test("createRelease publishes one packed, production-only, relocatable offline release", { timeout: 180_000 }, async () => {
	const base = await mkdtemp(join(tmpdir(), "serraly-release-"));
	try {
		const { source, marker, env } = await makeFixture(base);
		const output = join(base, "releases", "0.4.0-preview.1");

		await assert.rejects(createRelease("relative/release", { root: source, env }), /absolute path/);
		await assert.rejects(createRelease(join(source, "release"), { root: source, env }), /outside the development tree/);
		assert.equal(await exists(join(base, "relative")), false);
		assert.equal(await exists(join(source, "release")), false);
		const existingEmpty = join(base, "releases", "existing-empty");
		await mkdir(existingEmpty, { recursive: true });
		await assert.rejects(createRelease(existingEmpty, { root: source, env }), /already exists/);
		assert.deepEqual(await readdir(existingEmpty), [], "an existing empty destination is never replaced");

		const result = await createRelease(output, { root: source, env });
		assert.equal(result.path, output);
		assert.equal(await exists(join(source, "node_modules")), false, "release installs only into its staged copy");
		assert.equal(await exists(marker), false, "release never runs prepack or build scripts");

		const sourceManifest = await readJson(join(source, "package.json"));
		const releaseManifest = await readJson(join(output, "package.json"));
		assert.deepEqual(releaseManifest, sourceManifest, "release keeps the full locked root manifest");
		assert.deepEqual(releaseManifest.pi, emptyPi);
		assert.deepEqual(releaseManifest.workspaces, ["packages/*"]);
		assert.deepEqual(releaseManifest.dependencies, {});
		assert.deepEqual(releaseManifest.devDependencies, { "@fx/p-d": "1.0.0" });
		assert.equal(await readFile(join(output, "bun.lock"), "utf8"), await readFile(join(source, "bun.lock"), "utf8"));

		const expectedMembers = Object.fromEntries(specifications.map(({ slug }) =>
			[`@fx/${slug}`, { version: "1.0.0", path: `packages/${slug}` }]));
		const record = await readJson(join(output, "release.json"));
		assert.deepEqual(record, { version: "0.4.0-preview.1", members: expectedMembers });
		assert.deepEqual(result.members, expectedMembers);

		for (const { slug } of specifications) {
			const directory = join(output, "packages", slug);
			assert.equal(await readFile(join(directory, "index.js"), "utf8"), `export default ${JSON.stringify(slug)};\n`);
			assert.deepEqual(await readJson(join(directory, "resources/runtime.json")), { member: slug });
			assert.equal(await readFile(join(directory, "LICENSE"), "utf8"), "MIT\n");
			assert.equal(await exists(join(directory, "secret.txt")), false, "files allowlist excludes secrets");
			assert.equal(await exists(join(directory, "prepack.mjs")), false, "scripts outside the allowlist are not packed");
		}

		const links = await collectLinks(output);
		const releaseReal = await realpath(output);
		for (const link of links) {
			assert.equal(isAbsolute(link.link), false, `relocatable relative link: ${link.path}`);
			assert.ok(link.target === releaseReal || link.target.startsWith(`${releaseReal}${sep}`), `link stays inside: ${link.path}`);
			assert.equal(link.target === source || link.target.startsWith(`${source}${sep}`), false, `link never reaches the development tree: ${link.path}`);
		}
		const localDependencies = new Set();
		for (const link of links.filter(({ path }) => path.includes(`${sep}node_modules${sep}`) && !path.includes(`${sep}.bin${sep}`))) {
			localDependencies.add((await readJson(join(link.target, "package.json"))).name);
		}
		assert.deepEqual([...localDependencies].sort(), ["@fx/p-a", "@fx/p-c", "@fx/p-e", "@fx/p-prod"],
			"runtime dependencies and supplied workspace peers remain importable");
		const installed = await installedPackageNames(output);
		for (const excluded of ["@fx/p-c-dev", "@fx/p-d", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
			assert.equal(installed.has(excluded), false, `${excluded} must not be installed`);
		}

		const releaseRecord = await readFile(join(output, "release.json"), "utf8");
		await assert.rejects(createRelease(output, { root: source, env }), /already exists/);
		assert.equal(await readFile(join(output, "release.json"), "utf8"), releaseRecord, "a live release is immutable");
		assert.deepEqual((await readdir(join(base, "releases"))).filter((name) => name.startsWith(".pi-serraly-release-")), []);

		const relocated = join(base, "relocated");
		await rename(output, relocated);
		const relocatedReal = await realpath(relocated);
		for (const link of await collectLinks(relocated)) {
			assert.equal(isAbsolute(link.link), false);
			assert.ok(link.target === relocatedReal || link.target.startsWith(`${relocatedReal}${sep}`), `relocated link: ${link.path}`);
			assert.equal(link.target === output || link.target.startsWith(`${output}${sep}`), false, "relocation rewires every link");
		}
		const imported = await run(process.execPath, [
			"--input-type=module", "-e", "import('@fx/p-a').then((module) => process.stdout.write(module.default))",
		], { cwd: join(relocated, "packages/p-b"), env, timeout: 30_000 });
		assert.equal(imported.stdout, "p-a", "the relocated production dependency graph is usable");
		const peer = await run(process.execPath, [
			"--input-type=module", "-e", "import('@fx/p-c').then((module) => process.stdout.write(module.default))",
		], { cwd: join(relocated, "packages/p-e"), env, timeout: 30_000 });
		assert.equal(peer.stdout, "p-c", "a supplied optional peer remains importable after relocation");

		const workerLink = join(relocated, "node_modules", ".bin", "fx-p-b-worker");
		const workerTarget = await realpath(workerLink);
		assert.equal(workerTarget, join(relocatedReal, "packages/p-b/worker.mjs"),
			"a declared member bin resolves to its packed payload after relocation");
		const worker = await run(process.execPath, [workerTarget], { cwd: join(relocated, "packages/p-b"), env, timeout: 30_000 });
		assert.equal(worker.stdout, "p-b-worker\n", "the relocated member bin remains executable");

		assert.equal(await exists(join(env.HOME, ".pi")), false, "release does not touch Pi settings");
		assert.equal(await exists(join(env.HOME, ".config/pi")), false, "release does not touch Pi config");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("concurrent publications cannot replace a reserved destination", { timeout: 180_000 }, async () => {
	const base = await mkdtemp(join(tmpdir(), "serraly-release-race-"));
	try {
		const { source, marker, env } = await makeFixture(base);
		const output = join(base, "releases", "0.4.0-preview.1");
		const outcomes = await Promise.allSettled([
			createRelease(output, { root: source, env }),
			createRelease(output, { root: source, env }),
		]);
		const successes = outcomes.filter((outcome) => outcome.status === "fulfilled");
		const failures = outcomes.filter((outcome) => outcome.status === "rejected");
		assert.equal(successes.length, 1, "exactly one concurrent publication wins");
		assert.equal(failures.length, 1, "the other publication is rejected");
		assert.match(failures[0].reason.message, /already exists|immutable/);
		assert.equal((await readJson(join(output, "release.json"))).version, "0.4.0-preview.1");
		assert.equal(await exists(marker), false);
		assert.deepEqual((await readdir(join(base, "releases"))).filter((name) => name.startsWith(".pi-serraly-release-")), []);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("the CLI defaults to the versioned user release path and rejects non-absolute or in-tree outputs", async () => {
	const base = await mkdtemp(join(tmpdir(), "serraly-release-cli-"));
	try {
		const source = join(base, "source");
		const home = join(base, "home");
		await mkdir(source, { recursive: true });
		await writeJson(join(source, "package.json"), { name: "fixture", version: "0.4.0-preview.1", private: true });
		assert.deepEqual(await releaseTarget([], { root: source, home }), {
			output: join(home, ".local/share/pi-Serraly/releases/0.4.0-preview.1"),
		});
		assert.deepEqual(await releaseTarget(["--output", join(base, "elsewhere")], { root: source, home }), {
			output: join(base, "elsewhere"),
		});
		await assert.rejects(releaseTarget(["--output", "relative"], { root: source, home }), /absolute path/);
		await assert.rejects(releaseTarget(["--nope"], { root: source, home }), /Usage/);
		await assert.rejects(releaseTarget(["--output"], { root: source, home }), /Usage/);

		const env = await isolatedEnvironment(base);
		const relative = spawnSync(process.execPath, [cli, "--output", "relative"], { cwd: repository, env, encoding: "utf8" });
		assert.notEqual(relative.status, 0);
		assert.match(relative.stderr, /absolute path/);
		const inside = spawnSync(process.execPath, [cli, "--output", join(repository, "release-should-not-exist")], {
			cwd: repository, env, encoding: "utf8",
		});
		assert.notEqual(inside.status, 0);
		assert.match(inside.stderr, /outside the development tree/);
		assert.equal(await exists(join(repository, "release-should-not-exist")), false);
		assert.equal(await exists(join(env.HOME, ".pi")), false);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});
