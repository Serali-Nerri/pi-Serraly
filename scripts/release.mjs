#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRelease } from "./lib/package.mjs";

/**
 * Releases are named by the package version (directory and release.json
 * buildId), so every build keeps a stable, human-readable identity and
 * immutable directories never overwrite each other. Bump package.json before
 * releasing a new version; --build-id/--output remain explicit overrides.
 */
export function releaseTarget(args, { version, home = homedir() } = {}) {
	let output, buildId;
	const packages = [];
	for (let index = 0; index < args.length; index++) {
		if (args[index] === "--output" && args[index + 1]) output = args[++index];
		else if (args[index] === "--build-id" && args[index + 1]) buildId = args[++index];
		else if (args[index] === "--package" && args[index + 1]) packages.push(args[++index]);
		else throw new Error("Usage: npm run release -- [--package <npm-name>]... [--build-id <id>] [--output <absolute-path>]");
	}
	buildId ??= version;
	if (!buildId) throw new Error("No version available; pass --build-id or set package.json version");
	output ??= join(home, ".local/share/pi-Serraly/releases", buildId);
	return { output: resolve(output), buildId, packages };
}

async function main() {
	const version = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
	const target = releaseTarget(process.argv.slice(2), { version });
	const result = await createRelease(target.output, {
		buildId: target.buildId,
		packages: target.packages.length ? target.packages : undefined,
	});
	console.log(`Prepared immutable runtime package: ${result.path}\nNo settings or global extensions were changed.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
