import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
	createEventBus, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { root } from "../../../scripts/lib/workspace.mjs";
import { model } from "./codex-tools-extension.mjs";

const mode = process.argv[2];
const options = JSON.parse(process.argv[3] ?? "{}");
const expected = options.expected ?? ["exec", "wait"];
const expectedActive = options.expectedActive ?? expected;
const cwd = join(process.env.HOME, "work");
const agentDir = process.env.PI_CODING_AGENT_DIR;
await mkdir(cwd, { recursive: true });
const configPath = join(agentDir, "pi-codex-conversion.json");
let config = JSON.stringify({
	executionMode: mode,
	scope: { allProviders: "on" },
	tools: { autoReasoning: false },
	compaction: { continuity: "compaction", method: "v2" },
	...options.config,
});
await writeFile(configPath, config);

// The official Code host is not needed for declaration/lifecycle acceptance.
// Abort optional prewarming before it can download an executable; the process
// network guard still rejects any other outbound operation.
globalThis.fetch = async () => { throw new DOMException("Offline tool declaration fixture", "AbortError"); };

const eventBus = createEventBus();
const requests = [];
eventBus.on("fixture:model-request", (tools) => requests.push(tools.sort()));
const errors = [];
const sessionManager = SessionManager.inMemory(cwd);
const modelRuntime = await ModelRuntime.create({
	authPath: join(agentDir, "auth.json"), modelsPath: null,
	allowModelNetwork: false, refreshOnCreate: false,
});
const settingsManager = SettingsManager.inMemory({});
let runtime;
try {
	runtime = await createAgentSessionRuntime(async (options) => {
		const services = await createAgentSessionServices({
			cwd, agentDir, modelRuntime, settingsManager,
			resourceLoaderOptions: {
				eventBus, noExtensions: true, noSkills: true, noPromptTemplates: true,
				noThemes: true, noContextFiles: true,
				additionalExtensionPaths: [
					join(root, "packages/pi-codex-conversion"),
					join(root, "test/integration/fixtures/codex-tools-extension.mjs"),
				],
			},
		});
		const created = await createAgentSessionFromServices({
			services, sessionManager: options.sessionManager, thinkingLevel: "high",
		});
		return { ...created, services, diagnostics: services.diagnostics };
	}, { cwd, agentDir, sessionManager });
	const session = runtime.session;
	assert.deepEqual(session.resourceLoader.getExtensions().errors, []);
	await session.bindExtensions({ onError: (error) => errors.push(error) });
	await session.setModel(model);
	// Keep the manual-hide case independent of Pi's historical declaration replay.
	if (options.hide) await session.prompt(`/fixture-hide ${options.hide}`);

	await session.prompt("First synthetic point");
	const target = sessionManager.getBranch().find((entry) =>
		entry.type === "message" && entry.message.role === "assistant").id;
	await session.prompt("Second synthetic point");
	assert.deepEqual(requests.at(-1), expected);
	assert.deepEqual(session.getActiveToolNames().sort(), expectedActive);
	if (options.switchConfig) {
		config = JSON.stringify({ ...JSON.parse(config), ...options.switchConfig });
		await writeFile(configPath, config);
		await session.reload();
		await session.setModel(model);
	}
	if (!options.skipNavigation) await session.navigateTree(target, { summarize: false });
	await session.prompt("Continue after loadout synchronization");
	assert.deepEqual(session.getActiveToolNames().sort(), options.expectedAfter ?? expectedActive);
	assert.deepEqual(requests.at(-1), options.expectedAfter ?? expected);
	assert.equal(requests.length, 3);
	assert.deepEqual(errors, []);
	assert.equal(await readFile(configPath, "utf8"), config);
} finally {
	await runtime?.dispose();
}
