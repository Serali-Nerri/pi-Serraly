import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
	type ExtensionFactory, type ExtensionContext, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type Context, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AutocompleteProviderFactory } from "@earendil-works/pi-coding-agent";
import sessionReference from "../src/index.ts";

export const usage = {
	input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export async function harness(t: TestContext, mode: ExtensionContext["mode"] = "print", history: "custom" | "managed" | "memory" = "custom", lifecycle?: ExtensionFactory) {
	const root = await mkdtemp(join(tmpdir(), "session-reference-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, "current"), agentDir = join(root, "agent"), sessionDir = join(root, "history");
	await mkdir(cwd, { recursive: true });
	const manager = history === "managed" ? undefined : history === "memory" ? SessionManager.inMemory(cwd) : SessionManager.create(cwd, sessionDir);
	const requests: Context[] = [];
	let failNext = false;
	const provider: ExtensionFactory = (pi) => pi.registerProvider("reference-fixture", {
		api: "reference-scripted", apiKey: "synthetic", baseUrl: "https://example.invalid",
		models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000,
			maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model, context) {
			requests.push(structuredClone(context));
			const failure = failNext;
			failNext = false;
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant", content: [{ type: "text", text: "Fixture reply" }], api: model.api,
				provider: model.provider, model: model.id, timestamp: Date.now(), usage,
				stopReason: failure ? "error" : "stop", ...(failure ? { errorMessage: "rate limit" } : {}),
			};
			queueMicrotask(() => {
				if (failure) stream.push({ type: "error", reason: "error", error: message });
				else stream.push({ type: "done", reason: "stop", message });
				stream.end();
			});
			return stream;
		},
	});
	// Empty credential boundary; neither real auth storage nor network is consulted.
	const modelRuntime = await ModelRuntime.create({
		credentials: { read: async () => undefined, list: async () => [],
			modify: async (_id, fn) => fn(undefined), delete: async () => {} },
		modelsPath: null, modelsStorePath: join(root, "model-cache.json"),
		allowModelNetwork: false, refreshOnCreate: false,
	});
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false },
		retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [{ name: "session-reference", factory: history === "memory" ? (pi) => sessionReference(pi, { agentDir }) : sessionReference }, { name: "fixture", factory: provider },
			...(lifecycle ? [{ name: "lifecycle", factory: lifecycle }] : [])],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	for (const { name, config } of loader.getExtensions().runtime.pendingProviderRegistrations) {
		modelRuntime.registerProvider(name, config);
	}
	const model = modelRuntime.getModel("reference-fixture", "fixture");
	assert.ok(model);
	const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model, settingsManager,
		resourceLoader: loader, sessionManager: manager, tools: [], thinkingLevel: "off" });
	const factories: AutocompleteProviderFactory[] = [];
	const ui = { addAutocompleteProvider: (factory: AutocompleteProviderFactory) => factories.push(factory) } as unknown as ExtensionUIContext;
	const errors: unknown[] = [];
	t.after(async () => {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
		assert.deepEqual(errors, []);
	});
	await session.bindExtensions({ mode, ...(mode === "tui" ? { uiContext: ui } : {}), onError: (error) => errors.push(error) });
	let sourceNumber = 0;
	function source(text: string, name = "Shared title", workspace = join(root, "elsewhere")) {
		const saved = SessionManager.create(workspace, history === "custom" ? sessionDir : join(agentDir, "sessions", `--source-${++sourceNumber}--`));
		saved.appendMessage({ role: "user", content: text, timestamp: Date.now() });
		saved.appendSessionInfo(name);
		return saved;
	}
	const services = { cwd, agentDir, modelRuntime, settingsManager, resourceLoader: loader, diagnostics: [] };
	return { root, cwd, agentDir, sessionDir, manager: session.sessionManager, session, services, requests, factories, source,
		failNext: () => { failNext = true; } };
}

export function references(h: Awaited<ReturnType<typeof harness>>) {
	return h.session.messages.flatMap((message) => message.role === "custom" && message.customType === "session-reference" ? [message] : []);
}
