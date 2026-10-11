/**
 * pi-ask-user-question — the `ask_user_question` tool: a structured option
 * dialog with an automatically appended `Type something.` custom-answer row,
 * plus a native select/input fallback for RPC hosts.
 *
 * The module owns the tool, its dialog and its configuration. It registers no
 * commands, no renderers, no prompt sections and no other extension's resources.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskUserQuestionTool } from "./ask-user-question.js";
import { registerAskUserQuestionReconciler } from "./reconcile.js";

export { ASK_USER_QUESTION_TOOL_NAME } from "./ask-user-question.js";

export default function (pi: ExtensionAPI) {
	registerAskUserQuestionTool(pi);
	registerAskUserQuestionReconciler(pi);
}
