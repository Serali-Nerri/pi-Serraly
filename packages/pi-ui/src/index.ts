import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { registerActivityCompletion } from "./activity-completion.js";
import { createUiConfig } from "./config.js";
import { installFooter } from "./footer.js";
import { showSettings } from "./panel.js";
import { installSticky } from "./sticky.js";
import { installThinking } from "./thinking.js";

export default function piUi(pi: ExtensionAPI): void {
	const completion = registerActivityCompletion(pi);
	let tui: TUI | undefined;
	let store: ReturnType<typeof createUiConfig> | undefined;
	let thinking: ReturnType<typeof installThinking> | undefined;
	let sticky: ReturnType<typeof installSticky> | undefined;
	let unmountFooter: (() => void) | undefined;
	const render = (): void => tui?.requestRender();

	function stop(): void {
		completion.stop();
		sticky?.dispose();
		sticky = undefined;
		thinking?.dispose();
		thinking = undefined;
		unmountFooter?.();
		unmountFooter = undefined;
		tui = undefined;
	}

	pi.on("session_start", (_event, ctx) => {
		stop();
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		const { ui } = ctx;
		const config = createUiConfig();
		store = config;
		const getTheme = () => ui.theme;
		completion.start();
		try {
			thinking = installThinking(pi, { getConfig: config.get, getTheme, requestRender: render });
			thinking.restore(ctx.sessionManager.getBranch());
		} catch (error) {
			thinking?.dispose();
			thinking = undefined;
			ui.notify(`pi-ui: Thinking disabled: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		try {
			sticky = installSticky({ getTui: () => tui, getTheme, enabled: () => config.get().stickyUserMessage });
		} catch (error) {
			ui.notify(`pi-ui: Sticky message disabled: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		unmountFooter = installFooter(pi, ctx, (mounted) => { tui = mounted; sticky?.refresh(); });
	});
	pi.on("session_tree", (_event, ctx) => {
		thinking?.restore(ctx.sessionManager.getBranch());
		sticky?.refresh();
		render();
	});
	pi.on("session_compact", (_event, ctx) => {
		thinking?.restore(ctx.sessionManager.getBranch());
		sticky?.refresh();
		render();
	});
	pi.on("session_shutdown", stop);
	pi.registerCommand("ui", {
		description: "Configure Thinking, footer and sticky user message presentation",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify("/ui requires TUI mode", "warning");
				return;
			}
			store ??= createUiConfig();
			await showSettings(ctx.ui, store, () => { thinking?.refresh(); sticky?.refresh(); render(); });
		},
	});
}
