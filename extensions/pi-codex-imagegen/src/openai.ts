import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveHostedCodexToolProvider } from "./codex-runtime/policy.js";
import type { CodexToolProvider } from "./codex-runtime/types.js";
import type { ImageResponse } from "./contract.js";
import type { buildImageGenerationRequest } from "./request.js";

export function isOpenAIResponses(model: ExtensionContext["model"]): boolean {
	return model?.provider === "openai" && model.api === "openai-responses";
}

export class OpenAIImageAuthError extends Error {
	constructor() {
		super("OpenAI image authentication unavailable. Check /login openai or the configured API key.");
	}
}

export async function resolveImagegenProvider(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<CodexToolProvider | undefined> {
	const model = isOpenAIResponses(ctx.model)
		? ctx.model
		: ctx.model?.api === "openai-codex-responses" || ctx.model?.provider === "openai-codex"
			? undefined
			: ctx.modelRegistry.getAvailable().find(isOpenAIResponses);
	if (!model) return resolveHostedCodexToolProvider(pi, ctx);
	let auth;
	try { auth = await ctx.modelRegistry.getApiKeyAndHeaders(model); }
	catch { throw new OpenAIImageAuthError(); }
	if (!auth.ok) throw new OpenAIImageAuthError();
	const headers = Object.fromEntries(Object.entries(auth.headers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
	const authorization = new Headers(headers).get("authorization");
	const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? auth.apiKey;
	if (!token) throw new OpenAIImageAuthError();
	const baseUrl = (auth.baseUrl ?? model.baseUrl)?.trim().replace(/\/+$/, "").replace(/\/responses$/, "");
	if (!baseUrl) throw new Error("OpenAI image provider is missing a base URL");
	return {
		authProvider: "openai", route: ctx.modelRegistry.isUsingOAuth(model) ? "openai-responses" : "configured-responses", baseUrl,
		responsesUrl: baseUrl + "/responses", searchUrl: "", model: model.id,
		token, accountId: "", headers,
	};
}

export function openAIResponsesImageRequest(
	provider: CodexToolProvider,
	request: Awaited<ReturnType<typeof buildImageGenerationRequest>>,
): Record<string, unknown> {
	const { prompt, images, ...imageOptions } = request.body;
	return {
		model: provider.model, store: false, stream: false,
		input: [{ role: "user", content: [
			{ type: "input_text", text: prompt },
			...((images ?? []) as Array<{ image_url: string }>).map((image) => ({
				type: "input_image", image_url: image.image_url,
			})),
		] }],
		tools: [{ type: "image_generation", ...imageOptions,
			action: request.operation === "edits" ? "edit" : "generate", output_format: "png" }],
		tool_choice: { type: "image_generation" },
	};
}

export function parseOpenAIImageResponse(text: string): ImageResponse {
	let response;
	try { response = JSON.parse(text); }
	catch { throw new Error("failed to decode OpenAI image response"); }
	if (!response || typeof response !== "object" ||
		(response.status && response.status !== "completed") || !Array.isArray(response.output))
		throw new Error("OpenAI image response did not complete");
	const calls = response.output.filter((item: unknown) => item && typeof item === "object" &&
		"type" in item && item.type === "image_generation_call") as Array<Record<string, unknown>>;
	if (calls.some((call) => call.status && call.status !== "completed"))
		throw new Error("OpenAI image generation did not complete");
	if (calls.length === 0 || calls.some((call) => typeof call.result !== "string" || !call.result))
		throw new Error("OpenAI response returned no image data");
	const first = calls[0]!;
	return {
		data: calls.map((call) => ({ b64_json: call.result as string })),
		background: typeof first.background === "string" ? first.background : undefined,
		quality: typeof first.quality === "string" ? first.quality : undefined,
		size: typeof first.size === "string" ? first.size : undefined,
	};
}
