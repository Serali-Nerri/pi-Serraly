import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { createRelease, sealRelease, validateRelease } from "../../scripts/lib/package.mjs";

let base, release;
before(async () => {
	base = await mkdtemp(join(tmpdir(), "serraly-release-safety-"));
	release = join(base, "qualified");
	await createRelease(release, { buildId: "safety-fixture" });
});
after(async () => { if (base) await rm(base, { recursive: true, force: true }); });

async function copy(name) {
	const candidate = join(base, name);
	await cp(release, candidate, { recursive: true, verbatimSymlinks: true });
	return candidate;
}

test("release preparation refuses a symlink alias into extension discovery before publication", async () => {
	const discovery = join(base, "agent/extensions");
	const alias = join(base, "alias");
	await mkdir(discovery, { recursive: true });
	await symlink(discovery, alias, "dir");
	await assert.rejects(createRelease(join(alias, "candidate")), /symlink|discovery/i);
	assert.deepEqual(await readdir(discovery), []);
});

test("release preparation refuses inherited physical host packages", async () => {
	const parent = join(base, "host-parent");
	await mkdir(join(parent, "node_modules/@earendil-works/pi-tui"), { recursive: true });
	await assert.rejects(createRelease(join(parent, "candidate")), /host|dependency tree/i);
});

test("an existing release cannot inherit a duplicate host registry from its parent", async () => {
	const candidate = join(base, "existing-host-parent/release");
	await cp(release, candidate, { recursive: true });
	await mkdir(join(base, "existing-host-parent/node_modules/typebox"), { recursive: true });
	await assert.rejects(validateRelease(candidate), /host|dependency tree/i);
});

test("release validation rejects an injected dependency tree instead of installing it", async () => {
	const candidate = await copy("injected-dependencies");
	const injected = join(candidate, "node_modules/foreign-package");
	await mkdir(injected, { recursive: true });
	await writeFile(join(injected, "package.json"), '{"name":"foreign-package","version":"1.0.0"}\n');
	await writeFile(join(injected, "index.js"), "export default 1;\n");
	await assert.rejects(validateRelease(candidate), /node_modules|dependency/i);
	assert.equal(await readFile(join(injected, "package.json"), "utf8"), '{"name":"foreign-package","version":"1.0.0"}\n',
		"validation reports the injected tree instead of deleting or repairing it");
});

// Break caught: a runtime manifest that still declares installable dependencies
// cannot be validated as a self-contained release.
test("release validation rejects declared runtime dependencies", async () => {
	const candidate = await copy("declared-dependency");
	const manifest = JSON.parse(await readFile(join(candidate, "package.json"), "utf8"));
	manifest.dependencies = { "foreign-package": "1.0.0" };
	await writeFile(join(candidate, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
	await assert.rejects(validateRelease(candidate), /runtime-only|dependenc/i);
});

test("validation verifies the recorded release digest", async () => {
	const candidate = await copy("damaged-digest");
	const record = JSON.parse(await readFile(join(candidate, "release.json"), "utf8"));
	record.digest = "0".repeat(64);
	await writeFile(join(candidate, "release.json"), JSON.stringify(record));
	await assert.rejects(validateRelease(candidate), /digest|integrity/i);
});

test("sealing cannot replace an existing release identity", async () => {
	const candidate = await copy("already-sealed");
	const original = await readFile(join(candidate, "release.json"), "utf8");
	await assert.rejects(sealRelease(candidate, { buildId: "replacement" }), /already|sealed|exists/i);
	assert.equal(await readFile(join(candidate, "release.json"), "utf8"), original);
});

for (const name of ["package.json", "release.json"]) {
	test(`release metadata must be physical, not an external ${name} link`, async () => {
		const candidate = await copy(`linked-${name}`);
		const external = join(base, `external-${name}`);
		await cp(join(candidate, name), external);
		await rm(join(candidate, name));
		await symlink(external, join(candidate, name));
		await assert.rejects(validateRelease(candidate), /symlink|regular file/i);
	});
}

test("an identical external dist link cannot escape the immutable runtime tree", async () => {
	const candidate = await copy("linked-dist");
	const external = join(base, "external-dist");
	await cp(join(candidate, "dist"), external, { recursive: true });
	await rm(join(candidate, "dist"), { recursive: true });
	await symlink(external, join(candidate, "dist"), "dir");
	await assert.rejects(validateRelease(candidate), /symlink|real directory/i);
});

test("release validation rejects a symlinked payload instead of following it", async () => {
	const candidate = await copy("linked-payload");
	const external = join(base, "external-payload.js");
	await writeFile(external, "export default 1;\n");
	await symlink(external, join(candidate, "dist/pi-ui/linked-payload.js"));
	await assert.rejects(validateRelease(candidate), /symlink|regular|node_modules/i);
});
