import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clearRuntimeCache, readRuntimeInfo } from "../../src/shell/runtime.ts";

test("runtime detection queries bounded version data and reuses only matching project fingerprints", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-ui-shell-runtime-"));
	try {
		clearRuntimeCache();
		await writeFile(join(cwd, "package.json"), "{}\n");
		const first = await readRuntimeInfo(cwd);
		assert.deepEqual(first, { name: "nodejs", version: process.versions.node });
		assert.equal(await readRuntimeInfo(cwd), first);
		await writeFile(join(cwd, ".nvmrc"), `${process.versions.node}\n`);
		const updated = await readRuntimeInfo(cwd);
		assert.deepEqual(updated, first);
		assert.notEqual(updated, first, "new marker invalidates the version cache");
		clearRuntimeCache();
		assert.notEqual(await readRuntimeInfo(cwd), updated);
	} finally {
		clearRuntimeCache();
		await rm(cwd, { recursive: true, force: true });
	}
});
