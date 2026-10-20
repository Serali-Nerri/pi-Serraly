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
import toolsExtension from "../src/index.ts";

// Inspect the actual SDK prompt/loadout; no provider request is made.
test("only grep/find/ls are callable from the extension, without patch tools or guidance", async (t) => {
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
		extensionFactories: [toolsExtension],
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
	assert.ok(!active.includes("apply_patch"));
	const callable = session.getCallableToolNames();
	assert.ok(!callable.includes("apply_patch"));
	assert.equal(session.getToolDefinition("apply_patch"), undefined);
	for (const name of ["grep", "find", "ls"]) {
		assert.ok(!active.includes(name), `${name} is not declared by default`);
		assert.ok(callable.includes(name), `${name} is callable from codemode`);
		assert.equal(session.getToolDefinition(name)!.exposure, "codemode");
	}
	// The built-in snippets disappear because the same-name replacements are not declared.
	assert.doesNotMatch(session.systemPrompt, /Search file contents for patterns/);
	assert.doesNotMatch(session.systemPrompt, /\bapply_patch\b/);
});
