import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { hasOnlyResultAppends } from "./branch.js";
import { type ParentEvidence, projectEvidence } from "./evidence.js";
import { parseSuccessfulResponseEvent } from "./response.js";
import {
	CODEX_ENDPOINT,
	isRecord,
	MAX_REVIEW_BYTES,
	REVIEW_MODEL,
	serializeReview,
} from "./review.js";

interface Parent {
	responseId: string;
	model: Model<Api>;
	sessionId: string;
	contextLeaf: string | null;
	context: ParentEvidence;
	bytes: number;
	branchCheck?: { leafId: string | null; present: boolean };
}

interface PendingParent {
	model: Model<Api>;
	sessionId: string;
	contextLeaf: string | null;
	context: ParentEvidence;
	bytes: number;
	completedId?: string;
}

export function reviewUnavailableReason(
	ctx: ExtensionContext,
): string | undefined {
	if (!ctx.model) return "No model selected";
	if (ctx.model.api !== "openai-codex-responses")
		return "Selected model does not use the Codex Responses API";
	if (!ctx.modelRegistry.getProviderAuthStatus(ctx.model.provider).configured)
		return "Selected connection has no configured authentication";
	return undefined;
}

/** Credit eligibility is narrower than the ability to ask for an assessment. */
export function nativeCreditEligible(ctx: ExtensionContext): boolean {
	if (!ctx.model || reviewUnavailableReason(ctx)) return false;
	const provider = ctx.modelRegistry.getProvider(ctx.model.provider);
	const endpoints = [
		"https://chatgpt.com/backend-api",
		"https://chatgpt.com/backend-api/codex",
		CODEX_ENDPOINT,
	];
	if (
		![ctx.model.baseUrl, provider?.baseUrl].every((base) =>
			endpoints.includes(base?.replace(/\/+$/, "") ?? ""),
		)
	)
		return false;
	if (
		!ctx.modelRegistry.isUsingOAuth(ctx.model) ||
		ctx.modelRegistry.getProviderAuthStatus(ctx.model.provider).source !==
			"stored"
	)
		return false;
	const override = ctx.modelRegistry.getRegisteredProviderConfig(
		ctx.model.provider,
	);
	// Match Codex's native-backend eligibility, not just an OAuth-looking model URL.
	// An API-key handler includes configured keys, environment auth and cloud credentials.
	if (
		!provider?.auth.oauth?.isSubscription ||
		provider.auth.apiKey ||
		override?.oauth ||
		override?.streamSimple
	)
		return false;
	return true;
}

function supportsParent(
	ctx: ExtensionContext,
): ctx is ExtensionContext & { model: Model<Api> } {
	return reviewUnavailableReason(ctx) === undefined;
}

/** Only live, observed parent responses. Never restore response IDs from session history. */
export class ParentBindings {
	private requestPrepared = false;
	private pending: PendingParent | undefined;
	private readonly byCall = new Map<string, Parent>();
	private retainedBytes = 0;
	contextUnavailable = false;

	clear(): void {
		this.requestPrepared = false;
		this.pending = undefined;
		this.byCall.clear();
		this.retainedBytes = 0;
		this.contextUnavailable = false;
	}

