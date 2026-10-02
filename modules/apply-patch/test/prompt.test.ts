import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import applyPatchExtension from "../src/index.ts";

// Catches loss of default direct activation or prompt metadata during migration.
// Inspect the actual SDK prompt/loadout; no provider request is made.
test("direct patch metadata reaches the initial SDK prompt without replacing built-ins", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-serraly-patch-prompt-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	const cwd = join(root, "cwd");
	await mkdir(agentDir);
	await mkdir(cwd);
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(agentDir, "models-cache.json"),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const model = modelRuntime.getModels()[0];
	assert.ok(model, "Pi's built-in catalog must provide a static model for offline setup");
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [applyPatchExtension],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		modelRuntime,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
	});
	t.after(() => session.dispose());
	const active = session.getActiveToolNames();
	for (const name of ["read", "bash", "edit", "write", "apply_patch"]) assert.ok(active.includes(name), name);
	assert.ok(session.getCallableToolNames().includes("apply_patch"));
	assert.match(session.systemPrompt, /apply_patch: Apply patches to add, update, delete, or move files/);
	assert.match(session.systemPrompt, /Use apply_patch for file changes; inspect existing text before constructing update chunks\./);
	assert.match(session.systemPrompt, /apply_patch: @@ context anchors are text, not line numbers\. Keep chunks in source order and include enough context to target the intended occurrence\./);
});
