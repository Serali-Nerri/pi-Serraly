/**
 * `/context` command grammar, argument completions, and latest-request capture
 * resolution shared by the Usage and Injections views.
 */
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import { buildNativeSnapshot, type LatestCaptureState } from "./capture.ts";
import type { ConfigCreationResult } from "./config.ts";
import type { RequestSnapshot } from "./model.ts";
import { normalizePreviewText } from "./text.ts";

const COMMAND_USAGE = "Usage: /context [usage|injections|tools|config]";
/**
 * Slash-command palette text, kept beside the grammar it describes.
 * RegisteredCommand has no argumentHint; mimic pi's `<hint> — <description>` style.
 */
export const CONTEXT_COMMAND_DESCRIPTION =
	"[usage|injections|tools|config] - Inspect context usage, injections, tools";
/** Cap for reported messages, which may quote configuration files and OS error text. */
const MAX_REPORTED_MESSAGE_LENGTH = 500;
const DEFAULT_VIEW: ContextView = "usage";
const ARGUMENT_OPTIONS = [
	{ value: "usage", label: "usage", description: "Show estimated context usage" },
	{ value: "injections", label: "injections", description: "Explore latest request injections" },
	{ value: "tools", label: "tools", description: "Inspect tool inventory and latest declarations" },
	{ value: "config", label: "config", description: "Create config file populated with defaults" },
] satisfies AutocompleteItem[];

/** The focused view a `/context` invocation requests. */
export type ContextView = "usage" | "injections" | "tools";

/** Parsed `/context` argument grammar. */
export type ContextCommand =
	| { readonly type: "view"; readonly view: ContextView }
	| { readonly type: "config" }
	| { readonly type: "invalid"; readonly message: string };

/** Resolved latest request capture, possibly degraded to the pi-native fallback. */
export interface LatestCaptureResult {
	readonly snapshot: RequestSnapshot;
	/** Messages the snapshot describes: the captured request's, or the session projection's. */
	readonly messages: ContextEvent["messages"];
	readonly degradedReason?: string;
}

/** Parse the complete, intentionally small `/context` argument grammar. */
export function parseContextCommand(argumentsText: string): ContextCommand {
	const words = argumentsText.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) {
		return { type: "view", view: DEFAULT_VIEW };
	}
	if (words.length === 1 && words[0] === "usage") {
		return { type: "view", view: "usage" };
	}
	if (words.length === 1 && words[0] === "injections") {
		return { type: "view", view: "injections" };
	}
	if (words.length === 1 && words[0] === "tools") {
		return { type: "view", view: "tools" };
	}
	if (words.length === 1 && words[0] === "config") {
		return { type: "config" };
	}
	return { type: "invalid", message: COMMAND_USAGE };
}

/** Complete full argument values for the supported `/context` grammar. */
export function getContextArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
	const normalizedPrefix = argumentPrefix.trimStart().toLowerCase();
	const matches = ARGUMENT_OPTIONS.filter((option) => option.value.startsWith(normalizedPrefix));
	return matches.length > 0 ? matches.map((option) => ({ ...option })) : null;
}

/** Return the latest captured request, or a view-local estimate without entering an agent turn. */
export function resolveLatestCapture(
	pi: ExtensionAPI,
	capture: LatestCaptureState,
	context: ExtensionCommandContext,
): LatestCaptureResult {
	const snapshot = capture.snapshot;
	const messages = capture.messages;
	if (snapshot !== undefined && messages !== undefined && isCaptureCurrent(capture, context)) {
		return { snapshot, messages };
	}
	const options = context.getSystemPromptOptions();
	return {
		snapshot: buildNativeSnapshot({
			systemPrompt: context.getSystemPrompt(),
			options,
			allTools: pi.getAllTools(),
			activeToolNames: pi.getActiveTools(),
			hiddenToolNames: options.hiddenTools,
		}),
		messages: context.sessionManager.buildSessionProjection().messages,
		degradedReason: "Not captured. Session estimate only. Extension additions were not observed.",
	};
}

/**
 * True while the capture still describes the session's latest request: same
 * session and model, with no compaction after the captured branch leaf.
 */
function isCaptureCurrent(capture: LatestCaptureState, context: ExtensionCommandContext): boolean {
	const identity = capture.identity;
	if (identity === undefined) return false;
	if (identity.sessionId !== undefined && context.sessionManager.getSessionId() !== identity.sessionId) return false;
	const model = context.model;
	if (
		identity.modelKey !== undefined && model !== undefined
		&& `${model.provider}/${model.id}` !== identity.modelKey
	) return false;
	if (identity.leafId === undefined) return true;
	const branch = context.sessionManager.getBranch();
	const leafIndex = branch.findIndex((entry) => entry.id === identity.leafId);
	if (leafIndex < 0) return false;
	return !branch.slice(leafIndex + 1).some((entry) => entry.type === "compaction");
}

/**
 * Report command errors in both interactive and headless modes. Messages can
 * quote untrusted text such as configuration keys, so they are sanitized and
 * capped before reaching the terminal.
 */
export function reportCommandMessage(
	context: ExtensionCommandContext,
	message: string,
	type: "info" | "warning" | "error",
): void {
	const safeMessage = truncate(normalizePreviewText(message), MAX_REPORTED_MESSAGE_LENGTH);
	if (context.hasUI) {
		context.ui.notify(safeMessage, type);
		return;
	}
	process.stderr.write(`${safeMessage}\n`);
}

/** Refuse a view whose inputs the in-progress compaction is rewriting. */
export function reportCompactionInProgress(context: ExtensionCommandContext, view: ContextView): void {
	reportCommandMessage(
		context,
		`/context ${view} is unavailable while compaction is in progress. Retry after it completes.`,
		"warning",
	);
}

/** Refuse a view outside TUI mode, naming the form the user typed. */
export function reportTuiOnly(context: ExtensionCommandContext, view: ContextView): void {
	reportCommandMessage(context, `/context ${view} is available in TUI mode only.`, "warning");
}

/** Report the outcome of the explicit create-only configuration command. */
export function reportConfigCreation(context: ExtensionCommandContext, result: ConfigCreationResult): void {
	switch (result.type) {
		case "created":
			reportCommandMessage(context, `Created default configuration: ${result.filePath}`, "info");
			break;
		case "exists":
			reportCommandMessage(context, `Configuration already exists; left unchanged: ${result.filePath}`, "warning");
			break;
		case "failed":
			reportCommandMessage(context, `Cannot create configuration at ${result.filePath}: ${result.reason}`, "error");
			break;
		default: {
			// Compile-time proof that every result variant is reported.
			const _exhaustive: never = result;
			return _exhaustive;
		}
	}
}

/** Shorten over-long text with an ellipsis marker. */
function truncate(text: string, maxLength: number): string {
	return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
