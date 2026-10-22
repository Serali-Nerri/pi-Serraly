import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { isolatedEnvironment } from "../../scripts/lib/environment.mjs";
import { npmCliPath } from "../../scripts/lib/package-artifacts.mjs";
import { names, toolsByName, commandsByName } from "./fixtures/contracts.mjs";
import { packedFixture } from "./helpers/packed.mjs";

const root = resolve(import.meta.dirname, "../..");

/**
 * Load one installed package through the real external host loader and report
 * the registrations it produced. The child runs with the network guard, so a
 * package that tried to resolve an unbundled dependency would fail loudly.
 */
const loaderProbe = String.raw`
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [hostDirectory, entry, expectationPath] = process.argv.slice(2);
const { readFileSync } = await import("node:fs");
const expected = JSON.parse(readFileSync(expectationPath, "utf8"));
const SDK = await import(pathToFileURL(join(hostDirectory, "dist/index.js")).href);
const loader = new SDK.DefaultResourceLoader({
	cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR, eventBus: SDK.createEventBus(),
	noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	additionalExtensionPaths: [entry],
});
await loader.reload();
const loaded = loader.getExtensions();
assert.deepEqual(loaded.errors, [], "installed package loads through the real host loader");
const extension = loaded.extensions.find((candidate) => candidate.path === entry);
assert.ok(extension, "the packed entry path loads exactly once");
assert.deepEqual([...extension.tools.keys()].sort(), [...expected.tools].sort());
assert.deepEqual([...extension.commands.keys()].sort(), [...expected.commands].sort());
`;

for (const name of names) {
	test(`packed ${name} installs and loads standalone outside the workspace`, { timeout: 300000 }, async (t) => {
		const packed = await packedFixture(t, name);
		assert.equal(packed.installed.status, 0, packed.installed.stderr || packed.installed.stdout);
		assert.ok(packed.entry, "the installed manifest declares a Pi entry");
		assert.equal(existsSync(join(packed.directory, "node_modules")), false, `${name} ships no dependency tree`);
		const expectation = join(packed.base, "expectation.json");
		await writeFile(expectation, JSON.stringify({
			tools: toolsByName[name], commands: commandsByName[name],
		}));
		const worker = join(packed.base, "loader-probe.mjs");
		await writeFile(worker, loaderProbe);
		const result = spawnSync(process.execPath, ["--import", join(root, "test/integration/fixtures/network-guard.mjs"), worker,
			packed.host.directory, packed.entry, expectation],
		{ cwd: packed.consumer, env: { ...packed.env, SERRALY_REPORT: join(packed.base, "report.jsonl") }, encoding: "utf8", timeout: 120000 });
		assert.equal(result.status, 0, `${name}: ${result.stderr}\n${result.stdout}`);
	});
}

test("an offline install cannot silently satisfy an unbundled runtime dependency", { timeout: 180000 }, async (t) => {
	const base = await mkdtemp(join(tmpdir(), "serraly-unbundled-"));
	t.after(async () => { await rm(base, { recursive: true, force: true }); });
	const pkg = join(base, "pi-fixture-unbundled");
	await mkdir(join(pkg, "dist"), { recursive: true });
	await writeFile(join(pkg, "package.json"), JSON.stringify({
		name: "pi-fixture-unbundled", version: "1.0.0", private: true, type: "module",
		dependencies: { "pi-serraly-absent-dependency": "1.0.0" },
		pi: { extensions: ["./dist/index.js"] }, files: ["dist/"],
	}, null, 2) + "\n");
	await writeFile(join(pkg, "dist/index.js"), "export default () => {};\n");
	const env = isolatedEnvironment(base);
	await mkdir(env.HOME, { recursive: true });
	const packed = spawnSync(process.execPath, [npmCliPath(), "pack", "--ignore-scripts", "--pack-destination", base, pkg],
		{ cwd: base, env, encoding: "utf8", timeout: 120000 });
	assert.equal(packed.status, 0, packed.stderr);
	const tarball = join(base, packed.stdout.trim().split("\n").at(-1));
	const consumer = join(base, "consumer");
	await mkdir(consumer, { recursive: true });
	await writeFile(join(consumer, "package.json"), '{"name":"serraly-consumer","private":true}\n');
	const installed = spawnSync(process.execPath, [npmCliPath(), "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
		"--legacy-peer-deps", tarball], { cwd: consumer, env, encoding: "utf8", timeout: 120000 });
	assert.notEqual(installed.status, 0, "an absent registry dependency must fail instead of resolving from a local cache");
	assert.match(`${installed.stderr}${installed.stdout}`, /pi-serraly-absent-dependency|ENOTCACHED|offline/i);
});
