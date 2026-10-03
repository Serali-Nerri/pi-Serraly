import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { config } from "../config/config.ts";
import type { CompactThinkingController } from "../state/thinking-controller.ts";
import { patchRegistry } from "./patch-keys.ts";
import { installCompactMode, refreshCompactModeComponents } from "./compact-mode.ts";
import { installDefaultMode, installToolExpandedBackground } from "./default-mode.ts";
import { installToolMouseInteraction } from "./mouse/interaction.ts";
import { getToolMouseTui } from "../overlays/mouse-state.ts";
import { installToolGrouping } from "./grouping.ts";
import { installMessageDisplayRendering, setMessageDisplayTheme } from "./message-display.ts";
import { clearAllAnimations } from "../transcript/tool/result.ts";
import { refreshMountedTranscript } from "./transcript-refresh.ts";

const OWNER = Symbol.for("claude-style-tools.rendering-owner");

/** Patch installation only. Session routing/commands/scheduling belong to lifecycle. */
export function installTranscript(ctx: ExtensionContext, thinking: CompactThinkingController) {
	patchRegistry.get<{ dispose(): void }>(OWNER)?.dispose();
	const disposers: Array<() => void> = [];
	let disposed = false;
	const release = () => {
		if (disposed) return;
		disposed = true;
		for (const dispose of disposers.reverse()) {
			try { dispose(); } catch { /* Continue releasing the remaining domains. */ }
		}
		clearAllAnimations();
	};
	try {
		const defaults = installDefaultMode();
		disposers.push(() => defaults.shutdown());
		const grouping = installToolGrouping(() => config.mode === "on");
		disposers.push(() => grouping.shutdown());
		const compact = installCompactMode({ query: thinking });
		disposers.push(() => compact.shutdown());
		disposers.push(installMessageDisplayRendering());
		disposers.push(installToolExpandedBackground());
		disposers.push(installToolMouseInteraction(ctx));
		const current = {
			compact,
			refresh(context: ExtensionContext) {
				if (disposed) return;
				grouping.setTheme(context.ui.theme);
				setMessageDisplayTheme(context.ui.theme);
				const tui = getToolMouseTui();
				refreshCompactModeComponents(tui);
				grouping.refresh(tui);
				compact.syncState(context);
				refreshMountedTranscript(tui);
			},
			dispose() {
				release();
				patchRegistry.dispose(OWNER, current);
			},
		};
		patchRegistry.install(OWNER, current);
		return current;
	} catch (error) {
		release();
		throw error;
	}
}
