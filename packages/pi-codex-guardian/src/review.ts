import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { zstdDecompressSync } from "node:zlib";
import {
	type Api,
	cleanupSessionResources,
	type FetchFunction,
	type Model,
	type Transport,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ParentEvidence } from "./evidence.js";
import { POLICY } from "./policy.js";
import { isRecord, parseSuccessfulResponseEvent } from "./response.js";
import { reviewerWire } from "./wire.js";

export { isRecord } from "./response.js";

export const CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
export const REVIEW_MODEL = "codex-auto-review";
const REVIEW_TIMEOUT_MS = 30_000;
// UTF-8 bytes are a conservative token bound. Never trim authorization or actions.
export const MAX_REVIEW_BYTES = 96 * 1024;

// Matches Codex's Guardian assessment schema, with its optional fields.
const OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		risk_level: { type: "string", enum: ["low", "medium", "high", "critical"] },
		user_authorization: {
			type: "string",
			enum: ["unknown", "low", "medium", "high"],
		},
		outcome: { type: "string", enum: ["allow", "deny"] },
		rationale: { type: "string" },
	},
	required: ["outcome"],
};

export class ReviewFailure extends Error {
	readonly kind:
		| "context"
		| "unavailable"
		| "cancelled"
		| "timeout"
		| "malformed";
	readonly httpStatus: number | undefined;
	constructor(kind: ReviewFailure["kind"], httpStatus?: number) {
		super(kind);
		this.kind = kind;
		this.httpStatus = httpStatus;
	}
}

export function serializeReview(
	value: unknown,
	limit = MAX_REVIEW_BYTES,
): string {
	let result: string | undefined;
	try {
		result = JSON.stringify(value);
	} catch {
		throw new ReviewFailure("context");
	}
	if (result === undefined || Buffer.byteLength(result, "utf8") > limit)
		throw new ReviewFailure("context");
	return result;
}

/** Reject values JSON would silently omit or change before presenting an action. */
export function serializeAction(action: ReviewRequest["action"]): string {
	const visiting = new Set<object>();
	const check = (value: unknown): void => {
		if (
			value === null ||
			typeof value === "string" ||
			typeof value === "boolean"
		)
			return;
		if (typeof value === "number" && Number.isFinite(value)) return;
		if (typeof value !== "object" || visiting.has(value))
			throw new ReviewFailure("context");
		if (
			!Array.isArray(value) &&
			Object.getPrototypeOf(value) !== Object.prototype &&
			Object.getPrototypeOf(value) !== null
		)
			throw new ReviewFailure("context");
		if (
			Array.isArray(value) &&
			(Object.keys(value).length !== value.length ||
				Object.keys(value).some(
					(key) =>
						String(Number(key)) !== key ||
						!Number.isInteger(Number(key)) ||
						Number(key) < 0 ||
						Number(key) >= value.length,
				))
		)
			throw new ReviewFailure("context");
		visiting.add(value);
		for (const key of Reflect.ownKeys(value)) {
			if (Array.isArray(value) && key === "length") continue;
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (
				typeof key !== "string" ||
				!descriptor?.enumerable ||
				!("value" in descriptor)
			)
				throw new ReviewFailure("context");
			check(descriptor.value);
		}
		visiting.delete(value);
	};
	try {
		check(action);
		return serializeReview(action);
	} catch {
		throw new ReviewFailure("context");
	}
}

export interface Assessment {
	outcome: "allow" | "deny";
	inputTokens: number;
	outputTokens: number;
}

interface ReviewRequest {
	ctx: ExtensionContext;
	fetch: FetchFunction;
	model: Model<Api>;
	parentThreadId: string;
	parentResponseId: string;
	context: ParentEvidence;
	action: { toolName: string; input: unknown; toolCallId: string; cwd: string };
	signal: AbortSignal;
	transport: Transport;
}

