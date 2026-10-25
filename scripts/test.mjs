import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { packages, requireNode, root, runIsolated } from "./lib/workspace.mjs";

const integrationTests = {
	"pi-codex-conversion": ["cards.test.mjs", "codex-tools.test.mjs"],
	"pi-ui": ["ui.test.mjs"],
};

requireNode();
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const packagesOnly = args.length === 1 && args[0] === "--packages-only";
const focused = args.length === 2 && args[0] === "--package";
if (args.length && !packagesOnly && !focused) throw new Error("Usage: test [--packages-only | --package name]");
const all = await packages();
const selected = focused ? all.filter((pkg) => pkg.name === args[1]) : all;
if (!selected.length) throw new Error(`Unknown package: ${args[1]}`);
for (const pkg of selected) {
	if (!pkg.manifest.scripts?.test) continue;
	console.log(`Test ${pkg.name}`);
	await runIsolated("bun", ["run", "test"], {
		cwd: pkg.directory, env: { PI_SERRALY_ALLOW_LOOPBACK: "1" }, echo: true,
	});
}
if (!packagesOnly) {
	const tests = focused
		? (integrationTests[args[1]] ?? []).map((name) => join(root, "test/integration", name))
		: (await readdir(join(root, "test/integration")))
			.filter((name) => name.endsWith(".test.mjs")).sort().map((name) => join(root, "test/integration", name));
	if (tests.length) await runIsolated(process.execPath, ["--test", "--test-concurrency=1", ...tests], {
		env: { PI_SERRALY_ALLOW_LOOPBACK: "1" }, echo: true, timeoutMs: 300_000,
	});
}
