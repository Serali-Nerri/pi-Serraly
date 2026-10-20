import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createEventBus, type ExtensionAPI, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import imagegenExtension from "../index.ts";
import type { createImageGenerationTool } from "../src/tool.ts";
import type { CodeModeImageTool } from "../src/pcc.ts";

// A one-pixel RGBA PNG with valid chunks, generated independently with zlib.
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg+M/wHwAEAQH/cetH5QAAAABJRU5ErkJggg==";
type ImageTool = ReturnType<typeof createImageGenerationTool>;

async function fixture(t: TestContext, oauth = false) {
	const cwd = await mkdtemp(join(tmpdir(), "imagegen-test-"));
	const agentDir = join(cwd, "agent");
	await mkdir(agentDir);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const previous = getGlobalDispatcher();
	const network = new MockAgent();
	network.disableNetConnect();
	setGlobalDispatcher(network);
	t.after(async () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		setGlobalDispatcher(previous);
		await network.close();
		await rm(cwd, { recursive: true, force: true });
	});
	const tools: ImageTool[] = [];
	const shutdown: Array<() => void> = [];
	const events = createEventBus();
	const pi = { events, registerTool(tool: ImageTool) { tools.push(tool); },
		on(event: string, handler: () => void) { if (event === "session_shutdown") shutdown.push(handler); },
	} as unknown as ExtensionAPI;
	await imagegenExtension(pi);
	assert.equal(tools.length, 1);
	const model = { provider: "openai", api: "openai-responses", id: "gpt-6.1-sol", baseUrl: "https://unused.invalid/v1", input: ["text", "image"] };
	const ctx = {
		cwd, model,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: oauth ? "new-subscription-access-token" : "gateway-key",
				baseUrl: "https://gateway.invalid/v1", headers: { "X-Provider-Key": "private-header", "OpenAI-Project": "project-fixture" } }),
			isUsingOAuth: () => oauth,
			getAvailable: () => [model], getAll: () => [model], find: () => undefined,
		},
		sessionManager: { buildSessionProjection: () => ({ messages: [] }) },
	} as unknown as ExtensionToolContext;
	return { cwd, agentDir, ctx, network, tool: tools[0]!, events, shutdown: () => shutdown.forEach((handler) => handler()) };
}

test("OpenAI API Key generation uses configured auth and saves the returned image without a Codex login", async (t) => {
	const { tool, ctx, network, cwd } = await fixture(t);
	let request: Record<string, unknown> | undefined;
	let headers: Headers | undefined;
	network.get("https://gateway.invalid").intercept({ path: "/v1/images/generations", method: "POST" }).reply((options) => {
		request = JSON.parse(String(options.body));
		headers = new Headers(options.headers as Record<string, string>);
		return { statusCode: 200, data: JSON.stringify({ data: [{ b64_json: png }], background: "transparent" }) };
	});
	const result = await tool.execute("image-call", { prompt: "A transparent leaf", transparent_background: true }, undefined, undefined, ctx);
	assert.deepEqual(request, { prompt: "A transparent leaf", model: "gpt-image-2.5", background: "transparent", quality: "auto", size: "auto" });
	assert.equal(headers?.get("authorization"), "Bearer gateway-key");
	assert.equal(headers?.get("x-provider-key"), "private-header");
	assert.equal(headers?.has("chatgpt-account-id"), false);
	assert.equal(headers?.has("originator"), false);
	assert.deepEqual(await readFile(join(cwd, result.details.path)), Buffer.from(png, "base64"));
	assert.deepEqual(await readFile(join(cwd, result.details.latest_path!)), Buffer.from(png, "base64"));
	assert.equal(result.content.find((part) => part.type === "image")?.data, png);
	network.assertNoPendingInterceptors();
});

for (const edit of [false, true]) {
	test(`OpenAI subscription OAuth uses a Responses image tool for ${edit ? "editing" : "generation"}`, async (t) => {
		const { tool, ctx, network, cwd } = await fixture(t, true);
		if (edit) await writeFile(join(cwd, "source.png"), Buffer.from(png, "base64"));
		let request: unknown;
		let headers: Headers | undefined;
		network.get("https://gateway.invalid").intercept({ path: "/v1/responses", method: "POST" }).reply((options) => {
			request = JSON.parse(String(options.body));
			headers = new Headers(options.headers as Record<string, string>);
			return { statusCode: 200, data: JSON.stringify({ status: "completed", output: [
				{ type: "message", content: [{ type: "output_text", text: "Done" }] },
				{ type: "image_generation_call", result: png, background: "transparent", quality: "high", size: "1024x1024" },
			] }) };
		});
		const result = await tool.execute("oauth-image", {
			prompt: "Make a green leaf", transparent_background: true,
			...(edit ? { referenced_image_paths: ["source.png"] } : {}),
		}, undefined, undefined, ctx);
		assert.deepEqual(request, {
			model: "gpt-6.1-sol", store: false, stream: false,
			input: [{ role: "user", content: [
				{ type: "input_text", text: "Make a green leaf" },
				...(edit ? [{ type: "input_image", image_url: "data:image/png;base64," + png }] : []),
			] }],
			tools: [{ type: "image_generation", model: "gpt-image-2.5", action: edit ? "edit" : "generate",
				background: "transparent", quality: "auto", size: "auto", output_format: "png" }],
			tool_choice: { type: "image_generation" },
		});
		assert.equal(headers?.get("authorization"), "Bearer new-subscription-access-token");
		assert.equal(headers?.get("openai-project"), "project-fixture");
		assert.equal(headers?.has("chatgpt-account-id"), false);
		assert.equal(result.details.transparent_background, true);
		assert.equal(result.details.quality, "high");
		assert.deepEqual(await readFile(join(cwd, result.details.path)), Buffer.from(png, "base64"));
		network.assertNoPendingInterceptors();
	});
}

