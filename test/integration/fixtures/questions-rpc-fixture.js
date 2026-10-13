import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { report } from "./scripted-provider.js";

const options = [
	{ label: "Local", description: "embedded", preview: "Keep the data nearby." },
	{ label: "Remote", description: "client/server" },
];
const question = (text, multiSelect = false) => ({
	question: text, header: "Decision",
	options: multiSelect ? options.map(({ preview: _preview, ...option }) => option) : options,
	multiSelect,
});
const call = (id, questions) => ({
	type: "toolCall", id, name: "ask_user_question", arguments: { questions },
});

export default function (pi) {
	pi.on("session_start", (_event, ctx) => {
		report("questions-rpc-mode", { mode: ctx.mode, hasUI: ctx.hasUI });
	});
	pi.registerProvider("serraly-questions", {
		api: "serraly-questions-scripted", apiKey: "synthetic-not-a-secret", baseUrl: "https://example.invalid",
		models: [{ id: "fixture", name: "Synthetic question provider", reasoning: false, input: ["text"],
			contextWindow: 32768, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model, context, streamOptions) {
			const userIndex = context.messages.findLastIndex((message) => message.role === "user");
			const user = context.messages[userIndex];
			const scenario = typeof user.content === "string" ? user.content : user.content.map((block) => block.text ?? "").join("");
			const answered = context.messages.slice(userIndex + 1).some((message) => message.role === "toolResult");
			const plans = {
				siblings: [
					call("rpc-first", [question("Where should it run?"), question("What is the custom value?")]),
					call("rpc-second", [question("Which locations are allowed?", true)]),
				],
				dismiss: [call("rpc-dismiss", [question("Keep this answer?"), question("Continue the questionnaire?")])],
				abort: [call("rpc-abort", [question("Abort the pending custom answer?")])],
				recovery: [call("rpc-recovery", [question("Can another questionnaire run?")])],
			};
			const calls = answered ? [] : plans[scenario];
			const stream = createAssistantMessageEventStream();
			const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
				timestamp: Date.now(), content: [], stopReason: "pending",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				for (const planned of calls ?? []) {
					const index = message.content.length;
					const toolCall = { ...planned, arguments: {} };
					message.content.push(toolCall);
					stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
					toolCall.arguments = planned.arguments;
					stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(planned.arguments), partial: message });
					stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: message });
				}
				if (!calls?.length) {
					message.content.push({ type: "text", text: "" });
					stream.push({ type: "text_start", contentIndex: 0, partial: message });
					message.content[0].text = "Question scenario complete.";
					stream.push({ type: "text_delta", contentIndex: 0, delta: message.content[0].text, partial: message });
					stream.push({ type: "text_end", contentIndex: 0, content: message.content[0].text, partial: message });
				}
				message.stopReason = streamOptions?.signal?.aborted ? "aborted" : calls?.length ? "toolUse" : "stop";
				if (message.stopReason === "aborted") stream.push({ type: "error", reason: "aborted", error: message });
				else stream.push({ type: "done", reason: message.stopReason, message });
				stream.end();
				report("questions-provider", { scenario, calls: calls?.map((item) => item.id) ?? [] });
			});
			return stream;
		},
	});
}
