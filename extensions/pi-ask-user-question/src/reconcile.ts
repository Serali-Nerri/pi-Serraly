/**
 * Mid-session availability for ask_user_question.
 *
 * The tool is script-callable and inactive by default. If explicitly activated,
 * `before_agent_start` strips that direct activation when the host has no UI.
 * It never re-adds a tool the operator removed. Script calls remain callable;
 * the execution path's `ctx.hasUI` guard returns no_ui without opening a dialog.
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
