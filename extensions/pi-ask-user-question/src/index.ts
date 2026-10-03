import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskUserQuestion } from "./tool.ts";

export { choicesFor, type Choice } from "./choices.ts";
export { AFK_COUNTDOWN_ENV, AFK_ENV, MAX_HEADER, MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS, NOTES_ONLY } from "./config.ts";
export { createAskUserQuestionDialog, type DialogOptions } from "./dialog.ts";
export { DESCRIPTION } from "./prompt.ts";
export { buildToolResultText, formatAnswer, formatLabels, type AnswersPayload, type DialogOutcome } from "./result.ts";
export { ParamsSchema, type QuestionInput, type OptionInput, validateQuestions } from "./schema.ts";
export { registerAskUserQuestion } from "./tool.ts";

export default function piAskUserQuestion(pi: ExtensionAPI): void {
	registerAskUserQuestion(pi);
}
