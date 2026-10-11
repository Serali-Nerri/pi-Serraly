/**
 * ask_user_question — registration, host routing and the interactive lifetime.
 *
 * Two rendering paths share one result contract: a bottom-anchored tabbed
 * overlay for interactive terminals, and a sequential native select/input walk
 * for RPC hosts where `ui.custom()` cannot render. Results are returned as
 * model-facing prose plus structured `details`.
 *
 * The tool is model-only (declared to the model, never callable through
 * codemode or nested tool calls) and executes sequentially, so two
 * questionnaires never race for the same overlay stack.
 */

import { SettingsManager, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import { COLLAPSE_KEY_OFF, formatKeySpecForDisplay, loadConfig, resolveCollapseKey } from "./config.js";
import { type DialogUI, hasDialogUI, runRpcQuestionnaire } from "./rpc-fallback.js";
import { editWithExternalEditor } from "./state/external-editor.js";
import { QuestionnaireSession, type QuestionnaireSessionComponent, type QuestionnaireSessionConfig } from "./state/questionnaire-session.js";
import { displayLabel, sentinelsToAppend } from "./state/row-intent.js";
import { normalizeQuestionParams } from "./tool/normalize-params.js";
import { buildQuestionnaireResponse, buildToolResult } from "./tool/response-envelope.js";
import { type QuestionData, type QuestionnaireResult, type QuestionParams, QuestionParamsSchema } from "./tool/types.js";
import { validateQuestionnaire } from "./tool/validate-questionnaire.js";
import type { WrappingSelectItem } from "./view/components/wrapping-select.js";

/** Canonical tool name — single source of truth shared with the reconcile module. */
export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

/** Standard terminal bell. */
export const BEL = "\x07";

const ERROR_NO_UI = "Error: UI not available (running in non-interactive mode)";

const ERROR_NO_CUSTOM_UI =
	"Error: this client cannot render the questionnaire (custom UI is unavailable). The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead, without using this tool.";

/** Non-interactive host backstop (the reconciler normally strips the tool first). */
function rejectWithoutUi() {
	return buildToolResult(ERROR_NO_UI, { answers: [], cancelled: true, error: "no_ui" });
}

/**
 * One portable attention signal before the interactive wait begins. The
 * `isTTY` gate both proves an interactive terminal owns the coming wait and
 * keeps the byte out of piped RPC transports; a failed write never blocks the
 * questionnaire.
 */
function emitTerminalAttention(): void {
	try {
		if (process.stdout.isTTY) process.stdout.write(BEL);
	} catch {
		// Terminal attention is best effort; the questionnaire must still proceed.
	}
}

export function buildItemsForQuestion(question: QuestionData): WrappingSelectItem[] {
	const items: WrappingSelectItem[] = question.options.map((o) => ({
		kind: "option",
		label: o.label,
		description: o.description,
	}));
	for (const kind of sentinelsToAppend(question)) {
		items.push({ kind, label: displayLabel(kind) });
	}
	return items;
}

export const DEFAULT_TOOL_DESCRIPTION = `Ask the user structured questions (1-4 per call) when their request is underspecified and you cannot proceed without concrete decisions: gather missing preferences, resolve ambiguous instructions, or let the user pick the implementation direction. Ask every clarifying question in one call instead of stacking calls.

For each question, give 2-4 options whose labels and descriptions make the trade-offs readable. Set multiSelect: true when several answers may apply, and put a recommended option first with "(Recommended)" appended to its label. The user always gets an automatically appended "Type something." row for a free-text answer and can press Esc to abandon the questionnaire — never author "Other", "Type something." or "Next" as labels; they are reserved and rejected at runtime.

Use the optional preview field on single-select options when the user should compare concrete artifacts such as UI mockups, code snippets, diagrams or configurations. Previews render as markdown next to the options; skip them for simple preference questions.`;

type SessionRef = { current: QuestionnaireSession | null };
type OverlayHandleRef = { current: OverlayHandle | undefined };
type ToolResult = { content: { type: "text"; text: string }[]; details: QuestionnaireResult };

/** One canonical "aborted before an answer" result; never a silent decline. */
function abortedResult(): ToolResult {
	return buildToolResult("Questionnaire cancelled: the operation was aborted before answers were collected.", {
		answers: [],
		cancelled: true,
	});
}

/**
 * Register the raw terminal listener that toggles collapse while the overlay
 * is hidden. Returns the remover, or undefined when the key is off / the host
 * has no raw input hook — callers derive `canReopenWhileHidden` from that.
 */
function registerCollapseKeyListener(
	ctx: ExtensionContext,
	collapseKey: string,
	sessionRef: SessionRef,
	overlayHandleRef: OverlayHandleRef,
): (() => void) | undefined {
	if (collapseKey === COLLAPSE_KEY_OFF || typeof ctx.ui.onTerminalInput !== "function") return undefined;
	let hasAnnouncedHide = false;
	return ctx.ui.onTerminalInput((data) => {
		const handle = overlayHandleRef.current;
		if (!handle) return undefined;
		// Only act while the questionnaire is hidden (its handleInput is
		// unreachable) or actually focused. When some other overlay is on top,
		// leave the keystroke to that overlay instead of toggling the
		// questionnaire from underneath it.
		if (!handle.isHidden() && !handle.isFocused()) return undefined;
		if (!matchesKey(data, collapseKey as Parameters<typeof matchesKey>[1])) return undefined;
		// Kitty-protocol terminals report press, repeat, and release separately.
		// Toggle only on the initial press so a tap does not immediately reopen
		// the overlay and a held key does not toggle it repeatedly.
		if (isKeyRelease(data) || isKeyRepeat(data)) return { consume: true };
		sessionRef.current?.toggleCollapsedExternal();
		if (handle.isHidden() && !hasAnnouncedHide) {
			hasAnnouncedHide = true;
			ctx.ui.notify?.(`ask_user_question hidden — press ${formatKeySpecForDisplay(collapseKey)} to reopen`, "info");
		}
		return { consume: true };
	});
}

/**
 * Build the `ctx.ui.custom` component factory: constructs the session (capturing
 * it in `sessionRef`) and exposes its component. An abort that lands before the
 * factory runs is replayed on the fresh session, so a cancelled turn never leaves
 * the overlay waiting for input.
 */
function makeSessionFactory(config: {
	ctx: ExtensionContext;
	typed: QuestionParams;
	itemsByTab: WrappingSelectItem[][];
	collapseKey: string;
	canReopenWhileHidden: boolean;
	sessionRef: SessionRef;
	signal: AbortSignal | undefined;
}) {
	const { ctx, typed, itemsByTab, collapseKey, canReopenWhileHidden, sessionRef, signal } = config;
	return (
		tui: TUI,
		theme: Theme,
		keybindings: QuestionnaireSessionConfig["keybindings"],
		done: (result: QuestionnaireResult) => void,
	): QuestionnaireSessionComponent => {
		const session = new QuestionnaireSession({
			tui,
			theme,
			params: typed,
			itemsByTab,
			done,
			keybindings,
			editInput: async (value) => {
				try {
					const editorCommand = SettingsManager.create(ctx.cwd, undefined, {
						projectTrusted: ctx.isProjectTrusted(),
					}).getExternalEditorCommand();
					if (!editorCommand) throw new Error("No external editor command is configured");
					return await editWithExternalEditor(tui, editorCommand, value, signal);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`External editor failed: ${message}`, "error");
					return undefined;
				}
			},
			collapseKey,
			canReopenWhileHidden,
		});
		sessionRef.current = session;
		if (signal?.aborted) session.cancel();
		return session.component;
	};
}

