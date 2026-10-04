import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { MINIMUM_NODE, assertSupportedNode, compareNodeVersions, parseNodeVersion } from "../../scripts/lib/node-version.mjs";
import { root } from "../../scripts/lib/packages.mjs";

test("the baseline is the qualified Node release", () => {
	assert.equal(MINIMUM_NODE, "22.19.0");
});

test("the gate accepts the baseline and every newer qualified release", () => {
	for (const version of ["22.19.0", "v22.19.0", "22.19.1", "22.20.0", "23.0.0", "24.12.0", "v24.12.0"]) {
		assert.doesNotThrow(() => assertSupportedNode(version), version);
	}
});

test("the gate rejects anything below the baseline", () => {
	for (const version of ["22.18.0", "22.18.99", "22.0.0", "21.9.9", "20.19.0", "18.20.4", "0.0.1"]) {
		assert.throws(() => assertSupportedNode(version), /below the supported baseline 22\.19\.0/, version);
	}
});

test("unparseable versions fail closed instead of being treated as supported", () => {
	for (const version of ["", "22", "22.19", "twenty-two", "22.19.0-rc.1", "v", "24.12.0.1"]) {
		assert.throws(() => assertSupportedNode(version), /Unsupported Node version string/, version);
	}
});

test("version comparison is numeric, not lexicographic", () => {
	assert.equal(compareNodeVersions(parseNodeVersion("22.19.0"), parseNodeVersion("22.9.0")), 1);
	assert.equal(compareNodeVersions(parseNodeVersion("22.9.0"), parseNodeVersion("22.19.0")), -1);
	assert.equal(compareNodeVersions(parseNodeVersion("24.12.0"), parseNodeVersion("24.12.0")), 0);
	assert.equal(compareNodeVersions(parseNodeVersion("100.0.0"), parseNodeVersion("24.12.0")), 1);
});

test("every root entry point refuses to run below the baseline before doing work", () => {
	const preload = new URL("./fixtures/old-node.mjs", import.meta.url).href;
	for (const script of ["check.mjs", "build.mjs", "test.mjs", "pack-check.mjs", "release.mjs"]) {
		const probe = spawnSync(process.execPath, [join(root, "scripts", script)], {
			cwd: root, encoding: "utf8", timeout: 60_000,
			env: { ...process.env, NODE_OPTIONS: `--import=${preload}` },
		});
		assert.notEqual(probe.status, 0, `${script} must fail on an unsupported Node`);
		assert.match(`${probe.stderr}${probe.stdout}`, /below the supported baseline 22\.19\.0/, script);
		assert.doesNotMatch(`${probe.stdout}`, /Built |Verified |Prepared /, `${script} must not do work before the gate`);
	}
});