function parseAssessment(text: string): "allow" | "deny" {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new ReviewFailure("malformed");
	}
	if (
		!isRecord(value) ||
		(value["outcome"] !== "allow" && value["outcome"] !== "deny")
	)
		throw new ReviewFailure("malformed");
	const allowed = new Set(Object.keys(OUTPUT_SCHEMA.properties));
	if (Object.keys(value).some((key) => !allowed.has(key)))
		throw new ReviewFailure("malformed");
	for (const [key, valid] of [
		["risk_level", OUTPUT_SCHEMA.properties.risk_level.enum],
		["user_authorization", OUTPUT_SCHEMA.properties.user_authorization.enum],
	] as const) {
		if (
			key in value &&
			(typeof value[key] !== "string" || !valid.includes(value[key]))
		)
			throw new ReviewFailure("malformed");
	}
	if ("rationale" in value && typeof value["rationale"] !== "string")
		throw new ReviewFailure("malformed");
	return value["outcome"];
}

interface ReviewerState {
	threadId: string;
	parentThreadId: string;
	model: Model<Api>;
	evidence?: ParentEvidence;
	input: unknown[];
}

function reviewBody(wire: ReturnType<typeof reviewerWire>, input: unknown[]) {
	return {
		model: REVIEW_MODEL,
		instructions: POLICY,
		input,
		tools: [],
		tool_choice: "none",
		parallel_tool_calls: false,
		stream: true,
		store: false,
		reasoning: { effort: "low" },
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: wire.promptCacheKey,
		client_metadata: wire.clientMetadata,
		text: {
			format: {
				type: "json_schema",
				name: "codex_output_schema",
				strict: false,
				schema: OUTPUT_SCHEMA,
			},
		},
	};
}

/** One serialized reviewer lane. Pi owns socket continuation and transport recovery. */
export class Reviewer {
	private state: ReviewerState | undefined;
	private queue = Promise.resolve();

	clear(): void {
		if (this.state) cleanupSessionResources(this.state.threadId);
		this.state = undefined;
	}

