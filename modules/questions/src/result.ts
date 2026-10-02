import { NOTES_ONLY } from "./config.ts";
import type { QuestionInput } from "./schema.ts";

export interface Annotation {
	preview?: string;
	notes?: string;
}

export interface AnswerRecord {
	/** Selected option labels (empty when a custom answer was typed). */
	labels: string[];
	/** Free-text answer typed through "Other". */
	custom?: string;
	notes?: string;
	/** Preview of the selected option, if it had one. */
	preview?: string;
}

export interface AnswersPayload {
	records: AnswerRecord[];
	answers: Record<string, string>;
	annotations?: Record<string, Annotation>;
	response?: string;
}

export type DialogOutcome =
	| ({ kind: "submitted" } & AnswersPayload)
	| ({ kind: "afk"; afkTimeoutMs: number } & AnswersPayload)
	| { kind: "cancelled" };

export interface AskUserQuestionDetails {
	questions: QuestionInput[];
	answers: Record<string, string>;
	annotations?: Record<string, Annotation>;
	response?: string;
	afkTimeoutMs?: number;
	cancelled?: boolean;
}

/** Mirrors Claude Code's label formatting: quote labels containing `, ` or `"`. */
export function formatLabels(labels: string[]): string {
	return labels.map((label) => (label.includes(", ") || label.includes('"') ? JSON.stringify(label) : label)).join(", ");
}

export function formatAnswer(record: AnswerRecord, multiSelect: boolean): string {
	if (record.custom !== undefined) return record.custom;
	if (record.labels.length === 0) return record.notes ? NOTES_ONLY : "";
	if (multiSelect) return formatLabels(record.labels);
	return record.labels[0] ?? "";
}

export function buildAnswerSummary(
	questions: QuestionInput[],
	answers: Record<string, string>,
	annotations: Record<string, Annotation> | undefined,
): string {
	const parts: string[] = [];
	for (const question of questions) {
		const answer = answers[question.question];
		const annotation = annotations?.[question.question];
		const hasAnswer = Boolean(answer && answer !== NOTES_ONLY);
		if (!hasAnswer && !annotation?.notes) continue;
		const segments = [hasAnswer ? `"${question.question}"="${answer}"` : `"${question.question}"=(no option selected)`];
		if (annotation?.preview) segments.push(`selected preview:\n${annotation.preview}`);
		if (annotation?.notes) segments.push(`notes: ${annotation.notes}`);
		parts.push(segments.join(" "));
	}
	return parts.join(", ");
}

/** Whether every question was answered with one of its own options (no custom text/notes). */
export function isCleanlyAnswered(
	question: QuestionInput,
	annotations: Record<string, Annotation> | undefined,
	records: AnswerRecord[],
	index: number,
): boolean {
	if (annotations?.[question.question]?.notes) return false;
	const record = records[index];
	if (!record || formatAnswer(record, question.multiSelect === true) === NOTES_ONLY) return true;
	if (record.custom !== undefined) return false;
	if (record.labels.length === 0) return true;
	const allowed = new Set(question.options.map((option) => option.label));
	return record.labels.every((label) => allowed.has(label));
}

/** Port of Claude Code's mapToolResultToToolResultBlockParam. */
export function buildToolResultText(
	questions: QuestionInput[],
	outcome: Extract<DialogOutcome, { kind: "submitted" } | { kind: "afk" }>,
): string {
	const summary = buildAnswerSummary(questions, outcome.answers, outcome.annotations);
	if (outcome.kind === "afk") {
		const afk = `No response after ${Math.round(outcome.afkTimeoutMs / 1000)}s — the user may be away from keyboard. Proceed using your best judgment based on the context so far; you can re-ask this question later if it's still relevant.`;
		return summary ? `${afk}\nBefore going idle the user had selected: ${summary}.` : afk;
	}
	if (outcome.response?.trim()) {
		return `The user responded: ${outcome.response}`;
	}
	if (summary) {
		const allClean = questions.every((question, index) =>
			isCleanlyAnswered(question, outcome.annotations, outcome.records, index),
		);
		return allClean
			? `Your questions have been answered: ${summary}. You can now continue with these answers in mind.`
			: `The user answered: ${summary}. Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.`;
	}
	return "The user did not answer the questions.";
}
