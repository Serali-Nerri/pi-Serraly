import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { discoverAndLoadExtensions, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";

// Catches a missing/wrong workspace entry or an entry that no longer registers
// an executable apply_patch. The actual Pi loader is the boundary, not source text.
test("workspace entry registers an executable patch through Pi's real loader", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-serraly-patch-migration-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	const cwd = join(root, "cwd");
	await mkdir(agentDir);
	await mkdir(cwd);
	const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
	const loaded = await discoverAndLoadExtensions([entry], cwd, agentDir);
	assert.deepEqual(loaded.extensions.flatMap((extension) => [...extension.tools.keys()]), ["apply_patch"]);
	assert.deepEqual(loaded.errors, []);
	const tool = loaded.extensions[0].tools.get("apply_patch")!.definition;
	const result = await tool.execute("migration", {
		input: "*** Begin Patch\n*** Add File: migrated.txt\n+workspace patch\n*** End Patch",
	}, undefined, undefined, { cwd } as ExtensionToolContext);
	assert.equal(await readFile(join(cwd, "migrated.txt"), "utf8"), "workspace patch\n");
	assert.deepEqual(result.content, [{ type: "text", text: "Success. Updated the following files:\nA migrated.txt" }]);
	assert.equal((result.details as { format: string }).format, "apply_patch.v1");
});
