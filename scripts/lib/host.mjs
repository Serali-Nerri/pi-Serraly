import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { root } from "./modules.mjs";

/** Acceptance is pinned to the qualified host; an explicit override must match. */
export const expectedVersion = "1.0.0";

export function hostPackage() {
	// Read package metadata only; never invoke npm/resolve a source-workspace host.
	const candidate = process.env.PI_UI_HOST_PACKAGE || resolve(dirname(process.execPath), "../lib/node_modules/@earendil-works/pi-coding-agent");
	const directory = realpathSync(candidate);
	assert.ok(!directory.startsWith(root + sep), "CLI host must be outside the development dependency tree");
	const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
	assert.equal(manifest.name, "@earendil-works/pi-coding-agent");
	assert.equal(manifest.version, expectedVersion, "acceptance is pinned to Pi 1.0.0");
	assert.equal(manifest.bin.pi, "dist/bundle/cli.js", "use the actual bundled CLI, not dist/cli.js");
	const cli = join(directory, manifest.bin.pi);
	assert.ok(existsSync(cli));
	return { directory, cli };
}
