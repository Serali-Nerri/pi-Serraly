import type { OptionInput, QuestionInput } from "./schema.ts";

/**
 * The selectable rows of a question: its own options followed by Claude Code's two built-in
 * escape hatches, `Other` (free text answer) and `Chat about this` (freeform response).
 */
export type Choice =
	| { kind: "option"; option: OptionInput; optionIndex: number }
	| { kind: "other" }
	| { kind: "chat" };

export function choicesFor(question: QuestionInput): Choice[] {
	const choices: Choice[] = question.options.map((option, optionIndex) => ({
		kind: "option" as const,
		option,
		optionIndex,
	}));
	choices.push({ kind: "other" });
	choices.push({ kind: "chat" });
	return choices;
}
