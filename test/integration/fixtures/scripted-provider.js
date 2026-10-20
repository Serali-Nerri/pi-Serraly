import { appendFileSync, readFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { questionArgs } from "./contracts.mjs";

export function report(phase, extra = {}) {
	appendFileSync(process.env.SERRALY_REPORT, JSON.stringify({ phase, ...extra }) + "\n");
}

// All calls use compiled tools. Invalid Agent/StopAgent calls exercise their
// real schema/error/rendering boundaries without creating child sessions.
export function registerScriptedProvider(pi, state) {
	const config = JSON.parse(readFileSync(process.env.SERRALY_CONFIG, "utf8"));
	pi.registerProvider("serraly-fixture", {
		api: "serraly-scripted", apiKey: "synthetic-not-a-secret", baseUrl: "https://example.invalid",
		models: [{ id: "fixture", name: "Synthetic integration provider", reasoning: false, input: ["text"],
			contextWindow: 32768, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model, context, options) {
			state.providerCalls = (state.providerCalls || 0) + 1;
			// Pi keeps the rendered system prompt as the leading system message.
			const system = context.messages?.find((message) => message.role === "system");
			state.lastSystemPrompt = context.systemPrompt || (system ? JSON.stringify(system) : "");
			const stream = createAssistantMessageEventStream();
			const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
				timestamp: Date.now(), content: [], stopReason: "pending",
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			queueMicrotask(async () => {
				try {
					const payload = await options?.onPayload?.({ fixture: true }, model);
					await options?.onResponse?.({ status: 200, headers: new Headers({ "x-fixture": "local" }) }, model);
					await options?.onProviderStreamEvent?.({ type: "synthetic-fixture", payload: payload ?? { fixture: true } }, model);
					const results = context.messages.filter((item) => item.role === "toolResult");
					const plan = config.tui ? [
						{ name: "read", arguments: { path: "seed.txt" } },
						{ name: "ask_user_question", arguments: questionArgs },
						{ name: "bg_status", arguments: {} },
						{ name: "Agent", arguments: { prompt: "fixture", agent: "no-such-agent" } },
						{ name: "StopAgent", arguments: { agent_id: "missing" } },
						{ name: "write", arguments: { path: "boundary.txt", content: "first\nsecond\n" } },
					] : [];
					const next = plan[results.length];
					stream.push({ type: "start", partial: message });
					if (next) {
						const call = { type: "toolCall", id: "fixture-" + next.name, name: next.name, arguments: {} };
						message.content.push(call);
						stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
						call.arguments = next.arguments;
						stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(call.arguments), partial: message });
						stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
					} else {
						message.content.push({ type: "text", text: "" });
						stream.push({ type: "text_start", contentIndex: 0, partial: message });
						message.content[0].text = "Serraly synthetic fixture complete.";
						stream.push({ type: "text_delta", contentIndex: 0, delta: message.content[0].text, partial: message });
						stream.push({ type: "text_end", contentIndex: 0, content: message.content[0].text, partial: message });
					}
					message.stopReason = options?.signal?.aborted ? "aborted" : next ? "toolUse" : "stop";
					if (message.stopReason === "aborted") {
						message.errorMessage = "Fixture aborted";
						stream.push({ type: "error", reason: "aborted", error: message });
					} else stream.push({ type: "done", reason: message.stopReason, message });
					stream.end();
				} catch (error) {
					message.stopReason = "error"; message.errorMessage = String(error);
					stream.push({ type: "error", reason: "error", error: message }); stream.end();
					report("fixture-error", { error: String(error) });
				}
			});
			return stream;
		},
	});
}
