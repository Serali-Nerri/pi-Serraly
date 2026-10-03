import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { filesIn } from "./lib/artifacts.mjs";
import { buildPackage } from "./lib/build-package.mjs";
import { discoverPackages, root } from "./lib/packages.mjs";
import { isolatedRun } from "./lib/workspace.mjs";

try {
	const packages = await discoverPackages();
	// Consumers typecheck against built library declarations and seals.
	for (const pkg of packages.filter((candidate) => candidate.kind === "library")) await buildPackage(pkg);
	for (const pkg of packages) {
		const manifest = JSON.parse(await readFile(join(pkg.directory, "package.json"), "utf8"));
		const command = manifest.scripts?.check ? "check" : "typecheck";
		await isolatedRun("npm", ["run", command, "--workspace", pkg.relativeDirectory]);
	}
	for (const path of await filesIn(join(root, "scripts"))) {
		if (path.endsWith(".mjs")) await isolatedRun(process.execPath, ["--check", path]);
	}
} catch (error) { console.error(error.message); process.exitCode = 1; }
