import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { zstdDecompressSync } from "node:zlib";
import type { FetchFunction, Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import guardian from "../../index.js";

export interface RequestBody {
	model: string;
	input: { content?: { text: string }[] }[];
}

export interface PlannedCall {
	name: string;
	input?: Record<string, unknown>;
}

export function response(
	id: string,
	model: string,
	call?: PlannedCall,
	text = "Complete",
	terminal = "response.completed",
): Response {
	const item = call
		? {
				type: "function_call",
				id: `fc_${id}`,
				call_id: `call_${id}`,
				name: call.name,
				arguments: JSON.stringify(call.input ?? {}),
			}
		: {
				type: "message",
				id: `msg_${id}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text, annotations: [] }],
			};
	const events: Record<string, unknown>[] = [
		{
			type: "response.created",
			response: { id, model, status: "in_progress", output: [] },
		},
		{
			type: "response.output_item.added",
			output_index: 0,
			item: call ? { ...item, arguments: "" } : { ...item, content: [] },
		},
	];
	if (call) {
		events.push({
			type: "response.function_call_arguments.delta",
			item_id: item.id,
			output_index: 0,
			delta: item.arguments,
		});
	} else {
		events.push(
			{
				type: "response.content_part.added",
				item_id: item.id,
				output_index: 0,
				content_index: 0,
				part: { type: "output_text", text: "", annotations: [] },
			},
			{
				type: "response.output_text.delta",
				item_id: item.id,
				output_index: 0,
				content_index: 0,
				delta: text,
			},
		);
	}
	events.push(
		{ type: "response.output_item.done", output_index: 0, item },
		{
			type: terminal,
			response: {
				id,
				model,
				status: "completed",
				output: [item],
				usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
			},
		},
	);
	return new Response(
		events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

/** Exercises the released SDK and native Codex serializer/parser, with no sockets
 * or real credentials. Only the HTTP service is replaced. */
export async function createFixture(
	t: TestContext,
	options: {
		factories: ExtensionFactory[];
		tools: string[];
		config?: unknown;
		guardian?: boolean;
		onParent?: (
			body: RequestBody,
			index: number,
		) => Response | Promise<Response>;
		onReview?: (
			body: RequestBody,
			index: number,
		) => Response | Promise<Response>;
	},
) {
	const home = await mkdtemp(join(tmpdir(), "guardian-regression-"));
	const cwd = join(home, "work");
	const agentDir = join(home, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	t.after(async () => {
		if (previousAgentDir === undefined)
			delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
		await rm(home, { recursive: true, force: true });
	});
	if (options.config !== undefined)
		await writeFile(
			join(agentDir, "pi-codex-guardian.json"),
			JSON.stringify(options.config),
		);
	let parentCount = 0;
	let reviewCount = 0;
	const fetch: FetchFunction = async (input, init) => {
		const request = new Request(input, init);
		assert.equal(new URL(request.url).hostname, "guardian.invalid");
		const bytes = Buffer.from(await request.arrayBuffer());
		const decoded =
			request.headers.get("content-encoding") === "zstd"
				? zstdDecompressSync(bytes)
				: bytes;
		const body = JSON.parse(decoded.toString("utf8")) as RequestBody;
		if (body.model === "codex-auto-review") {
			const index = ++reviewCount;
			return (
				options.onReview?.(body, index) ??
				response(
					`resp_review${index}`,
					body.model,
					undefined,
					'{"outcome":"allow"}',
				)
			);
		}
		const index = ++parentCount;
		return (
			options.onParent?.(body, index) ??
			response(`resp_parent${index}`, body.model)
		);
	};
	const model: Model<"openai-codex-responses"> = {
		id: "gpt-6-astra",
		name: "Offline parent",
		provider: "guardian-fixture",
		api: "openai-codex-responses",
		baseUrl: "https://guardian.invalid/v1",
		reasoning: true,
		input: ["text"],
		contextWindow: 200_000,
		maxTokens: 4096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const settingsManager = SettingsManager.inMemory({
		transport: "sse",
		retry: { enabled: false },
		compaction: { enabled: false },
	});
	const token = `fixture.${Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: "offline-fixture" },
		}),
	).toString("base64url")}.fixture`;
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: "Use the requested offline fixture tools.",
		extensionFactories: [
			(pi) =>
				pi.registerProvider(model.provider, {
					api: model.api,
					apiKey: token,
					baseUrl: model.baseUrl,
					models: [model],
					streamSimple: (selected, context, streamOptions) =>
						streamSimple(
							{ ...selected, api: "openai-codex-responses" },
							context,
							{ ...streamOptions, fetch: streamOptions?.fetch ?? fetch },
						),
				}),
			...options.factories,
			...(options.guardian === false
				? []
				: ([(pi) => guardian(pi, fetch)] satisfies ExtensionFactory[])),
		],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const manager = SessionManager.inMemory(cwd);
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		modelRuntime,
		settingsManager,
		resourceLoader: loader,
		sessionManager: manager,
		thinkingLevel: "low",
		tools: options.tools,
	});
	const errors: unknown[] = [];
	t.after(async () => {
		await session.abort();
		session.dispose();
		assert.deepEqual(errors, []);
	});
	await session.bindExtensions({ onError: (error) => errors.push(error) });
	return { session, manager, model, reviewCount: () => reviewCount };
}