test("an OpenAI authentication failure stays on OpenAI and does not expose credential errors", async (t) => {
	const { tool, ctx } = await fixture(t);
	ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: false, error: "secret-access-token in upstream failure" });
	await assert.rejects(tool.execute("denied", { prompt: "A leaf" }, undefined, undefined, ctx), {
		message: "OpenAI image authentication unavailable. Check /login openai or the configured API key.",
	});
});

test("another chat provider uses authenticated OpenAI image model mappings without Codex transport", async (t) => {
	const { tool, ctx, network, agentDir } = await fixture(t);
	Object.assign(ctx, { model: { ...ctx.model, provider: "other-chat", api: "anthropic-messages" } });
	await writeFile(join(agentDir, "pi-codex-tools.json"), JSON.stringify({ providers: {
		openai: { "gpt-image-2.5": "gateway-image-model" },
	} }));
	let request: Record<string, unknown> | undefined;
	network.get("https://gateway.invalid").intercept({ path: "/v1/images/generations", method: "POST" }).reply((options) => {
		request = JSON.parse(String(options.body));
		return { statusCode: 200, data: JSON.stringify({ data: [{ b64_json: png }] }) };
	});
	await tool.execute("fallback", { prompt: "A leaf" }, undefined, undefined, ctx);
	assert.equal(request?.model, "gateway-image-model");
	network.assertNoPendingInterceptors();
});

test("OpenAI API Key editing sends validated local images to the Images endpoint", async (t) => {
	const { tool, ctx, network, cwd } = await fixture(t);
	await writeFile(join(cwd, "source.png"), Buffer.from(png, "base64"));
	let request: unknown;
	network.get("https://gateway.invalid").intercept({ path: "/v1/images/edits", method: "POST" }).reply((options) => {
		request = JSON.parse(String(options.body));
		return { statusCode: 200, data: JSON.stringify({ data: [{ b64_json: png }] }) };
	});
	await tool.execute("edit", { prompt: "Make it blue", referenced_image_paths: ["source.png"] }, undefined, undefined, ctx);
	assert.deepEqual(request, { prompt: "Make it blue", model: "gpt-image-2.5", background: "opaque", quality: "auto", size: "auto",
		images: [{ image_url: "data:image/png;base64," + png }] });
	network.assertNoPendingInterceptors();
});

test("cross-origin redirects never forward custom provider credentials", async (t) => {
	const { tool, ctx, network } = await fixture(t);
	network.get("https://gateway.invalid").intercept({ path: "/v1/images/generations", method: "POST" })
		.reply(307, "", { headers: { location: "https://cdn.invalid/result" } });
	let headers: Headers | undefined;
	network.get("https://cdn.invalid").intercept({ path: "/result", method: "POST" }).reply((options) => {
		headers = new Headers(options.headers as Record<string, string>);
		return { statusCode: 200, data: JSON.stringify({ data: [{ b64_json: png }] }) };
	});
	await tool.execute("redirect", { prompt: "A leaf" }, undefined, undefined, ctx);
	assert.equal(headers?.get("authorization"), null);
	assert.equal(headers?.get("x-provider-key"), null);
	assert.equal(headers?.get("openai-project"), null);
	network.assertNoPendingInterceptors();
});

