/**
 * Mid-session availability for ask_user_question.
 *
 * Non-interactive runs must not offer a tool that can only fail, so the
 * `before_agent_start` reconciler strips it from the active set when the host
 * reports no UI. It never re-adds the tool: registration already activates it,
 * and an operator who removed it — through tool settings or `setActiveTools` —
 * keeps that choice. The execution path keeps its own `ctx.hasUI` guard as a
 * one-turn backstop for a reordered tool-list snapshot.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ASK_USER_QUESTION_TOOL_NAME } from "./ask-user-question.js";

/** Idempotent: leaving the active set alone when the tool is already stripped. */
export function reconcileAskUserQuestionTool(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (ctx.hasUI) return;
	const active = pi.getActiveTools();
	if (!active.includes(ASK_USER_QUESTION_TOOL_NAME)) return;
	pi.setActiveTools(active.filter((name) => name !== ASK_USER_QUESTION_TOOL_NAME));
}

/** Attach the reconciler to `before_agent_start`; safe to call once at load. */
export function registerAskUserQuestionReconciler(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (_event, ctx) => reconcileAskUserQuestionTool(pi, ctx));
}
