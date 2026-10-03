import { type Static, Type } from "typebox";
import { MAX_HEADER, MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS } from "./config.ts";

export const OptionSchema = Type.Object({
	label: Type.String({
		description:
			"The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.",
	}),
	description: Type.String({
		description:
			"Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.",
	}),
	preview: Type.Optional(
		Type.String({
			description:
				"Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options. Rendered as markdown in a monospace box; multi-line content is supported. Only shown for single-select questions.",
		}),
	),
});

export const QuestionSchema = Type.Object({
	question: Type.String({
		description:
			'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
	}),
	header: Type.String({
		maxLength: MAX_HEADER,
		description: `Very short label displayed as a chip/tag (max ${MAX_HEADER} chars). Examples: "Auth method", "Library", "Approach".`,
	}),
	options: Type.Array(OptionSchema, {
		minItems: MIN_OPTIONS,
		maxItems: MAX_OPTIONS,
		description:
			"The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no 'Other' option, that will be provided automatically.",
	}),
	multiSelect: Type.Optional(
		Type.Boolean({
			default: false,
			description:
				"Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.",
		}),
	),
});

export const ParamsSchema = Type.Object({
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		maxItems: MAX_QUESTIONS,
		description: "Questions to ask the user (1-4 questions)",
	}),
});

export type Params = Static<typeof ParamsSchema>;
export type QuestionInput = Params["questions"][number];
export type OptionInput = QuestionInput["options"][number];

export function validateQuestions(questions: QuestionInput[]): void {
	if (questions.length < 1 || questions.length > MAX_QUESTIONS) {
		throw new Error(`AskUserQuestion requires 1-${MAX_QUESTIONS} questions (received ${questions.length}).`);
	}
	const seenQuestions = new Set<string>();
	for (const [index, question] of questions.entries()) {
		if (seenQuestions.has(question.question)) {
			throw new Error(
				`AskUserQuestion: question texts must be unique, but "${question.question}" appears more than once.`,
			);
		}
		seenQuestions.add(question.question);
		if (question.options.length < MIN_OPTIONS || question.options.length > MAX_OPTIONS) {
			throw new Error(
				`AskUserQuestion: question ${index + 1} ("${question.question}") must have ${MIN_OPTIONS}-${MAX_OPTIONS} options (received ${question.options.length}). A question with a single option has no decision in it — state the path you were going to offer and continue instead.`,
			);
		}
		const seenLabels = new Set<string>();
		for (const option of question.options) {
			if (seenLabels.has(option.label)) {
				throw new Error(
					`AskUserQuestion: option labels must be unique within each question, but "${option.label}" appears twice in question ${index + 1}.`,
				);
			}
			seenLabels.add(option.label);
		}
	}
}
