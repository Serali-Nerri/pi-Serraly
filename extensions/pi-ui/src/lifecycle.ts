import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { config, formatConfigStatus, getCompactThinkingConfig, updateConfig, type CompactStyleMode } from "./config/config.ts";
import { showStylePanel } from "./config/panel.ts";
import { installCompactThinking } from "./state/thinking-controller.ts";
import { createShellController } from "./shell/controller.ts";
import { installTranscript } from "./compat/index.ts";
import { HostCapabilityError, assertUiPatchOwnership, requireHostCapabilities } from "./compat/host-capabilities.ts";
import { bindRendererPolicy } from "./compat/policy.ts";
import { getToolMouseTui, setToolMouseTui } from "./overlays/mouse-state.ts";
import { setToolTuiFullscreen } from "./transcript/tool/show-more-hint.ts";
import { mountedTranscriptChanged, mountedTranscriptIdentity, refreshMountedTranscript } from "./compat/transcript-refresh.ts";
import { bindUiScheduler, UiScheduler } from "./scheduler.ts";
import { patchRegistry, UI_LIFECYCLE_OWNER } from "./compat/patch-keys.ts";

const OWNER = UI_LIFECYCLE_OWNER;
const BRIDGE = "pi-ui-bridge";
type Handler = (event: any, ctx: ExtensionContext) => unknown;

/** Domain controllers subscribe here; exactly one host handler routes each event. */
function createEventRouter() {
	const handlers = new Map<string, Set<Handler>>();
	const events: Pick<ExtensionAPI, "on"> = {
		on: ((name: string, handler: Handler) => {
			let group = handlers.get(name);
			if (!group) handlers.set(name, group = new Set());
			group.add(handler);
			return () => group!.delete(handler);
		}) as ExtensionAPI["on"],
	};
	return {
		events,
		emit(name: string, event: any, ctx: ExtensionContext) {
			for (const handler of [...handlers.get(name) ?? []]) handler(event, ctx);
		},
	};
}

