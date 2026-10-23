#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRelease } from "./lib/release.mjs";
import { requireNode } from "./lib/workspace.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const usage = "Usage: bun run release -- [--output <new-absolute-path-outside-the-repository>]";

export function parseReleaseArgs(args) {
	let output;
	for (let index = 0; index < args.length; index++) {
		if (args[index] !== "--output" || output !== undefined) throw new Error(usage);
		if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(usage);
		output = args[++index];
	}
	return { output };
}

/** Resolve the immutable release destination without creating it. */
export async function releaseTarget(args, { root: source = root, home = homedir() } = {}) {
	const { output } = parseReleaseArgs(args);
	if (output !== undefined) {
		if (!isAbsolute(output)) throw new Error("--output must be an absolute path");
		return { output: resolve(output) };
	}
	const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
	if (!manifest.version || typeof manifest.version !== "string") throw new Error("Root package.json has no version");
	return { output: join(home, ".local/share/pi-Serraly/releases", manifest.version) };
}

async function main() {
	requireNode();
	const target = await releaseTarget(process.argv.slice(2));
	const result = await createRelease(target.output, { root });
	console.log(`Prepared immutable offline runtime release: ${result.path}`);
	console.log("No Pi settings, host packages, or global extensions were changed.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
