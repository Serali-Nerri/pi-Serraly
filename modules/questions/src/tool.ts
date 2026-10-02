import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createAskUserQuestionDialog } from "./dialog.ts";
import { DESCRIPTION } from "./prompt.ts";
import { type AskUserQuestionDetails, buildToolResultText, type DialogOutcome } from "./result.ts";
import { ParamsSchema, type QuestionInput, validateQuestions } from "./schema.ts";

/** Claude Code's sentinel answer for a question that only received notes. */
const NOTES_ONLY_DISPLAY = "(notes only)";

async function runDialog(ctx: ExtensionContext, questions: QuestionInput[]): Promise<DialogOutcome> {
	const result = await ctx.ui.custom<DialogOutcome>((tui, theme, _keybindings, done) =>
		createAskUserQuestionDialog({ questions, tui, theme, done }),
	);
	return result ?? { kind: "cancelled" };
}

export function registerAskUserQuestion(pi: ExtensionAPI): void {
	pi.registerTool<typeof ParamsSchema, AskUserQuestionDetails>({
		name: "AskUserQuestion",
		exposure: "deferred",
		namespace: {
			name: "questions",
			description: "Ask the user interactive clarification questions",
		},
		label: "Ask User Question",
		description: DESCRIPTION,
		parameters: ParamsSchema,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const questions = params.questions as QuestionInput[];
			validateQuestions(questions);

			if (ctx.mode !== "tui") {
				return {
					content: [
						{
							type: "text" as const,
							text: "Error: AskUserQuestion requires the interactive TUI; no answer was collected. Ask the user in plain text instead.",
						},
					],
					details: { questions, answers: {} } satisfies AskUserQuestionDetails,
				};
			}

			const outcome = await runDialog(ctx, questions);

			if (outcome.kind === "cancelled") {
				return {
					content: [{ type: "text" as const, text: "The user did not answer the questions." }],
					details: { questions, answers: {}, cancelled: true } satisfies AskUserQuestionDetails,
				};
			}

			const details: AskUserQuestionDetails = {
				questions,
				answers: outcome.answers,
				...(outcome.annotations ? { annotations: outcome.annotations } : {}),
				...(outcome.kind === "submitted" && outcome.response ? { response: outcome.response } : {}),
				...(outcome.kind === "afk" ? { afkTimeoutMs: outcome.afkTimeoutMs } : {}),
			};

			return {
				content: [{ type: "text" as const, text: buildToolResultText(questions, outcome) }],
				details,
			};
		},

		renderCall(args, theme) {
			const questions = (args.questions ?? []) as QuestionInput[];
			const headers = questions.map((question, index) => question.header || `Q${index + 1}`).join(", ");
			const count = `${questions.length} question${questions.length === 1 ? "" : "s"}`;
			return new Text(
				`${theme.fg("toolTitle", theme.bold("AskUserQuestion "))}${theme.fg("muted", count)}${headers ? theme.fg("dim", ` (${headers})`) : ""}`,
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskUserQuestionDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "No answer — the question was dismissed."), 0, 0);
			}
			const lines: string[] = [];
			for (const [index, question] of details.questions.entries()) {
				const header = question.header || `Q${index + 1}`;
				const answer = details.answers[question.question];
				const display = answer === "(notes only)" ? NOTES_ONLY_DISPLAY : answer || "(unanswered)";
				lines.push(`${theme.fg("success", "✓ ")}${theme.fg("accent", `${header}: `)}${theme.fg("text", display)}`);
				const annotation = details.annotations?.[question.question];
				if (annotation?.notes) lines.push(`  ${theme.fg("dim", `notes: ${annotation.notes}`)}`);
				if (annotation?.preview) lines.push(`  ${theme.fg("dim", "selected preview attached")}`);
			}
			if (details.response) {
				lines.push(`${theme.fg("accent", "response: ")}${theme.fg("text", details.response)}`);
			}
			if (details.afkTimeoutMs !== undefined) {
				lines.push(theme.fg("warning", `User was away; auto-continued after ${Math.round(details.afkTimeoutMs / 1000)}s.`));
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});

}
