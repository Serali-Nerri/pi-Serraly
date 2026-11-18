import { createHash } from "node:crypto";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import {
	namespaceResponsesLiteInputTools,
	namespaceResponsesLiteTools,
} from "./responses-lite-tools.ts";

export const RESPONSES_LITE_HEADER = "x-openai-internal-codex-responses-lite";
const RESPONSES_LITE_WS_METADATA_KEY =
	"ws_request_header_x_openai_internal_codex_responses_lite";

const IMAGE_PROCESSING_PLACEHOLDER =
	"image content omitted because it could not be processed";
const IMAGE_MAX_DIMENSION = 2048;
const IMAGE_MAX_PATCHES = 2_500;
const IMAGE_PATCH_SIZE = 32;
const IMAGE_MAX_BASE64_BYTES = 64 * 1024 * 1024;
const IMAGE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const IMAGE_CACHE_MAX_ENTRIES = 64;
const IMAGE_NORMALIZATION_CONCURRENCY = 2;
const IMAGE_TRANSFORM_IDENTITY = JSON.stringify([
	IMAGE_MAX_DIMENSION,
	IMAGE_MAX_PATCHES,
	IMAGE_PATCH_SIZE,
	IMAGE_MAX_BASE64_BYTES,
]);
const preparedImageUrls = new Map<string, { url: string; bytes: number }>();
let preparedImageBytes = 0;

export interface ResponsesLiteCompatibleBody {
	model: string;
	input: unknown[];
	instructions?: string | undefined;
	tools?: unknown[] | undefined;
	parallel_tool_calls?: boolean | undefined;
	reasoning?: unknown | undefined;
	client_metadata?: Record<string, string> | undefined;
	[key: string]: unknown;
}

