import { packages, requireNode, runIsolated } from "./lib/workspace.mjs";

requireNode();
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const focused = args.length === 2 && args[0] === "--package";
if (args.length && !focused) throw new Error("Usage: build [--package name]");
const all = await packages();
const selected = focused ? all.filter((pkg) => pkg.name === args[1]) : all;
if (!selected.length) throw new Error(`Unknown package: ${args[1]}`);
const byName = new Map(all.map((pkg) => [pkg.manifest.name, pkg]));
const bootstrap = new Set();
const ordered = [], visiting = new Set(), built = new Set();
function visit(pkg) {
	if (built.has(pkg.name)) return;
	if (visiting.has(pkg.name)) throw new Error(`Build dependency cycle: ${pkg.name}`);
	visiting.add(pkg.name);
	for (const name of Object.keys({ ...pkg.manifest.dependencies, ...pkg.manifest.devDependencies })) {
		// PCC needs only Browser's standalone voice API declarations to compile.
		// Build the full Browser after PCC, which its optional integration imports.
		if (pkg.name === "pi-codex-conversion" && name === "@howaboua/pi-browser" && byName.has(name)) {
			bootstrap.add(byName.get(name));
			continue;
		}
		if (byName.has(name)) visit(byName.get(name));
	}
	visiting.delete(pkg.name);
	built.add(pkg.name);
	ordered.push(pkg);
}
for (const pkg of selected) visit(pkg);
for (const pkg of bootstrap) visit(pkg);
for (const pkg of bootstrap) {
	console.log(`Bootstrap ${pkg.name} voice API`);
	await runIsolated("bun", ["run", "build:voice-api"], { cwd: pkg.directory, echo: true });
}
for (const pkg of ordered) {
	if (!pkg.manifest.scripts?.build) continue;
	console.log(`Build ${pkg.name}`);
	await runIsolated("bun", ["run", "build"], { cwd: pkg.directory, echo: true });
}