for (const selection of ["codex", "renamed", "configured", "fallback"] as const) {
	test(`the OpenAI adapter preserves the upstream ${selection} Codex route`, async (t) => {
		const { tool, ctx, network, agentDir } = await fixture(t);
		const legacy = { ...ctx.model!, provider: selection === "configured" ? "vendor" : selection === "renamed" ? "openai" : "openai-codex",
			api: selection === "configured" ? "openai-responses" : "openai-codex-responses" };
		Object.assign(ctx, { model: selection === "fallback" ? { ...ctx.model, provider: "other-chat", api: "anthropic-messages" } : legacy });
		ctx.modelRegistry.getAvailable = () => [legacy];
		ctx.modelRegistry.getAll = () => [legacy];
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "legacy-key",
			baseUrl: "https://codex.invalid/backend-api", headers: { "ChatGPT-Account-ID": "legacy-account" } });
		if (selection === "configured") await writeFile(join(agentDir, "pi-codex-tools.json"), JSON.stringify({ providers: { vendor: {} } }));
		let headers: Headers | undefined;
		network.get("https://codex.invalid").intercept({ path: "/backend-api/codex/images/generations", method: "POST" }).reply((options) => {
			headers = new Headers(options.headers as Record<string, string>);
			return { statusCode: 200, data: JSON.stringify({ data: [{ b64_json: png }] }) };
		});
		await tool.execute("legacy", { prompt: "A leaf" }, undefined, undefined, ctx);
		assert.equal(headers?.get("authorization"), "Bearer legacy-key");
		assert.equal(headers?.get("chatgpt-account-id"), "legacy-account");
		network.assertNoPendingInterceptors();
	});
}

test("OpenAI service rejection is not retried on legacy credentials and creates no artifacts", async (t) => {
	const { tool, ctx, network, cwd } = await fixture(t, true);
	network.get("https://gateway.invalid").intercept({ path: "/v1/responses", method: "POST" })
		.reply(401, JSON.stringify({ error: { message: "secret-account details" } }));
	await assert.rejects(tool.execute("denied", { prompt: "A leaf" }, undefined, undefined, ctx), {
		message: "Image generation access was rejected. Ask the user to check access for their configured provider.",
	});
	await assert.rejects(stat(join(cwd, ".pi/openai-codex-images")), { code: "ENOENT" });
	network.assertNoPendingInterceptors();
});

for (const incomplete of ["response", "image call"]) {
	test(`an incomplete Responses ${incomplete} does not save a partial image`, async (t) => {
		const { tool, ctx, network, cwd } = await fixture(t, true);
		network.get("https://gateway.invalid").intercept({ path: "/v1/responses", method: "POST" })
			.reply(200, { status: incomplete === "response" ? "incomplete" : "completed",
				output: [{ type: "image_generation_call", status: "in_progress", result: png }] });
		await assert.rejects(tool.execute("partial", { prompt: "A leaf" }, undefined, undefined, ctx), /did not complete/);
		await assert.rejects(stat(join(cwd, ".pi/openai-codex-images")), { code: "ENOENT" });
	});
}

function pccTools(events: ReturnType<typeof createEventBus>): CodeModeImageTool[] {
	const tools: CodeModeImageTool[] = [];
	events.emit("@howaboua/pi-codex-conversion.extension-code-mode-tools/v1", {
		refreshGates: true,
		add(provider: () => CodeModeImageTool[], active: boolean) { if (active) tools.push(...provider()); },
	});
	return tools;
}

test("PCC image projection uses Pi's nested executor and releases its registration on shutdown", async (t) => {
	const { tool, ctx, network, events, shutdown } = await fixture(t);
	const [adapted] = pccTools(events);
	assert.equal(adapted?.name, "image_gen__imagegen");
	assert.equal(adapted.topLevelName, "imagegen");
	assert.equal(adapted.deferLoading, true);
	assert.equal(adapted.discoverWhenDeferred, true);
	network.get("https://gateway.invalid").intercept({ path: "/v1/images/generations", method: "POST" })
		.reply(200, { data: [{ b64_json: png }] });
	const signal = new AbortController().signal;
	const result = await adapted.invoke({ prompt: "A leaf" }, {
		executeTool: async (name, args, options) => {
			assert.equal(name, "imagegen");
			assert.equal(options?.signal, signal);
			return { toolCall: { type: "toolCall", id: "nested", name, arguments: args as { prompt: string } },
				isError: false, result: await tool.execute("nested", args as { prompt: string }, signal, undefined, ctx) };
		},
	}, signal);
	assert.equal((result as { image_url: string }).image_url, "data:image/png;base64," + png);
	shutdown();
	assert.deepEqual(pccTools(events), []);
	network.assertNoPendingInterceptors();
});

test("PCC projection cannot bypass denied or unavailable Pi execution", async (t) => {
	const { events } = await fixture(t);
	const [adapted] = pccTools(events);
	assert.ok(adapted);
	const signal = new AbortController().signal;
	await assert.rejects(adapted.invoke({ prompt: "A leaf" }, {}, signal), /Pi nested tool executor is unavailable/);
	await assert.rejects(adapted.invoke({ prompt: "A leaf" }, {
		executeTool: async (name) => ({ toolCall: { type: "toolCall", id: "denied", name, arguments: {} },
			isError: true, result: { content: [{ type: "text", text: "Denied by policy" }], details: {} } }),
	}, signal), /Denied by policy/);
});