export function isResponsesLiteRequest(
	body: ResponsesLiteCompatibleBody,
): boolean {
	return (
		body.instructions === undefined &&
		body.tools === undefined &&
		isRecord(body.input[0]) &&
		body.input[0]["type"] === "additional_tools"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function prepareLiteContent(content: unknown): unknown {
	if (!Array.isArray(content)) return content;
	return content.map((item) => {
		if (!isRecord(item) || item["type"] !== "input_image") return item;
		const imageUrl = item["image_url"];
		if (typeof imageUrl === "string" && /^https?:\/\//i.test(imageUrl)) {
			return {
				type: "input_text",
				text: "image content omitted because remote image URLs are not supported",
			};
		}
		const { detail: _detail, ...image } = item;
		return image;
	});
}

function prepareLiteInput(input: readonly unknown[]): unknown[] {
	const prepared = input.map((item) => {
		if (!isRecord(item)) return item;
		if (
			item["type"] === "message" ||
			item["role"] === "user" ||
			item["role"] === "developer" ||
			item["role"] === "system"
		) {
			return { ...item, content: prepareLiteContent(item["content"]) };
		}
		if (
			(item["type"] === "function_call_output" ||
				item["type"] === "custom_tool_call_output") &&
			isRecord(item["output"])
		) {
			return {
				...item,
				output: {
					...item["output"],
					content: prepareLiteContent(item["output"]["content"]),
				},
			};
		}
		if (
			(item["type"] === "function_call_output" ||
				item["type"] === "custom_tool_call_output") &&
			Array.isArray(item["output"])
		) {
			return { ...item, output: prepareLiteContent(item["output"]) };
		}
		return item;
	});
	return namespaceResponsesLiteInputTools(prepared);
}

function cachedDataImageUrl(key: string): string | undefined {
	const cached = preparedImageUrls.get(key);
	if (!cached) return undefined;
	preparedImageUrls.delete(key);
	preparedImageUrls.set(key, cached);
	return cached.url;
}

async function prepareDataImageUrl(
	imageUrl: string,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	signal?.throwIfAborted();
	// Keep only a digest of the source; retaining full data-URL keys doubles the cache.
	const key = createHash("sha256")
		.update(IMAGE_TRANSFORM_IDENTITY)
		.update(imageUrl)
		.digest("base64url");
	const cached = cachedDataImageUrl(key);
	if (cached) return cached;
	const match = /^data:([^;,]+);base64,([a-z0-9+/]*={0,2})$/i.exec(imageUrl);
	if (!match?.[1] || !match[2] || !match[1].toLowerCase().startsWith("image/"))
		return undefined;
	if (Buffer.byteLength(match[2], "utf8") > IMAGE_MAX_BASE64_BYTES)
		return undefined;
	try {
		const bytes = Buffer.from(match[2], "base64");
		if (bytes.length === 0) return undefined;
		let resized = await resizeImage(bytes, match[1], {
			maxWidth: IMAGE_MAX_DIMENSION,
			maxHeight: IMAGE_MAX_DIMENSION,
			maxBytes: IMAGE_MAX_BASE64_BYTES,
		});
		signal?.throwIfAborted();
		if (!resized) return undefined;
		const patches =
			Math.ceil(resized.width / IMAGE_PATCH_SIZE) *
			Math.ceil(resized.height / IMAGE_PATCH_SIZE);
		if (patches > IMAGE_MAX_PATCHES) {
			const scale = Math.sqrt(IMAGE_MAX_PATCHES / patches);
			resized = await resizeImage(bytes, match[1], {
				maxWidth: Math.max(1, Math.floor(resized.width * scale)),
				maxHeight: Math.max(1, Math.floor(resized.height * scale)),
				maxBytes: IMAGE_MAX_BASE64_BYTES,
			});
			signal?.throwIfAborted();
		}
		if (!resized) return undefined;
		const completed = cachedDataImageUrl(key);
		if (completed) return completed;
		const url = `data:${resized.mimeType};base64,${resized.data}`;
		const size = Buffer.byteLength(url, "utf8");
		if (size <= IMAGE_CACHE_MAX_BYTES) {
			while (
				preparedImageUrls.size >= IMAGE_CACHE_MAX_ENTRIES ||
				preparedImageBytes + size > IMAGE_CACHE_MAX_BYTES
			) {
				const oldest = preparedImageUrls.entries().next().value;
				if (!oldest) break;
				preparedImageUrls.delete(oldest[0]);
				preparedImageBytes -= oldest[1].bytes;
			}
			preparedImageUrls.set(key, { url, bytes: size });
			preparedImageBytes += size;
		}
		return url;
	} catch {
		signal?.throwIfAborted();
		return undefined;
	}
}

async function prepareResponsesLiteInputImages(
	input: readonly unknown[],
	signal: AbortSignal | undefined,
): Promise<unknown[]> {
	signal?.throwIfAborted();
	const contents: unknown[][] = [];
	const prepareContent = (content: unknown): unknown => {
		if (!Array.isArray(content)) return content;
		const prepared = [...content];
		contents.push(prepared);
		return prepared;
	};
	const prepared = input.map((item) => {
		if (!isRecord(item)) return item;
		if (
			(item["type"] === "message" ||
				item["role"] === "user" ||
				item["role"] === "developer" ||
				item["role"] === "system") &&
			"content" in item
		) {
			return { ...item, content: prepareContent(item["content"]) };
		}
		if (
			(item["type"] === "function_call_output" ||
				item["type"] === "custom_tool_call_output") &&
			isRecord(item["output"])
		) {
			return {
				...item,
				output: {
					...item["output"],
					content: prepareContent(item["output"]["content"]),
				},
			};
		}
		if (
			(item["type"] === "function_call_output" ||
				item["type"] === "custom_tool_call_output") &&
			Array.isArray(item["output"])
		) {
			return { ...item, output: prepareContent(item["output"]) };
		}
		return item;
	});
	const images = (function* () {
		for (const content of contents) {
			for (let index = 0; index < content.length; index++) {
				const item = content[index];
				if (
					!isRecord(item) ||
					item["type"] !== "input_image" ||
					typeof item["image_url"] !== "string"
				)
					continue;
				if (/^data:/i.test(item["image_url"]))
					yield { content, index, item, imageUrl: item["image_url"] };
			}
		}
	})();
	// Each request pulls its own next image instead of retaining a global per-image
	// queue. Cancellation stops admission without blocking another request's pool.
	await Promise.all(
		Array.from({ length: IMAGE_NORMALIZATION_CONCURRENCY }, async () => {
			for (const image of images) {
				signal?.throwIfAborted();
				const imageUrl = await prepareDataImageUrl(image.imageUrl, signal);
				signal?.throwIfAborted();
				image.content[image.index] = imageUrl
					? { ...image.item, image_url: imageUrl }
					: { type: "input_text", text: IMAGE_PROCESSING_PLACEHOLDER };
			}
		}),
	);
	signal?.throwIfAborted();
	return prepared;
}

export async function prepareResponsesLiteConversationInput(
	input: readonly unknown[],
	signal?: AbortSignal,
): Promise<unknown[]> {
	return prepareResponsesLiteInputImages(prepareLiteInput(input), signal);
}

export async function prepareResponsesLiteRequestImages<
	TBody extends ResponsesLiteCompatibleBody,
>(body: TBody, signal?: AbortSignal): Promise<TBody> {
	return {
		...body,
		input: await prepareResponsesLiteInputImages(body.input, signal),
	};
}

export function applyResponsesLiteRequest<
	TBody extends ResponsesLiteCompatibleBody,
>(body: TBody): TBody {
	const instructions = body.instructions;
	const tools = [...(body.tools ?? [])];
	const prefix: unknown[] = [
		{
			type: "additional_tools",
			role: "developer",
			tools: namespaceResponsesLiteTools(tools),
		},
		...(instructions !== undefined && instructions.length > 0
			? [
					{
						type: "message",
						role: "developer",
						content: [{ type: "input_text", text: instructions }],
					},
				]
			: []),
	];
	const { instructions: _instructions, tools: _tools, ...rest } = body;
	return {
		...rest,
		input: [...prefix, ...prepareLiteInput(body.input)],
		parallel_tool_calls: false,
		reasoning: {
			...(isRecord(body.reasoning) ? body.reasoning : {}),
			context: "all_turns",
		},
	} as TBody;
}

export function namespaceExistingResponsesLiteRequest<
	TBody extends ResponsesLiteCompatibleBody,
>(body: TBody): TBody {
	return { ...body, input: namespaceResponsesLiteInputTools(body.input) };
}

export function applyResponsesLiteWebSocketMetadata<
	TBody extends ResponsesLiteCompatibleBody,
>(body: TBody): TBody & { client_metadata: Record<string, string> } {
	return {
		...body,
		client_metadata: {
			...(body.client_metadata ?? {}),
			[RESPONSES_LITE_WS_METADATA_KEY]: "true",
		},
	};
}
