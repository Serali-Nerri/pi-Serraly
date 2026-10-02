import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { sealDist, verifyDist } from "../../scripts/lib/artifacts.mjs";
import { runtimeLock } from "../../scripts/lib/package.mjs";
import { root } from "../../scripts/lib/modules.mjs";

test("a missing native worker is diagnosed by its artifact path before publication", async () => {
	const base = await mkdtemp(join(tmpdir(), "serraly-missing-worker-"));
	try {
		await cp(join(root, "dist"), join(base, "dist"), { recursive: true });
		await rm(join(base, "dist/pi-docparser/native-worker.mjs"));
		await assert.rejects(verifyDist(join(base, "dist")), /pi-docparser\/native-worker\.mjs/);
	} finally { await rm(base, { recursive: true, force: true }); }
});

test("a modified compiled tool is rejected rather than sealed as a release", async () => {
	const base = await mkdtemp(join(tmpdir(), "serraly-modified-tool-"));
	try {
		await cp(join(root, "dist"), join(base, "dist"), { recursive: true });
		await writeFile(join(base, "dist/pi-tools/index.js"), "export default () => {};\n");
		await assert.rejects(verifyDist(join(base, "dist")), /pi-tools\/index\.js/);
	} finally { await rm(base, { recursive: true, force: true }); }
});

for (const legalFile of [
	"pi-ui/licenses/LICENSES/pi-compact-thinking.txt",
	"pi-ui/licenses/LICENSES/marked.txt",
	"pi-docparser/licenses/LiteParse-APACHE-2.0.txt",
	"pi-tools/licenses/diff-BSD.txt",
]) {
	test(`sealing requires inherited legal payload: ${legalFile}`, async () => {
		const base = await mkdtemp(join(tmpdir(), "serraly-missing-license-"));
		try {
			await cp(join(root, "dist"), join(base, "dist"), { recursive: true });
			await rm(join(base, "dist", legalFile));
			await assert.rejects(sealDist(join(base, "dist")), (error) => error.message.includes(legalFile));
		} finally { await rm(base, { recursive: true, force: true }); }
	});
}

test("runtime lock keeps nested and optional resolutions but drops unrelated development hosts", () => {
	const projected = runtimeLock({ lockfileVersion: 3, packages: {
		"": {},
		"node_modules/runtime": { version: "1.0.0", resolved: "https://registry.invalid/runtime.tgz", integrity: "sha512-fixture",
			dependencies: { nested: "2.0.0" }, optionalDependencies: { platform: "1.0.0" }, dev: true },
		"node_modules/runtime/node_modules/nested": { version: "2.0.0", resolved: "https://registry.invalid/nested.tgz", integrity: "sha512-fixture" },
		"node_modules/nested": { version: "3.0.0", dev: true },
		"node_modules/platform": { version: "1.0.0", resolved: "https://registry.invalid/platform.tgz", integrity: "sha512-fixture", optional: true, os: ["linux"] },
		"node_modules/@earendil-works/pi-tui": { version: "0.99.2", dev: true },
	} }, { name: "runtime-fixture", version: "1.0.0", dependencies: { runtime: "1.0.0" }, peerDependencies: { "typebox": "*" }, engines: { node: ">=22.19.0" } });
	assert.deepEqual(Object.keys(projected.packages), ["", "node_modules/platform", "node_modules/runtime", "node_modules/runtime/node_modules/nested"]);
	assert.equal(projected.packages["node_modules/runtime"].dev, undefined);
	assert.equal(projected.packages["node_modules/platform"].optional, true);
	assert.deepEqual(projected.packages["node_modules/platform"].os, ["linux"]);
	assert.equal(projected.packages["node_modules/runtime/node_modules/nested"].version, "2.0.0");
});

test("runtime lock rejects a reachable host dependency instead of installing a duplicate class registry", () => {
	assert.throws(() => runtimeLock({ lockfileVersion: 3, packages: {
		"node_modules/runtime": { version: "1.0.0", resolved: "https://registry.invalid/runtime.tgz", integrity: "sha512-fixture",
			dependencies: { typebox: "*" } },
	} }, { name: "fixture", version: "1.0.0", dependencies: { runtime: "1.0.0" } }), /physical host: typebox/);
});

for (const entry of ["pi-ui/index.js", "pi-docparser/native-worker.mjs"]) {
	for (const linked of [false, true]) {
		test(`sealing rejects an outside ${linked ? "linked" : "regular"} executable imported by ${entry}`, async () => {
			const base = await mkdtemp(join(tmpdir(), "serraly-outside-import-"));
			try {
				await cp(join(root, "dist"), join(base, "dist"), { recursive: true });
				const external = join(base, "outside.mjs");
				await writeFile(external, "export default function outside() {}\n");
				const target = linked ? join(base, "outside-link.mjs") : external;
				if (linked) await symlink(external, target);
				await writeFile(join(base, "dist", entry), `export { default } from ${JSON.stringify(target)};\n`);
				await assert.rejects(sealDist(join(base, "dist")), /outside|closure/i);
			} finally { await rm(base, { recursive: true, force: true }); }
		});
	}
}

for (const [kind, specifier, decoyName] of [
	["encoded dots", "./%2e%2e/%2e%2e/outside.mjs", "%2e%2e/%2e%2e/outside.mjs"],
	["query", "../../outside.mjs?/../dist/pi-docparser/decoy.mjs", "decoy.mjs"],
	["fragment", "../../outside.mjs#/../dist/pi-docparser/decoy.mjs", "decoy.mjs"],
	["backslashes", "./..\\..\\outside.mjs", "..\\..\\outside.mjs"],
	["URL control characters", "./.\n./.\n./outside.mjs", ".\n./.\n./outside.mjs"],
]) {
	test(`${kind} cannot seal a filesystem decoy instead of Node's actual worker import`, {
		skip: process.platform === "win32" && ["backslashes", "URL control characters"].includes(kind) ?
			"This fixture requires POSIX filenames which differ from file-URL resolution" : false,
	}, async () => {
		const base = await mkdtemp(join(tmpdir(), "serraly-encoded-import-"));
		try {
			await cp(join(root, "dist"), join(base, "dist"), { recursive: true });
			await writeFile(join(base, "outside.mjs"), "export default () => \"actual-outside\";\n");
			const decoy = join(base, "dist/pi-docparser", decoyName);
			await mkdir(dirname(decoy), { recursive: true });
			await writeFile(decoy, "export default () => \"sealed-decoy\";\n");
			const worker = join(base, "dist/pi-docparser/native-worker.mjs");
			await writeFile(worker, `export { default } from ${JSON.stringify(specifier)};\n`);
			assert.equal((await import(pathToFileURL(worker).href)).default(), "actual-outside");
			await assert.rejects(sealDist(join(base, "dist")), /specifier|closure|outside/i);
		} finally { await rm(base, { recursive: true, force: true }); }
	});
}
