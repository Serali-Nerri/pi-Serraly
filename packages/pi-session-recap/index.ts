import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./src/config.ts";
import { RecapController } from "./src/controller.ts";
import { createGenerator } from "./src/generate.ts";
import { buildHistory } from "./src/history.ts";
import { classifyInput } from "./src/terminal-input.ts";
import { recapWidget } from "./src/widget.ts";

const KEY = "session-recap";

export default function sessionRecap(pi: ExtensionAPI): void {
	const loaded = loadConfig(join(getAgentDir(), "session-recap.json"));
	let warned = false;
	let context: ExtensionContext;
	let controller: RecapController | undefined;
	let unsubscribe: (() => void) | undefined;
	const generate = createGenerator(loaded.config, () => context);
	const stop = (): void => {
		unsubscribe?.();
		unsubscribe = undefined;
		controller?.dispose();
		controller = undefined;
	};
	const start = (ctx: ExtensionContext): void => {
		stop();
		context = ctx;
		if (ctx.mode !== "tui") return;
		if (loaded.warning && !warned) {
			warned = true;
			ctx.ui.notify("Some recap settings could not be loaded. Defaults are in use; check session-recap.json.", "warning");
		}
		controller = new RecapController(loaded.config, {
			now: Date.now,
			schedule(callback, delayMs) {
				const timer = setTimeout(callback, delayMs);
				timer.unref();
				return () => clearTimeout(timer);
			},
			isIdle: () => context.isIdle(),
			history: () => buildHistory(context.sessionManager.getBranch()),
			generate,
			loading: active => context.ui.setStatus(KEY, active
				? context.ui.theme.style("drafting recap...", { fg: "dim", italic: true }) : undefined),
			show: recap => context.ui.setWidget(KEY, () => recapWidget(recap, () => context.ui.theme), { placement: "aboveEditor" }),
			clear: () => context.ui.setWidget(KEY, undefined),
			notify: (message, level) => context.ui.notify(message, level),
		});
		unsubscribe = ctx.ui.onTerminalInput(data => {
			const input = classifyInput(data, context.ui.getEditorText());
			if (input.activity) controller?.activity();
			if (input.clear) context.ui.setWidget(KEY, undefined);
			return undefined;
		});
	};

	pi.registerCommand("recap", {
		description: "Summarize the current conversation without adding to its history",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			context = ctx;
			await controller?.manual();
		},
	});
	pi.on("session_start", (_event, ctx) => start(ctx));
	pi.on("session_tree", (_event, ctx) => start(ctx));
	pi.on("session_shutdown", stop);
	pi.on("input", (_event, ctx) => { context = ctx; controller?.submitted(); });
	pi.on("agent_start", (_event, ctx) => { context = ctx; controller?.started(); });
	pi.on("turn_start", (_event, ctx) => { context = ctx; controller?.started(); });
	pi.on("agent_settled", (_event, ctx) => { context = ctx; controller?.settled(); });
}