/**
 * A TUI questionnaire ALWAYS resolves a QuestionnaireResult (cancel included),
 * so `undefined` uniquely means "host cannot render", never "user declined".
 * RPC hosts without `ctx.mode` land here: run the dialog walker when the host
 * has the primitives; otherwise tell the model the user never saw the questions.
 */
async function resolveUndefinedResult(
	ctx: ExtensionContext,
	typed: QuestionParams,
	signal: AbortSignal | undefined,
): Promise<ToolResult> {
	if (hasDialogUI(ctx.ui)) {
		return buildQuestionnaireResponse(await runRpcQuestionnaire(ctx.ui, typed, signal), typed);
	}
	return buildToolResult(ERROR_NO_CUSTOM_UI, { answers: [], cancelled: true, error: "no_custom_ui" });
}

/** The tabbed TUI path, including abort and collapse-listener cleanup. */
async function runTuiPath(
	ctx: ExtensionContext,
	typed: QuestionParams,
	signal: AbortSignal | undefined,
): Promise<ToolResult> {
	if (signal?.aborted) return abortedResult();
	const itemsByTab: WrappingSelectItem[][] = typed.questions.map((q) => buildItemsForQuestion(q));
	const collapseKey = resolveCollapseKey(loadConfig().collapseKey);
	const sessionRef: SessionRef = { current: null };
	const overlayHandleRef: OverlayHandleRef = { current: undefined };
	const removeOverlayInputListener = registerCollapseKeyListener(ctx, collapseKey, sessionRef, overlayHandleRef);
	// Hiding the overlay is only reversible through the raw listener above, so the
	// session may emit `setHidden` only when it was actually registered; otherwise
	// collapse falls back to the visible one-line row.
	const canReopenWhileHidden = removeOverlayInputListener !== undefined;
	const onAbort = () => sessionRef.current?.cancel();
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		emitTerminalAttention();
		const result = await ctx.ui.custom<QuestionnaireResult>(
			makeSessionFactory({ ctx, typed, itemsByTab, collapseKey, canReopenWhileHidden, sessionRef, signal }),
			{
				overlay: true,
				overlayOptions: {
					anchor: "bottom-center",
					width: "100%",
					maxHeight: "100%",
					margin: { left: 0, right: 0, bottom: 0 },
				},
				onHandle: (handle) => {
					overlayHandleRef.current = handle;
					sessionRef.current?.setOverlayHandle(handle);
				},
			},
		);
		if (result === undefined) return await resolveUndefinedResult(ctx, typed, signal);
		return buildQuestionnaireResponse(result, typed);
	} finally {
		signal?.removeEventListener("abort", onAbort);
		removeOverlayInputListener?.();
	}
}

