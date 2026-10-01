// Adapted from pi-cc-extensions v0.8.69; see THIRD_PARTY_NOTICES.md.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { config } from "./config.ts";
import { collectContextInspector, formatTokens } from "../state/context.ts";
import { contextSourceLabel } from "../state/context-snapshot.ts";
import { showContextDialog } from "../overlays/context-dialog.ts";

export { capParts, collectContextBreakdown, collectContextInspector, formatTokens, resolveUsedTokens, type ContextPart } from "../state/context.ts";
export { escCloseHitbox, hasActiveTextPreview, showTextPreview } from "../overlays/text-preview.ts";

/** Command registration only: lifecycle owns all Pi event subscriptions. */
export default function contextUsageExtension(
	pi: Pick<ExtensionAPI, "registerCommand" | "getAllTools">,
	options: { enabled?: () => boolean } = {},
): void {
	pi.registerCommand("context", {
		description: "Show the current context-window distribution",
		handler: async (_args, ctx) => {
			if (!(options.enabled?.() ?? config.enableContextCommand)) {
				ctx.ui.notify("Context inspector is disabled", "info");
				return;
			}
			const inspector = collectContextInspector(ctx, pi.getAllTools());
			if (ctx.mode !== "tui") {
				const { snapshot } = inspector;
				const lines = [
					`Context: ${snapshot.tokens === undefined ? "unknown" : formatTokens(snapshot.tokens) + " tokens"} · Source: ${contextSourceLabel(snapshot.source)}`,
					...inspector.parts.map((part) => `${part.label}: ${formatTokens(part.tokens)} tokens`),
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			await showContextDialog(ctx, inspector);
		},
	});
}