export function registerUiLifecycle(pi: ExtensionAPI): void {
	const router = createEventRouter();
	const scheduler = new UiScheduler();
	const thinking = installCompactThinking(pi, getCompactThinkingConfig(), {
		events: router.events, scheduler, getTui: () => getToolMouseTui() as TUI | undefined,
	});
	const shell = createShellController(pi, scheduler);
	let ctx: ExtensionContext | undefined;
	let generation = 0;
	let transcript: ReturnType<typeof installTranscript> | undefined;
	let unbindScheduler: (() => void) | undefined;
	let unbindPolicy: (() => void) | undefined;
	let active = false;
	let pendingCompaction: { generation: number; before: Set<object> } | undefined;
	const reported = new Set<string>();
	const report = (domain: string, error: unknown, context: ExtensionContext) => {
		if (reported.has(domain)) return;
		reported.add(domain);
		try { context.ui.notify(`pi-ui ${domain}: ${error instanceof Error ? error.message : String(error)}`, "warning"); } catch {}
	};
	const safe = (domain: string, action: () => void, context: ExtensionContext) => {
		try { action(); } catch (error) { report(domain, error, context); }
	};
	/**
	 * One read-only preflight before any thinking/transcript patch. A host that
	 * cannot be patched keeps its native display, shell, commands and Markdown;
	 * every unusable capability is reported once per session through one notice.
	 */
	const compatAvailable = (context: ExtensionContext): boolean => {
		try {
			requireHostCapabilities();
			// Ownership is checked before any of our own owners are released, so a
			// foreign patch cannot leave the UI half-uninstalled.
			assertUiPatchOwnership();
			return true;
		} catch (error) {
			report("compat", error instanceof HostCapabilityError ? error : new HostCapabilityError([String(error)]), context);
			return false;
		}
	};
	const stopTranscript = () => { transcript?.dispose(); transcript = undefined; };
	thinking.onBeforeShutdown(stopTranscript);
	const owner = { dispose };
	/** Owned-slot shape: only a branded lifecycle owner is disposed or handed over. */
	const isLifecycleOwner = (value: unknown): value is typeof owner =>
		typeof value === "object" && value !== null && typeof (value as { dispose?: unknown }).dispose === "function";

	function dispose(): void {
		if (!active || !ctx) return;
		const previous = ctx;
		const tui = getToolMouseTui();
		active = false;
		generation++;
		pendingCompaction = undefined;
		scheduler.dispose();
		safe("shell cleanup", () => shell.dispose(), previous);
		safe("transcript cleanup", stopTranscript, previous);
		safe("thinking cleanup", () => router.emit("session_shutdown", { type: "session_shutdown" }, previous), previous);
		unbindScheduler?.(); unbindScheduler = undefined;
		unbindPolicy?.(); unbindPolicy = undefined;
		if (patchRegistry.owns(OWNER, owner)) {
			safe("bridge cleanup", () => previous.ui.setWidget(BRIDGE, undefined), previous);
			setToolMouseTui(undefined);
			setToolTuiFullscreen(false);
			patchRegistry.dispose(OWNER, owner);
			refreshMountedTranscript(tui);
		}
		ctx = undefined;
	}

	function refresh(): void {
		if (!active || !ctx) return;
		thinking.updateConfig(getCompactThinkingConfig());
		transcript?.refresh(ctx);
		scheduler.request(true);
	}

	function deferRefresh(): void {
		const token = generation;
		scheduler.schedule("transcript-rebuild", 0, () => {
			if (active && token === generation) refresh();
		});
	}

	pi.on("session_start", (event, context) => {
		dispose();
		if (context.mode !== "tui" || !context.hasUI) return;
		ctx = context;
		active = true;
		generation++;
		reported.clear();
		scheduler.start((force) => getToolMouseTui()?.requestRender?.(force), (error) => report("refresh", error, context));
		unbindScheduler = bindUiScheduler(scheduler);
		unbindPolicy = bindRendererPolicy(() => pi.getAllTools());
		// Capabilities and slot ownership are checked before any patch or owner is
		// installed, so a foreign patch is never touched and our own owners are never
		// released for a domain that cannot be installed. The shell keeps working.
		if (!compatAvailable(context)) {
			safe("shell", () => shell.start(context), context);
			return;
		}
		patchRegistry.getOwned(OWNER, isLifecycleOwner)?.dispose();
		patchRegistry.installOwned(OWNER, owner);
		const bridgeGeneration = generation;
		safe("bridge", () => context.ui.setWidget(BRIDGE, (tui) => {
			if (!active || bridgeGeneration !== generation || !patchRegistry.owns(OWNER, owner)) {
				return { render: () => [], invalidate() {} };
			}
			setToolMouseTui(tui);
			return {
				render() {
					if (!active || bridgeGeneration !== generation || !patchRegistry.owns(OWNER, owner)) return [];
					setToolTuiFullscreen(tui.mode === "fullscreen");
					transcript?.compact.reconcile(tui);
					// Pi rebuilds after ALL session_compact handlers finish. A timer
					// turn alone is not a boundary when another extension awaits.
					if (active && pendingCompaction?.generation === generation &&
						mountedTranscriptChanged(pendingCompaction.before, tui)) {
						pendingCompaction = undefined;
						safe("post-compaction refresh", refresh, context);
					}
					return [];
				},
				invalidate() {},
			};
		}), context);
		safe("thinking", () => router.emit("session_start", event, context), context);
		safe("transcript", () => { transcript = installTranscript(context, thinking); }, context);
		safe("shell", () => shell.start(context), context);
		refresh();
		deferRefresh();
	});
	pi.on("session_shutdown", dispose);
	for (const name of [
		"agent_start", "agent_end", "agent_settled", "message_start", "message_update", "message_end",
		"ui_prompt_start", "ui_prompt_end",
		"tool_execution_start", "tool_execution_update", "tool_execution_end",
		"session_tree", "session_compact", "model_select", "thinking_level_select",
	] as const) {
		(pi.on as (name: string, handler: Handler) => unknown)(name, (event: any, context: ExtensionContext) => {
			if (!active) return;
			ctx = context;
			safe(name, () => router.emit(name, event, context), context);
			switch (name) {
				case "agent_start": transcript?.compact.activityStart(); shell.agentStart(); break;
				case "agent_end": shell.agentEnd(context); break;
				case "agent_settled": transcript?.compact.activitySettled(Boolean(event?.aborted)); break;
				case "message_start": {
					const message = event.message;
					if (message.role === "user" || (message.role === "custom" && message.display)) {
						transcript?.compact.groupBoundary();
					}
					break;
				}
				case "ui_prompt_start": transcript?.compact.userWait(true); break;
				case "ui_prompt_end": transcript?.compact.userWait(false); break;
				case "message_end": shell.messageEnd(); break;
				case "tool_execution_end":
					shell.toolEnd(context);
					transcript?.compact.refreshToolCallMessage(event.toolCallId);
					break;
				case "session_tree":
					shell.rebuild(context);
					refresh();
					deferRefresh();
					break;
				case "session_compact":
					shell.rebuild(context);
					transcript?.compact.syncState(context);
					pendingCompaction = { generation, before: mountedTranscriptIdentity(getToolMouseTui()) };
					break;
				case "model_select":
				case "thinking_level_select": shell.modelChanged(); break;
				case "message_update": transcript?.compact.assertOwnership(); break;
			}
			// The host already invalidates streaming tool rows; no full-tree rebuild.
			scheduler.request();
		});
	}
	pi.registerCommand("ccstyle", {
		description: "Configure tool and message rendering",
		getArgumentCompletions: (prefix) => ["on", "compact", "off", "status", "panel"]
			.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, context) => {
			const action = args.trim();
			if (action === "status") { context.ui.notify(formatConfigStatus(), "info"); return; }
			if (context.mode !== "tui" || !context.hasUI) {
				context.ui.notify("/ccstyle requires TUI mode", "warning"); return;
			}
			if (!action || action === "panel") { await showStylePanel(context, refresh); return; }
			if (["on", "compact", "off"].includes(action)) {
				try { updateConfig({ mode: action as CompactStyleMode }); refresh(); }
				catch (error) { context.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
				return;
			}
			context.ui.notify("Usage: /ccstyle [on|compact|off|status|panel]", "warning");
		},
	});
}
