import { createAssistantMessageEventStream, getDeclaredTools } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { registerCodeModeExtensionTools } from "../../../packages/pi-codex-conversion/dist/code-mode.js";

export const model = {
	id: "gpt-6-astra", name: "Synthetic GPT", provider: "synthetic-local", api: "openai-codex-responses",
	baseUrl: "https://synthetic.invalid", reasoning: true, input: ["text", "image"],
	contextWindow: 500_000, maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export default function toolRequestObserver(pi) {
	const options = JSON.parse(process.argv[3] ?? "{}");
	pi.registerCommand("fixture-hide", {
		handler: (name) => pi.setActiveTools(pi.getActiveTools().filter((tool) => tool !== name.trim())),
	});
	if (options.integration) {
		pi.registerTool({
			name: "fixture_lookup", label: "Fixture lookup", description: "Unrelated third-party lookup",
			parameters: Type.Object({}),
			async execute() { return { content: [{ type: "text", text: "Fixture lookup" }], details: {} }; },
		});
		const registration = registerCodeModeExtensionTools(pi, () => [{
			name: "reasoning_bridge", topLevelName: "change_reasoning", kind: "function",
			usage: "await tools.reasoning_bridge()", deferLoading: false,
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
			async invoke() { return "Synthetic integration result"; },
		}]);
		pi.on("session_shutdown", () => registration.unregister());
	}
	if (options.externalNotes) registerExternalNotes(pi);
	const registerProvider = () => pi.registerProvider("synthetic-local", {
		api: "openai-codex-responses",
		apiKey: "synthetic-test-key",
		baseUrl: "https://synthetic.invalid",
		models: [model],
		streamSimple(model, context) {
			pi.events.emit("fixture:model-request", getDeclaredTools(context.messages).map((tool) => tool.name));
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
	// Notes lifecycle preparation can install PCC's real transport overlay.
	// Replace it at the public provider boundary, never in the model network.
	pi.on("session_start", registerProvider);
	pi.on("session_tree", registerProvider);
}

function registerExternalNotes(pi) {
	const owner = {
		protocol: 1, owner: "pi-notes-compaction",
		identity: () => ({ firstWindowId: "fixture", currentWindowId: "fixture", windowNumber: 1 }),
		projectMessages: (messages) => [...messages],
		projectBranch: (entries) => [...entries],
		allowsWindowRequests: () => false,
	};
	const unsubscribe = pi.events.on("pi-notes-compaction:owner:v1", (request) => request.reply(owner));
	pi.on("session_start", (_event, ctx) => {
		let bridge;
		pi.events.emit("pi-notes-compaction:bridge:v1", { protocol: 1, reply: (value) => { bridge = value; } });
		if (!bridge) throw new Error("External Notes bridge unavailable");
		const claim = bridge.claim(owner);
		if (!claim.claimed) throw new Error(claim.reason);
		const tools = ["notes", "history", "new_context", "get_context_remaining"].map((name) => ({
			name, label: name, description: `External ${name}`,
			parameters: Type.Object({}),
			async execute() { return { content: [{ type: "text", text: `External ${name}` }], details: {} }; },
		}));
		claim.registerTools(tools, ctx);
		pi.setActiveTools([...new Set([...pi.getActiveTools(), ...tools.map((tool) => tool.name)])]);
		bridge.configureTools(tools, ctx, { notes: "await tools.notes()", history: "await tools.history()" });
	});
	pi.on("session_shutdown", unsubscribe);
}
