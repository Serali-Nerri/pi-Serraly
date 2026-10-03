#!/usr/bin/env node
/**
 * Package-local test entry: `npm test --workspace <name>` runs the package's
 * declared raw suite under the same isolated HOME/config/network policy as the
 * root runner. Direct debugging can still call the raw command.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isolatedRun } from "./lib/workspace.mjs";

const directory = resolve(process.cwd());
const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
const command = manifest.serraly?.test?.command;
if (!command) throw new Error(`${manifest.name}: no serraly.test.command to run`);
await isolatedRun("npm", ["run", command, "--workspace", directory], directory,
	{ denyNetwork: manifest.serraly.test.denyNetwork === true });