	register(
		pi: ExtensionAPI,
		isEnabled: (ctx: ExtensionContext) => boolean,
	): void {
		pi.on("context_with_system", (_event, ctx) => {
			this.pending = undefined;
			this.requestPrepared = isEnabled(ctx);
			this.contextUnavailable = false;
		});
		pi.on("before_provider_request", (event, ctx) => {
			this.pending = undefined;
			if (!isRecord(event.payload)) return;
			const payload = event.payload;
			const existingMetadata = isRecord(payload["client_metadata"]);
			const metadata = {
				...(isRecord(payload["client_metadata"])
					? payload["client_metadata"]
					: {}),
			};
			delete metadata["guardian_credits_requested"];
			delete metadata["parent_response_id"];
			if (!isEnabled(ctx)) {
				if (existingMetadata) payload["client_metadata"] = metadata;
				return;
			}
			// Codex excludes Guardian's own basic/reviewer sessions from earning parent credits.
			const reviewer =
				payload["model"] === REVIEW_MODEL ||
				metadata["x-openai-subagent"] === "guardian";
			payload["client_metadata"] = metadata;
			if (reviewer || !supportsParent(ctx)) return;
			if (nativeCreditEligible(ctx))
				metadata["guardian_credits_requested"] = "true";
			// No synthetic parent linkage on ordinary requests.
			if (!this.requestPrepared || payload["model"] !== ctx.model.id) return;
			this.requestPrepared = false;
			try {
				const context = projectEvidence(payload);
				this.pending = {
					model: structuredClone(ctx.model),
					sessionId: ctx.sessionManager.getSessionId(),
					contextLeaf: ctx.sessionManager.getLeafId(),
					context,
					bytes: Buffer.byteLength(
						serializeReview(context, 2 * MAX_REVIEW_BYTES),
						"utf8",
					),
				};
			} catch {
				this.contextUnavailable = true;
			}
		});
		pi.on("provider_stream_event", (event, ctx) => {
			const pending = this.pending;
			if (
				!isEnabled(ctx) ||
				!pending ||
				!supportsParent(ctx) ||
				pending.sessionId !== ctx.sessionManager.getSessionId() ||
				event.provider !== pending.model.provider ||
				event.api !== pending.model.api ||
				event.model !== pending.model.id
			)
				return;
			const response = parseSuccessfulResponseEvent(event.data);
			if (response) pending.completedId = response.id;
		});
		pi.on("message_end", (event, ctx) => {
			const message = event.message;
			const pending = this.pending;
			if (message.role !== "assistant" || !pending) return;
			this.pending = undefined;
			if (
				!isEnabled(ctx) ||
				!supportsParent(ctx) ||
				!message.responseId ||
				message.responseId !== pending.completedId ||
				message.stopReason !== "toolUse" ||
				message.provider !== pending.model.provider ||
				message.api !== pending.model.api ||
				message.model !== pending.model.id ||
				pending.sessionId !== ctx.sessionManager.getSessionId()
			)
				return;
			const toolCalls = new Set(
				message.content
					.filter((item) => item.type === "toolCall")
					.map((item) => item.id),
			);
			if (!toolCalls.size || toolCalls.size > 128) return;
			// Retire oldest bindings, rather than making every subsequent action fail.
			while (
				this.byCall.size + toolCalls.size > 128 ||
				this.retainedBytes + pending.bytes > 8 * MAX_REVIEW_BYTES
			) {
				const oldest = this.byCall.values().next().value;
				if (!oldest) return;
				for (const [id, parent] of this.byCall)
					if (parent === oldest) this.byCall.delete(id);
				this.retainedBytes -= oldest.bytes;
			}
			const parent: Parent = { ...pending, responseId: message.responseId };
			this.retainedBytes += parent.bytes;
			for (const id of toolCalls) this.byCall.set(id, parent);
		});
	}

	resolve(
		callId: string | undefined,
		ctx: ExtensionContext,
	): Parent | undefined {
		const parent = callId ? this.byCall.get(callId) : undefined;
		if (
			!parent ||
			!supportsParent(ctx) ||
			parent.sessionId !== ctx.sessionManager.getSessionId() ||
			parent.model.provider !== ctx.model.provider ||
			parent.model.api !== ctx.model.api ||
			parent.model.id !== ctx.model.id ||
			parent.model.baseUrl !== ctx.model.baseUrl
		)
			return;
		const leafId = ctx.sessionManager.getLeafId();
		if (parent.branchCheck?.leafId !== leafId) {
			parent.branchCheck = {
				leafId,
				present:
					hasOnlyResultAppends(ctx.sessionManager, parent.contextLeaf) &&
					ctx.sessionManager
						.getBranch()
						.some(
							(entry) =>
								entry.type === "message" &&
								entry.message.role === "assistant" &&
								entry.message.responseId === parent.responseId,
						),
			};
		}
		return parent.branchCheck.present ? parent : undefined;
	}

	// Native nested calls can themselves invoke Pi tools. Bind only admitted calls.
	admitted(callId: string, parent: Parent): void {
		if (this.byCall.size < 128) this.byCall.set(callId, parent);
	}
}
