import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const { createSandbox } = await import(new URL("../../../scripts/preview.mjs", import.meta.url).href);
const { runChild } = await import(new URL("../../../scripts/lib/process.mjs", import.meta.url).href);

test("managed Pi loads public tool renderers without changing execution and exports retained input/output HTML", { timeout: 30000 }, async () => {
	const sandbox = await createSandbox();
	try {
		const worker = new URL("./fixtures/renderer-host-worker.mjs", import.meta.url);
		const result = await runChild(sandbox, ["--import", join(sandbox.base, "safety.mjs"), fileURLToPath(worker), sandbox.host.directory]);
		assert.equal(result.code, 0, result.stderr);
		assert.equal(result.stdout, "");
		assert.equal(result.stderr, "");
		const report = await readFile(sandbox.env.PI_UI_REPORT, "utf8").catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return "";
			throw error;
		});
		assert.doesNotMatch(report, /network-denied/, "even a caught network attempt fails acceptance");
	} finally { await sandbox.cleanup(); }
});
