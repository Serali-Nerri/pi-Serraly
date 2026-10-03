#!/usr/bin/env node
// Isolated fd process boundary for Pi's real autocomplete provider. It reads only the
// requested fixture directory, never a user's global ignore files or HOME/config.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
let baseDir;
let maxDepth = Infinity;
let maxResults = Infinity;
let fullPath = false;
let query = "";
const types = new Set();
for (let index = 0; index < args.length; index += 1) {
	switch (args[index]) {
		case "--base-directory":
			baseDir = args[++index];
			break;
		case "--max-results":
			maxResults = Number(args[++index]);
			break;
		case "--max-depth":
			maxDepth = Number(args[++index]);
			break;
		case "--type":
			types.add(args[++index]);
			break;
		case "--exclude":
			assert.ok([".git", ".git/*", ".git/**"].includes(args[++index]));
			break;
		case "--full-path":
			fullPath = true;
			break;
		case "--follow":
		case "--hidden":
			break;
		default:
			assert.ok(!args[index].startsWith("--"), `unsupported fixture argument: ${args[index]}`);
			query = args[index];
	}
}
assert.ok(baseDir);
const matches = new RegExp(query, /[A-Z]/.test(query) ? "" : "i");
const results = [];
function walk(directory, prefix = "", depth = 1) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === ".git" || results.length >= maxResults) continue;
		const path = `${prefix}${entry.name}`;
		if (matches.test(fullPath ? path : entry.name)) {
			if (entry.isFile() && types.has("f")) results.push(path);
			if (entry.isDirectory() && types.has("d")) results.push(`${path}/`);
		}
		if (entry.isDirectory() && depth < maxDepth) walk(join(directory, entry.name), `${path}/`, depth + 1);
	}
}
walk(baseDir);
if (results.length > 0) process.stdout.write(`${results.join("\n")}\n`);
