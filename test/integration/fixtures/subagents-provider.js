import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { createAssistantMessageEventStream, getCurrentTools, registerApiProvider } from "@earendil-works/pi-ai";

const report = (phase, extra = {}) => appendFileSync(process.env.SERRALY_REPORT, JSON.stringify({ phase, ...extra }) + "\n");
const contentText = (content) => typeof content === "string" ? content :
	(content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("\n");

// Explicitly selected by file path in each child profile. Each load creates its
// own provider closure; no parent tool/provider factory is injected into children.
export default async function (pi) {
	const factory = randomUUID();
	const startup = JSON.parse(readFileSync(process.env.SERRALY_CONFIG, "utf8"));
	const wait = async (predicate, label) => {
		const end = Date.now() + 10000;
		while (!predicate()) {
			if (Date.now() >= end) throw new Error("fixture gate deadline: " + label);
			await new Promise((done) => setTimeout(done, 10));
		}
	};
	if (startup.blockChildFactory) {
		report("provider-factory-waiting", { factory });
		await wait(() => existsSync(startup.factoryGate), "child factory");
	}
	if (startup.modelsJsonTransport) {
		const stream = scriptedStream({ factory: "models-json-transport" });
		registerApiProvider({ api: "serraly-subagents-models-scripted", stream, streamSimple: stream });
		report("script-api-registered");
	}
	let sessionId;
	const inventory = () => ({ active: pi.getActiveTools(), registered: pi.getAllTools().map((tool) => tool.name) });
	report("provider-factory", { factory });
	pi.on("session_start", (_event, ctx) => {
		sessionId = ctx.sessionManager.getSessionId();
		report("provider-start", { factory, sessionId, trusted: ctx.isProjectTrusted(), cwd: ctx.cwd, ...inventory() });
	});
	pi.on("session_shutdown", (event) => report("provider-shutdown", { factory, sessionId, reason: event.reason }));
	if (startup.blockChildFactory || startup.invalidChildResources) pi.on("resources_discover", async () => {
		// This event follows every session_start handler, including native MCP.
		await wait(() => readFileSync(process.env.SERRALY_REPORT, "utf8").split("\n").some((line) => line && JSON.parse(line).phase === "mcp-initialize"), "native MCP initialize");
		if (startup.invalidChildResources) {
			// Deliberately malformed extension output makes SDK binding reject
			// after native MCP has started, rather than mocking the SDK factory.
			report("provider-resource-failure", { factory, sessionId });
			return { skillPaths: [null] };
		}
		report("provider-ready-waiting", { factory, sessionId });
		await wait(() => existsSync(startup.readyGate), "child readiness");
	});
	pi.on("tool_result", (event) => {
		report("child-tool-result", { factory, sessionId, name: event.toolName, parentToolCallId: event.parentToolCallId,
			isError: event.isError, text: contentText(event.content), ...inventory() });
	});
	pi.registerProvider("serraly-subagents", {
		api: "serraly-subagents-scripted", apiKey: "fixture", baseUrl: "https://example.invalid",
		models: [{ id: "fixture", name: "Local subagents fixture", reasoning: false, input: ["text"],
			contextWindow: 65536, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple: scriptedStream({ factory, inventory, sessionId: () => sessionId, registerLate: (names) => {
			for (const name of names) pi.registerTool({ name, label: name, description: `Late local effect ${name}`,
				parameters: Type.Object({}), exposure: "deferred", async execute() {
					report(name === "late_effect" ? "late-effect" : "recursive-effect", { name, factory, sessionId });
					return { content: [{ type: "text", text: "late-effect-executed:" + name }] };
				} });
		} }),
	});
}

// The transport is process-global, but model definitions still come from each
// session's isolated models.json. This stream has no parent pi/session closure.
function scriptedStream({ factory, inventory = () => ({}), sessionId = () => undefined,
	registerLate = () => { throw new Error("No extension may register late tools"); } }) {
	return function (model, context, options) {
		const stream = createAssistantMessageEventStream();
		const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
			timestamp: Date.now(), content: [], stopReason: "pending", usage: { input: 10, output: 5, cacheRead: 0,
				cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		const finishAborted = () => {
			message.stopReason = "aborted"; message.errorMessage = "Fixture aborted";
			stream.push({ type: "error", reason: "aborted", error: message }); stream.end();
			report("provider-aborted", { factory, sessionId: sessionId() });
		};
		queueMicrotask(async () => {
			try {
				const payload = await options?.onPayload?.({ fixture: true }, model);
				await options?.onResponse?.({ status: 200, headers: new Headers() }, model);
				await options?.onProviderStreamEvent?.({ type: "synthetic", payload: payload ?? { fixture: true } }, model);
				if (options?.signal?.aborted) { finishAborted(); return; }
				let marker, start = -1;
				for (let i = context.messages.length - 1; i >= 0; i--) {
					const item = context.messages[i];
					if (item.role !== "user") continue;
					const found = contentText(item.content).match(/SERRALY_PLAN:([a-zA-Z0-9_-]+)/);
					if (found) { marker = found[1]; start = i; break; }
				}
				const config = JSON.parse(readFileSync(process.env.SERRALY_CONFIG, "utf8"));
				const plan = config.plans?.[marker] ?? [];
				const results = context.messages.slice(start + 1).filter((item) => item.role === "toolResult");
				const step = plan[results.length];
				if (step?.waitForTool || step?.waitAbsent || step?.gate) {
					if (step.gate) report("provider-waiting", { factory, sessionId: sessionId(), marker });
					const end = Date.now() + 8000;
					while (!options?.signal?.aborted && Date.now() < end) {
						const names = inventory().registered ?? getCurrentTools(context.messages).map((tool) => tool.name);
						if ((!step.waitForTool || names.includes(step.waitForTool)) &&
							(!step.waitAbsent || !names.includes(step.waitAbsent)) && (!step.gate || existsSync(step.gate))) break;
						await new Promise((done) => setTimeout(done, 10));
					}
				}
				if (options?.signal?.aborted) { finishAborted(); return; }
				if (step?.lateTool) registerLate(["late_effect"]);
				if (step?.lateControlTools) {
					registerLate(["Agent", "StopAgent", "MessageAgent", "AgentStatus"]);
					report("late-controls-registered", { factory, sessionId: sessionId(), ...inventory() });
				}
				report("provider-request", { factory, sessionId: sessionId(), marker, step: results.length, ...inventory(),
					declared: getCurrentTools(context.messages).map((tool) => ({ name: tool.name, description: tool.description })),
					results: results.map((item) => ({ name: item.toolName, isError: item.isError, text: contentText(item.content) })) });
				stream.push({ type: "start", partial: message });
				if (step?.name && !options?.signal?.aborted) {
					const call = { type: "toolCall", id: `${factory}-${marker}-${results.length}`, name: step.name, arguments: {} };
					message.content.push(call);
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					call.arguments = step.arguments ?? {};
					stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(call.arguments), partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
					message.stopReason = "toolUse";
				} else {
					const text = `plan-complete:${marker}\n` + results.map((item) => contentText(item.content)).join("\n");
					message.content.push({ type: "text", text: "" });
					stream.push({ type: "text_start", contentIndex: 0, partial: message });
					message.content[0].text = text;
					stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
					stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
					message.stopReason = "stop";
					report("plan-complete", { factory, sessionId: sessionId(), marker, ...inventory() });
				}
				if (options?.signal?.aborted) {
					message.stopReason = "aborted"; message.errorMessage = "Fixture aborted";
					stream.push({ type: "error", reason: "aborted", error: message });
				} else stream.push({ type: "done", reason: message.stopReason, message });
				stream.end();
			} catch (error) {
				if (options?.signal?.aborted) { finishAborted(); return; }
				message.stopReason = "error"; message.errorMessage = String(error);
				stream.push({ type: "error", reason: "error", error: message }); stream.end();
				report("fixture-error", { error: String(error), factory, sessionId: sessionId() });
			}
		});
		return stream;
	};
}
