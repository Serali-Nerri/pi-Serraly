/**
 * context-view - inspect what occupies the model context.
 *
 * Passively captures the first normal request preparation. Viewing never starts a turn.
 */
import { buildSessionContext, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { ConfigStore, createDefaultConfigFile } from "./config.ts";
import {
	CONTEXT_COMMAND_DESCRIPTION,
	getContextArgumentCompletions,
	parseContextCommand,
	reportCommandMessage,
	reportConfigCreation,
	reportTuiOnly,
	resolveInitialCapture,
} from "./command.ts";
import {
	buildUsageSnapshot,
	collectPromptSources,
	InitialCaptureState,
} from "./capture.ts";
import { readAutoCompactReserveTokens } from "./settings.ts";
import { showInjectionsView } from "./ui/injections-view.ts";
import { showUsageView } from "./ui/usage-view.ts";
import { showToolsView } from "./ui/tools-view.ts";
import { computeUsage, toReportedUsage } from "./usage.ts";
import { captureToolObservation, type ToolObservation } from "./tool-observation.ts";

export default function (pi: ExtensionAPI) {
	const capture = new InitialCaptureState();
	const configStore = new ConfigStore();
	let latestTools: ToolObservation | undefined;

	pi.on("before_provider_request", (event) => {
		latestTools = captureToolObservation(event.payload);
		// No return: the public handler chain retains its own payload unchanged.
	});

	pi.on("before_agent_start", (event) => {
		// The chained prompt here already carries additions from extensions loaded
		// earlier; anything the context event adds came from extensions after us.
		capture.prepare(event.systemPromptOptions, event.systemPrompt);
	});

	pi.on("context", (event, ctx) => {
		// Lazy: this event fires once per LLM request, but only the freezing call
		// reads these inputs, and the baseline rebuild alone is O(session).
		capture.finalize(() => ({
			systemPrompt: ctx.getSystemPrompt(),
			messages: event.messages,
			baselineMessages: buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages,
			allTools: pi.getAllTools(),
			activeToolNames: pi.getActiveTools(),
			promptSources: collectPromptSources(pi.getAllTools(), pi.getCommands()),
			origin: "real-turn",
		}));
	});

	pi.registerCommand("context", {
		description: CONTEXT_COMMAND_DESCRIPTION,
		getArgumentCompletions: getContextArgumentCompletions,
		handler: async (args, ctx) => {
			const command = parseContextCommand(args);
			if (command.type === "invalid") {
				reportCommandMessage(ctx, command.message, "error");
				return;
			}
			// Creating the file needs no UI, so it stays available in every run mode.
			if (command.type === "config") {
				reportConfigCreation(ctx, createDefaultConfigFile());
				return;
			}
			if (ctx.mode !== "tui") {
				reportTuiOnly(ctx, command.view);
				return;
			}
			let view: "usage" | "injections" | "tools" | undefined = command.view;
			while (view !== undefined) {
				if (view === "tools") {
					view = await showToolsView(ctx, {
						tools: pi.getAllTools(), active: pi.getActiveTools(), sampledAt: new Date().toISOString(), observation: latestTools,
					});
					continue;
				}
				const initial = resolveInitialCapture(pi, capture, ctx);
				if (view === "injections") {
					view = await showInjectionsView(ctx, {
						snapshot: initial.snapshot,
						degradedReason: initial.degradedReason,
					});
					continue;
				}
				// Loaded only for the Usage view, the sole consumer of configured colors.
				const loadedConfig = configStore.load();
				// ReadonlySessionManager lacks buildSessionContext(); use pi's exported builder.
				const messages = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages;
				const current = buildUsageSnapshot({
					messages,
					initial: initial.snapshot,
					systemPrompt: ctx.getSystemPrompt(),
					options: ctx.getSystemPromptOptions(),
					allTools: pi.getAllTools(),
					activeToolNames: pi.getActiveTools(),
					promptSources: collectPromptSources(pi.getAllTools(), pi.getCommands()),
				});
				view = await showUsageView(ctx, {
					usage: computeUsage({
						snapshot: current,
						messages,
						reported: toReportedUsage(ctx.getContextUsage()),
						modelLabel: ctx.model?.id,
						autoCompactReserveTokens: readAutoCompactReserveTokens(ctx),
					}),
					degradedReason: initial.degradedReason,
					// Reported inside the view: a notification would stay hidden behind the fullscreen overlay.
					notices: loadedConfig.warnings,
					categoryColors: loadedConfig.config.categoryColors,
					mapSize: loadedConfig.config.mapSize,
				});
			}
		},
	});
}
