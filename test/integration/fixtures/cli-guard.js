import assert from "node:assert/strict";
import { ToolExecutionComponent, AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { report } from "./scripted-provider.js";
export default function (pi) {
	const state = globalThis[Symbol.for("serraly.runtime-fixture")] = {
		toolPrototype: ToolExecutionComponent.prototype,
		toolMethods: Object.fromEntries(["getCallRenderer", "getResultRenderer", "getRenderShell", "updateDisplay"].map((name) => [name, ToolExecutionComponent.prototype[name]])),
		assistantMethod: AssistantMessageComponent.prototype.updateContent,
		uiCalls: [], providerCalls: 0, instrumentation: { payload: 0, response: 0, stream: 0 }, timers: 0,
	};
	for (const name of ["setTimeout", "setInterval"]) {
		const original = globalThis[name];
		globalThis[name] = (...args) => {
			if (new Error().stack.includes(process.env.SERRALY_RELEASE + "/dist/pi-ui/")) state.timers++;
			return original(...args);
		};
	}
	pi.on("session_start", (_event, ctx) => {
		state.mode = ctx.mode;
		for (const name of ["setWidget", "setHeader", "setFooter"]) {
			const original = ctx.ui[name];
			ctx.ui[name] = function (...args) {
				state.uiCalls.push({ name, key: name === "setWidget" ? args[0] : undefined });
				return original.apply(this, args);
			};
		}
	});
	pi.on("before_provider_request", () => { state.instrumentation.payload++; });
	pi.on("after_provider_response", () => { state.instrumentation.response++; });
	pi.on("provider_stream_event", () => { state.instrumentation.stream++; });
	state.unpatched = () => {
		for (const [name, method] of Object.entries(state.toolMethods)) assert.equal(ToolExecutionComponent.prototype[name], method, name);
		assert.equal(AssistantMessageComponent.prototype.updateContent, state.assistantMethod);
	};
	report("guard-factory");
}
