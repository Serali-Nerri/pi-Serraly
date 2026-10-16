/**
 * context-view - inspect what occupies the model context.
 *
 * Passively captures each normal request preparation; viewing never starts a turn.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { ConfigStore, createDefaultConfigFile } from "./config.ts";
import {
	CONTEXT_COMMAND_DESCRIPTION,
	getContextArgumentCompletions,
	parseContextCommand,
	reportCommandMessage,
	reportCompactionInProgress,
	reportConfigCreation,
	reportTuiOnly,
	resolveLatestCapture,
} from "./command.ts";
import {
	buildUsageSnapshot,
	collectPromptSources,
	LatestCaptureState,
} from "./capture.ts";
import { readAutoCompactReserveTokens } from "./settings.ts";
import { showInjectionsView } from "./ui/injections-view.ts";
import { showUsageView } from "./ui/usage-view.ts";
import { showToolsView } from "./ui/tools-view.ts";
import { computeUsage, toReportedUsage } from "./usage.ts";
import { captureToolObservation, type ToolObservation } from "./tool-observation.ts";

export default function (pi: ExtensionAPI) {
	const capture = new LatestCaptureState();
	const configStore = new ConfigStore();
	let latestTools: ToolObservation | undefined;
	let compacting = false;

	pi.on("before_provider_request", (event) => {
		latestTools = captureToolObservation(event.payload);
		// No return: the public handler chain retains its own payload unchanged.
	});

	pi.on("before_agent_start", (event) => {
		// The chained prompt here already carries additions from extensions loaded
		// earlier; anything the context event adds came from extensions after us.
		capture.prepare(event.systemPromptOptions, event.systemPrompt);
	});

	pi.on("session_before_compact", () => {
		compacting = true;
	});
	pi.on("session_compact", () => {
		compacting = false;
	});
	pi.on("session_compact_failed", () => {
		compacting = false;
	});
	pi.on("session_shutdown", () => {
		capture.clear();
	});

	pi.on("context_with_system", (event, ctx) => {
		// Lazy: these inputs are read only while this request's capture replaces
		// the previous one, and the baseline rebuild alone is O(session).
		const model = ctx.model;
		capture.finalize(() => ({
			systemPrompt: ctx.getSystemPrompt(),
			messages: event.messages,
			baselineMessages: ctx.sessionManager.buildSessionProjection().messages,
			allTools: pi.getAllTools(),
			activeToolNames: pi.getActiveTools(),
			promptSources: collectPromptSources(pi.getAllTools(), pi.getCommands()),
			origin: "real-turn",
			sessionId: ctx.sessionManager.getSessionId(),
			leafId: ctx.sessionManager.getLeafId() ?? undefined,
			modelKey: model === undefined ? undefined : `${model.provider}/${model.id}`,
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
			// Both views read the session projection, which compaction is rewriting.
			if ((command.view === "usage" || command.view === "injections") && compacting) {
				reportCompactionInProgress(ctx, command.view);
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
				const latest = resolveLatestCapture(pi, capture, ctx);
				if (view === "injections") {
					view = await showInjectionsView(ctx, {
						snapshot: latest.snapshot,
						degradedReason: latest.degradedReason,
					});
					continue;
				}
				// Loaded only for the Usage view, the sole consumer of configured colors.
				const loadedConfig = configStore.load();
				const options = ctx.getSystemPromptOptions();
				// A captured request already carries its own prompt and tool state; a
				// fallback replays the branch's recorded system messages instead.
				const current = latest.snapshot.origin === "real-turn" ? latest.snapshot : buildUsageSnapshot({
					messages: latest.messages,
					systemPrompt: ctx.getSystemPrompt(),
					options,
					allTools: pi.getAllTools(),
					activeToolNames: pi.getActiveTools(),
					hiddenToolNames: options.hiddenTools,
					promptSources: collectPromptSources(pi.getAllTools(), pi.getCommands()),
				});
				view = await showUsageView(ctx, {
					usage: computeUsage({
						snapshot: current,
						messages: latest.messages,
						reported: toReportedUsage(ctx.getContextUsage()),
						modelLabel: ctx.model?.id,
						autoCompactReserveTokens: readAutoCompactReserveTokens(ctx),
					}),
					degradedReason: latest.degradedReason,
					// Reported inside the view: a notification would stay hidden behind the fullscreen overlay.
					notices: loadedConfig.warnings,
					categoryColors: loadedConfig.config.categoryColors,
					mapSize: loadedConfig.config.mapSize,
				});
			}
		},
	});
}
