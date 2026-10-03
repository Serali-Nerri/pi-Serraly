#!/usr/bin/env node
/**
 * Package-local build entry: `npm run build --workspace <name>` runs this from
 * the package directory, building internal libraries first. `--check` verifies
 * the existing artifact without rebuilding it.
 */
import { resolve } from "node:path";
import { buildPackage } from "./lib/build-package.mjs";
import { discoverPackages, buildOrder } from "./lib/packages.mjs";
import { verifySourcePackage } from "./lib/package-artifacts.mjs";

async function main() {
	const args = process.argv.slice(2);
	const check = args[0] === "--check";
	if (args.length > (check ? 1 : 0)) throw new Error("Usage: node scripts/build-package.mjs [--check]");
	const directory = resolve(process.cwd());
	const packages = await discoverPackages();
	const pkg = packages.find((candidate) => candidate.directory === directory);
	if (!pkg) throw new Error(`Not a discovered workspace package: ${directory}`);
	if (check) {
		await verifySourcePackage(pkg.directory);
		console.log(`Verified ${pkg.name}@${pkg.manifest.version} artifact`);
		return;
	}
	for (const target of buildOrder(packages, [pkg.name])) await buildPackage(target);
	console.log(`Built ${pkg.name}@${pkg.manifest.version} and its internal dependencies`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
