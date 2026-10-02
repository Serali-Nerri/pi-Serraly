import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { createRelease, sealRelease, validateRelease } from "../../scripts/lib/package.mjs";
import { filesIn } from "../../scripts/lib/artifacts.mjs";

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

test("validation rejects a missing LiteParse implementation instead of trusting its package version", async () => {
	const candidate = await copy("missing-native-js");
	await rm(join(candidate, "node_modules/@llamaindex/liteparse/dist/lib.js"));
	await assert.rejects(validateRelease(candidate), /native|LiteParse/i);
});

test("validation rejects missing platform bindings and LiteParse's shipped local fallback", async () => {
	const candidate = await copy("missing-binding");
	const scope = join(candidate, "node_modules/@llamaindex");
	for (const name of await readdir(scope)) {
		if (name.startsWith("liteparse-")) await rm(join(scope, name), { recursive: true });
	}
	for (const file of await filesIn(join(scope, "liteparse"))) {
		if (file.endsWith(".node")) await rm(file);
	}
	await assert.rejects(validateRelease(candidate), /native|LiteParse/i);
});

test("validation exercises PDFium loading with OCR disabled, not merely native addon import", async () => {
	const candidate = await copy("missing-pdfium");
	const scope = join(candidate, "node_modules/@llamaindex");
	let removed = 0;
	for (const name of await readdir(scope)) {
		if (!name.startsWith("liteparse-")) continue;
		for (const file of await readdir(join(scope, name))) {
			if (/pdfium.*\.(?:so(?:\.\d+)*|dylib|dll)$/i.test(file)) {
				await rm(join(scope, name, file)); removed++;
			}
		}
	}
	assert.ok(removed > 0, "fixture removes the current platform's PDFium payload");
	await assert.rejects(validateRelease(candidate), /native|LiteParse|PDFium/i);
});

test("validation rejects a truncated runtime lock", async () => {
	const candidate = await copy("damaged-lock");
	await writeFile(join(candidate, "package-lock.json"), '{"lockfileVersion":3}\n');
	await assert.rejects(validateRelease(candidate), /lock|integrity/i);
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

for (const name of ["package.json", "package-lock.json", "release.json"]) {
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

test("npm executable links may not point outside the release dependency tree", async () => {
	const candidate = await copy("external-bin");
	const external = join(base, "external-executable.js");
	await writeFile(external, "// synthetic executable, never run\n");
	await mkdir(join(candidate, "node_modules/.bin"), { recursive: true });
	await symlink(external, join(candidate, "node_modules/.bin/foreign"));
	await assert.rejects(validateRelease(candidate), /executable|link/i);
});
