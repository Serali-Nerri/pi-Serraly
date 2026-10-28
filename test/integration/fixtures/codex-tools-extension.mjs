import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";

export const model = {
	id: "gpt-6-astra", name: "Synthetic GPT", provider: "synthetic-local", api: "openai-codex-responses",
	baseUrl: "https://synthetic.invalid", reasoning: true, input: ["text", "image"],
	contextWindow: 500_000, maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export default function toolRequestObserver(pi) {
	const registerProvider = () => pi.registerProvider("synthetic-local", {
		api: "openai-codex-responses",
		apiKey: "synthetic-test-key",
		baseUrl: "https://synthetic.invalid",
		models: [model],
		streamSimple(model, context) {
			pi.events.emit("fixture:model-request", getCurrentTools(context.messages).map((tool) => tool.name));
			const stream = createAssistantMessageEventStream();
			const message = {
				role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: [{ type: "text", text: "Synthetic response" }], stopReason: "stop", timestamp: Date.now(),
				usage: {
					input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: "stop", message });
			stream.end();
			return stream;
		},
	});
	registerProvider();
	// Runtime preparation can install PCC's real transport overlay.
	// Replace it at the public provider boundary, never in the model network.
	pi.on("session_start", registerProvider);
	pi.on("session_tree", registerProvider);
}