/** The sequential native-dialog path for RPC hosts. */
async function runRpcPath(ui: DialogUI, typed: QuestionParams, signal: AbortSignal | undefined): Promise<ToolResult> {
	emitTerminalAttention();
	return buildQuestionnaireResponse(await runRpcQuestionnaire(ui, typed, signal), typed);
}

export function registerAskUserQuestionTool(pi: ExtensionAPI): void {
	const config = loadConfig();
	pi.registerTool({
		name: ASK_USER_QUESTION_TOOL_NAME,
		label: "Ask User Question",
		description: config.description ?? DEFAULT_TOOL_DESCRIPTION,
		exposure: "model-only",
		executionMode: "sequential",
		parameters: QuestionParamsSchema,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			// Line-terminator normalization runs once here, ahead of validation, so
			// every downstream consumer — validator, TUI, RPC walker and envelope —
			// sees the same clean text.
			const typed = normalizeQuestionParams(params as unknown as QuestionParams);
			if (!ctx.hasUI) return rejectWithoutUi();

			const validation = validateQuestionnaire(typed);
			if (!validation.ok) {
				return buildToolResult(validation.message, {
					answers: [],
					cancelled: true,
					error: validation.error,
				});
			}

			// RPC hosts report hasUI because the select/input sub-protocol works
			// while ui.custom() cannot render; route them to the dialog walker.
			if (ctx.mode === "rpc" && hasDialogUI(ctx.ui)) return await runRpcPath(ctx.ui, typed, signal);
			return await runTuiPath(ctx, typed, signal);
		},
	});
}
