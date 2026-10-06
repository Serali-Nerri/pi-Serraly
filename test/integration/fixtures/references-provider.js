import { appendFileSync, readFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

// A model/provider boundary only: production factories and request assembly stay real.
export default function (pi) {
	const config = JSON.parse(readFileSync(process.env.SERRALY_CONFIG, "utf8"));
	const state = globalThis[Symbol.for("serraly.reference-fixture")] = { requests: [] };
	const report = (phase, extra = {}) => appendFileSync(process.env.SERRALY_REPORT, JSON.stringify({ phase, ...extra }) + "\n");
	pi.registerProvider("serraly-fixture", {
		api: "references-scripted", apiKey: "synthetic-not-a-secret", baseUrl: "https://example.invalid",
		models: [{ id: "fixture", name: "Reference integration fixture", reasoning: false, input: ["text"],
			contextWindow: 128000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model, context) {
			const request = structuredClone(context);
			state.requests.push(request);
			report("reference-provider-request", { number: state.requests.length, context: request });
			const failure = config.retryRequests?.includes(state.requests.length);
			const stream = createAssistantMessageEventStream();
			const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: [{ type: "text", text: failure ? "" : "Reference fixture complete." }], timestamp: Date.now(),
				stopReason: failure ? "error" : "stop", ...(failure ? { errorMessage: "rate limit" } : {}),
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			queueMicrotask(() => {
				stream.push(failure ? { type: "error", reason: "error", error: message }
					: { type: "done", reason: "stop", message });
				stream.end();
			});
			return stream;
		},
	});
	pi.on("tool_call", (event) => { report("reference-tool-call", { name: event.toolName }); });
	pi.on("agent_settled", (_event, ctx) => { report("reference-settled", { mode: ctx.mode }); });
}
