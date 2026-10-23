import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { packages, requireNode, root, runIsolated } from "./lib/workspace.mjs";

requireNode();
const args = process.argv.slice(2).filter((arg) => arg !== "--");
if (args.length && (args.length !== 2 || args[0] !== "--package")) throw new Error("Usage: check [--package name]");
const all = await packages();
const selected = args.length ? all.filter((pkg) => pkg.name === args[1]) : all;
if (!selected.length) throw new Error(`Unknown package: ${args[1]}`);
for (const pkg of selected) {
	console.log(`Check ${pkg.name}`);
	await runIsolated("bun", ["run", "check"], { cwd: pkg.directory, echo: true });
}
async function checkScripts(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) await checkScripts(path);
		else if (path.endsWith(".mjs")) await runIsolated(process.execPath, ["--check", path]);
	}
}
await checkScripts(join(root, "scripts"));
