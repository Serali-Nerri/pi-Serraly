import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RecapConfig } from "./config.ts";
import { parseRecap, RECAP_PROMPT, type Recap } from "./prompt.ts";

export function createGenerator(
	config: Readonly<RecapConfig>,
	getContext: () => ExtensionContext,
): (history: string, signal: AbortSignal) => Promise<Recap> {
	let warned = false;
	return async (history, signal) => {
		const ctx = getContext();
		let model = ctx.model;
		if (config.recapModel) {
			const slash = config.recapModel.indexOf("/");
			const override = ctx.modelRegistry.find(config.recapModel.slice(0, slash), config.recapModel.slice(slash + 1));
			if (override && ctx.modelRegistry.hasConfiguredAuth(override)) model = override;
			else if (!warned) {
				warned = true;
				ctx.ui.notify("The recap model is unavailable. Using the current session model; check recapModel in session-recap.json.", "warning");
			}
		}
		if (!model) throw new Error("No current model is available.");
		const reasoning = getSupportedThinkingLevels(model)[0];
		const response = await ctx.modelRegistry.streamSimple(model, {
			systemPrompt: RECAP_PROMPT,
			messages: [{ role: "user", content: history, timestamp: Date.now() }],
		}, {
			signal,
			sessionId: `${ctx.sessionManager.getSessionId()}:recap`,
			maxRetries: 0,
			...(reasoning && reasoning !== "off" ? { reasoning } : {}),
		}).result();
		if (response.stopReason !== "stop" && response.stopReason !== "length")
			throw new Error("The recap request did not complete.");
		return parseRecap(response.content.filter(part => part.type === "text").map(part => part.text).join(""));
	};
}