	async review(request: ReviewRequest): Promise<Assessment> {
		const deadline = new AbortController();
		const signal = AbortSignal.any([request.signal, deadline.signal]);
		const timer = setTimeout(() => deadline.abort(), REVIEW_TIMEOUT_MS);
		let onAbort = () => {};
		const aborted = new Promise<never>((_resolve, reject) => {
			onAbort = () =>
				reject(
					new ReviewFailure(deadline.signal.aborted ? "timeout" : "cancelled"),
				);
			signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			if (signal.aborted) throw new ReviewFailure("cancelled");
			const operation = this.queue.then(() => this.run(request, signal));
			this.queue = operation.then(
				() => {},
				() => {},
			);
			return await Promise.race([operation, aborted]);
		} finally {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			deadline.abort();
		}
	}

	private async run(
		request: ReviewRequest,
		signal: AbortSignal,
	): Promise<Assessment> {
		signal.throwIfAborted();
		const limit = Math.min(
			MAX_REVIEW_BYTES,
			request.model.contextWindow - 2048,
		);
		const evidence = { ...request.context, items: [...request.context.items] };
		const prior = this.state;
		if (
			prior &&
			(prior.parentThreadId !== request.parentThreadId ||
				!isDeepStrictEqual(prior.model, request.model) ||
				prior.evidence?.instructions !== evidence.instructions ||
				!prior.evidence.items.every((item, index) =>
					isDeepStrictEqual(item, evidence.items[index]),
				))
		)
			this.clear();
		const prepare = () => {
			const state = (this.state ??= {
				threadId: randomUUID(),
				parentThreadId: request.parentThreadId,
				model: structuredClone(request.model),
				input: [],
			});
			const text = serializeReview(
				{
					context_mode: state.evidence ? "append" : "snapshot",
					parent_context: {
						...(state.evidence ? {} : { instructions: evidence.instructions }),
						items: evidence.items.slice(state.evidence?.items.length ?? 0),
						omitted: evidence.omitted,
					},
					pending_action: request.action,
				},
				Infinity,
			);
			const wire = reviewerWire(
				state.threadId,
				request.parentThreadId,
				request.parentResponseId,
			);
			const input = [
				...state.input,
				{ role: "user", content: [{ type: "input_text", text }] },
			];
			return { state, wire, body: reviewBody(wire, input) };
		};
		let prepared = prepare();
		if (Buffer.byteLength(JSON.stringify(prepared.body), "utf8") > limit) {
			this.clear();
			prepared = prepare();
		}
		// Fit the fully framed snapshot, including escaped evidence and exact action.
		while (Buffer.byteLength(JSON.stringify(prepared.body), "utf8") > limit) {
			const optional = evidence.items.findIndex(
				(item) => item.kind === "assistant" || item.kind === "tool",
			);
			if (optional < 0) {
				this.clear();
				throw new ReviewFailure("context");
			}
			evidence.items.splice(optional, 1);
			evidence.omitted++;
			prepared = prepare();
		}
		const { state, wire, body } = prepared;
		try {
			const expectedBody: unknown = JSON.parse(serializeReview(body, limit));
			let endpoint: string | undefined;
			let completed: { id: string; output: unknown[] } | undefined;
			let failure: ReviewFailure | undefined;
			const guardianFetch: FetchFunction = async (input, init) => {
				signal.throwIfAborted();
				const outgoing = new Request(input, init);
				if (outgoing.url !== endpoint || outgoing.method !== "POST")
					throw new ReviewFailure("unavailable");
				const bytes = Buffer.from(await outgoing.clone().arrayBuffer());
				if (bytes.length > limit) throw new ReviewFailure("context");
				const encoding = outgoing.headers.get("content-encoding");
				if (encoding && encoding !== "zstd")
					throw new ReviewFailure("unavailable");
				const decoded =
					encoding === "zstd"
						? zstdDecompressSync(bytes, { maxOutputLength: limit })
						: bytes;
				if (
					!isDeepStrictEqual(JSON.parse(decoded.toString("utf8")), expectedBody)
				)
					throw new ReviewFailure("unavailable");
				const response = await request.fetch(
					new Request(outgoing, {
						headers: wire.headers(outgoing.headers),
						signal,
						redirect: "error",
					}),
				);
				if (!response.ok) {
					failure = new ReviewFailure("unavailable", response.status);
					void response.body?.cancel().catch(() => undefined);
					throw failure;
				}
				return response;
			};
			// Keep the parent's provider/endpoint/auth selection. Never redirect gateway credentials to ChatGPT.
			const model = { ...request.model, id: REVIEW_MODEL, name: "Guardian" };
			const stream = request.ctx.modelRegistry.streamSimple(
				model,
				{
					systemPrompt: POLICY,
					messages: [],
					tools: [],
				},
				{
					signal,
					transport: request.transport,
					maxRetries: 0,
					timeoutMs: REVIEW_TIMEOUT_MS,
					sessionId: state.threadId,
					reasoning: "low",
					toolChoice: "none",
					headers: wire.requestHeaders,
					fetch: guardianFetch,
					onPayload: (_payload, effectiveModel) => {
						signal.throwIfAborted();
						const base = effectiveModel.baseUrl.replace(/\/+$/, "");
						endpoint = base.endsWith("/codex/responses")
							? base
							: `${base}${base.endsWith("/codex") ? "" : "/codex"}/responses`;
						return body;
					},
					onProviderStreamEvent: (data) => {
						const response = parseSuccessfulResponseEvent(data);
						if (
							response &&
							Array.isArray(response.output) &&
							response.output.every(
								(item: unknown) =>
									isRecord(item) &&
									(item["type"] === "reasoning" || item["type"] === "message"),
							)
						)
							completed = {
								id: response.id,
								output: structuredClone(response.output),
							};
					},
				},
			);
			const result = await stream.result();
			signal.throwIfAborted();
			if (
				this.state !== state ||
				!endpoint ||
				!completed ||
				result.responseId !== completed.id ||
				result.stopReason !== "stop" ||
				result.model !== REVIEW_MODEL ||
				result.content.some(
					(item) => item.type !== "text" && item.type !== "thinking",
				)
			)
				throw failure ?? new ReviewFailure("unavailable");
			const text = result.content
				.filter((item) => item.type === "text")
				.map((item) => item.text)
				.join("");
			if (Buffer.byteLength(text, "utf8") > 8192)
				throw new ReviewFailure("malformed");
			const outcome = parseAssessment(text);
			state.evidence = evidence;
			state.input = [...body.input, ...completed.output];
			if (Buffer.byteLength(JSON.stringify(state.input), "utf8") > limit)
				this.clear();
			return {
				outcome,
				inputTokens:
					result.usage.input + result.usage.cacheRead + result.usage.cacheWrite,
				outputTokens: result.usage.output,
			};
		} catch (error) {
			if (this.state === state) this.clear();
			throw error;
		}
	}
}
