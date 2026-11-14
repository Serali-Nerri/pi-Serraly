import { randomUUID } from "node:crypto";
import { arch, release, type } from "node:os";

/** Stable handshake identity; per-action attribution travels in the request body. */
export function reviewerWire(
	threadId: string,
	parentThreadId: string,
	parentResponseId: string,
) {
	const turnId = randomUUID();
	const windowId = `${threadId}:0`;
	const turnMetadata = JSON.stringify({
		session_id: threadId,
		thread_id: threadId,
		agent_name: "guardian",
		turn_id: turnId,
		window_id: windowId,
		window_number: 0,
		context_window_id: threadId,
		request_kind: "turn",
		turn_trigger: "guardian_review",
		parent_thread_id: parentThreadId,
		sandbox: "none",
		sandbox_mode: "danger-full-access",
		auto_review_enabled: false,
		node_repl_auto_review_required: false,
		node_repl_disabled: true,
		turn_started_at_unix_ms: Date.now(),
		history_ingest_requested: false,
		analytics_enabled: false,
	});
	const requestHeaders: Record<string, string | null> = {
		originator: "codex_cli_rs",
		"user-agent":
			`codex_cli_rs (${type()} ${release()}; ${arch()}) pi-codex-guardian`.replace(
				/[^\x20-\x7e]/g,
				"_",
			),
		"x-codex-guardian": "reviewer",
		"x-openai-subagent": "guardian",
		"session-id": threadId,
		"thread-id": threadId,
		"x-client-request-id": threadId,
		"x-codex-window-id": windowId,
		"x-codex-parent-thread-id": parentThreadId,
	};
	for (const key of [
		"x-codex-routing-hint",
		"x-codex-turn-state",
		"x-codex-beta-features",
		"x-oai-attestation",
		"x-codex-installation-id",
		"x-openai-internal-codex-responses-lite",
		"x-openai-memgen-request",
		"response-session-id",
		"x-codex-inference-call-id",
		"traceparent",
		"tracestate",
		"baggage",
		"x-codex-turn-metadata",
	])
		requestHeaders[key] = null;
	return {
		threadId,
		requestHeaders,
		promptCacheKey: `guardian:${parentThreadId}`,
		clientMetadata: {
			session_id: threadId,
			thread_id: threadId,
			turn_id: turnId,
			"x-codex-window-id": windowId,
			"x-codex-turn-metadata": turnMetadata,
			"x-codex-parent-thread-id": parentThreadId,
			"x-openai-subagent": "guardian",
			parent_response_id: parentResponseId,
		},
		headers(outgoing: Headers): Headers {
			const headers = new Headers(outgoing);
			for (const [key, value] of Object.entries(requestHeaders)) {
				if (value === null) headers.delete(key);
				else headers.set(key, value);
			}
			headers.delete("openai-beta");
			headers.delete("x-responsesapi-include-timing-metrics");
			headers.set("accept", "text/event-stream");
			headers.set("content-type", "application/json");
			return headers;
		},
	};
}
