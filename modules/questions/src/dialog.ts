import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Editor, type EditorTheme, type Focusable, Key, matchesKey, type TUI } from "@earendil-works/pi-tui";
import { choicesFor, type Choice } from "./choices.ts";
import { AFK_COUNTDOWN_ENV, AFK_DEFAULT_COUNTDOWN_MS, AFK_ENV, envInt } from "./config.ts";
import {
	helpText,
	markdownThemeFor,
	mergeColumns,
	pushWrapped,
	renderChoices,
	renderPreviewBox,
	renderQuestionTitle,
	renderSubmitTab,
	renderTabBar,
} from "./render.ts";
import { type Annotation, type AnswerRecord, type AnswersPayload, type DialogOutcome, formatAnswer } from "./result.ts";
import type { QuestionInput } from "./schema.ts";

export interface DialogOptions {
	questions: QuestionInput[];
	tui: TUI;
	theme: Theme;
	done: (outcome: DialogOutcome) => void;
}

/** The interactive component returned by {@link createAskUserQuestionDialog}. */
export interface AskUserQuestionDialog extends Component, Focusable {
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
	dispose(): void;
}

export function createAskUserQuestionDialog({ questions, tui, theme, done }: DialogOptions): AskUserQuestionDialog {
	const markdownTheme = markdownThemeFor(theme);
	const editorTheme: EditorTheme = {
		borderColor: (text) => theme.fg("borderMuted", text),
		selectList: {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		},
	};
	const editor = new Editor(tui, editorTheme);

	// -- state ---------------------------------------------------------------
	let questionIndex = 0;
	let cursor = 0;
	let mode: "options" | "other" | "chat" | "notes" = "options";
	let modeQuestion = 0;
	let hint: string | undefined;
	let cachedLines: string[] | undefined;
	let finished = false;
	const records = new Map<number, AnswerRecord>();

	const afkTimeoutMs = envInt(AFK_ENV) ?? 0;
	const afkCountdownMs = envInt(AFK_COUNTDOWN_ENV) ?? AFK_DEFAULT_COUNTDOWN_MS;
	let afkRemainingMs = afkTimeoutMs;
	let afkTimer: ReturnType<typeof setInterval> | undefined;

	function invalidate(): void {
		cachedLines = undefined;
		tui.requestRender();
	}

	function record(index: number): AnswerRecord {
		let existing = records.get(index);
		if (!existing) {
			existing = { labels: [] };
			records.set(index, existing);
		}
		return existing;
	}

	function isAnswered(index: number): boolean {
		const existing = records.get(index);
		if (!existing) return false;
		return existing.labels.length > 0 || existing.custom !== undefined || Boolean(existing.notes);
	}

	function allAnswered(): boolean {
		return questions.every((_, index) => isAnswered(index));
	}

	function buildPayload(): AnswersPayload {
		const answers: Record<string, string> = {};
		const annotations: Record<string, Annotation> = {};
		const orderedRecords: AnswerRecord[] = [];
		questions.forEach((question, index) => {
			const existing = records.get(index) ?? { labels: [] };
			const answer = formatAnswer(existing, question.multiSelect === true);
			if (answer) answers[question.question] = answer;
			if (existing.notes || existing.preview) {
				annotations[question.question] = {
					...(existing.preview ? { preview: existing.preview } : {}),
					...(existing.notes ? { notes: existing.notes } : {}),
				};
			}
			orderedRecords.push(existing);
		});
		return {
			records: orderedRecords,
			answers,
			...(Object.keys(annotations).length > 0 ? { annotations } : {}),
		};
	}

	function finish(outcome: DialogOutcome): void {
		if (finished) return;
		finished = true;
		if (afkTimer) {
			clearInterval(afkTimer);
			afkTimer = undefined;
		}
		done(outcome);
	}

	function submit(): void {
		finish({ kind: "submitted", ...buildPayload() });
	}

	function advance(): void {
		hint = undefined;
		if (questions.length === 1) {
			submit();
			return;
		}
		if (questionIndex < questions.length - 1) {
			questionIndex += 1;
		} else {
			questionIndex = questions.length; // review / submit tab
		}
		cursor = 0;
		invalidate();
	}

	function selectOption(choice: Choice, question: QuestionInput): void {
		const existing = record(questionIndex);
		if (choice.kind === "other") {
			mode = "other";
			modeQuestion = questionIndex;
			editor.setText(existing.custom ?? "");
			editor.disableSubmit = false;
			invalidate();
			return;
		}
		if (choice.kind === "chat") {
			mode = "chat";
			modeQuestion = questionIndex;
			editor.setText("");
			editor.disableSubmit = false;
			invalidate();
			return;
		}
		if (question.multiSelect === true) {
			const label = choice.option.label;
			existing.labels = existing.labels.includes(label)
				? existing.labels.filter((entry) => entry !== label)
				: [...existing.labels, label];
			existing.custom = undefined;
			invalidate();
			return;
		}
		existing.labels = [choice.option.label];
		existing.custom = undefined;
		existing.preview = choice.option.preview;
		advance();
	}

	function toggleMultiSelect(choice: Choice, question: QuestionInput): void {
		if (question.multiSelect !== true) return;
		if (choice.kind !== "option") {
			selectOption(choice, question);
			return;
		}
		selectOption(choice, question);
	}

	function confirmChoice(): void {
		const question = questions[questionIndex];
		if (!question) return;
		const choices = choicesFor(question);
		const choice = choices[cursor];
		if (!choice) return;
		if (question.multiSelect === true && choice.kind === "option") {
			if (record(questionIndex).labels.length === 0) {
				hint = "Select at least one option, then press Enter.";
				invalidate();
				return;
			}
			advance();
			return;
		}
		selectOption(choice, question);
	}

	// -- input handling ------------------------------------------------------

	editor.onSubmit = (value: string) => {
		const trimmed = value.trim();
		if (mode === "chat") {
			if (!trimmed) return;
			finish({ kind: "submitted", ...buildPayload(), response: trimmed });
			return;
		}
		if (mode === "other") {
			const existing = record(modeQuestion);
			existing.custom = trimmed || "(no response)";
			existing.labels = [];
			existing.preview = undefined;
			mode = "options";
			editor.setText("");
			advance();
			return;
		}
		if (mode === "notes") {
			const existing = record(modeQuestion);
			existing.notes = trimmed || undefined;
			mode = "options";
			editor.setText("");
			invalidate();
			return;
		}
	};

	function handleInput(data: string): void {
		if (afkTimeoutMs > 0) afkRemainingMs = afkTimeoutMs;

		if (mode !== "options") {
			if (matchesKey(data, Key.escape)) {
				mode = "options";
				editor.setText("");
				hint = undefined;
				invalidate();
				return;
			}
			editor.handleInput(data);
			invalidate();
			return;
		}

		const onSubmitTab = questionIndex === questions.length;
		const question = questions[questionIndex];

		if (matchesKey(data, Key.escape)) {
			finish({ kind: "cancelled" });
			return;
		}

		// Tab switching (only with multiple questions).
		if (questions.length > 1) {
			if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
				questionIndex = (questionIndex + 1) % (questions.length + 1);
				cursor = 0;
				hint = undefined;
				invalidate();
				return;
			}
			if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
				questionIndex = (questionIndex - 1 + questions.length + 1) % (questions.length + 1);
				cursor = 0;
				hint = undefined;
				invalidate();
				return;
			}
		}

		if (onSubmitTab) {
			if (matchesKey(data, Key.enter)) {
				if (!allAnswered()) {
					hint = "You have not answered all questions.";
					invalidate();
					return;
				}
				submit();
			}
			return;
		}

		if (!question) return;
		const choices = choicesFor(question);
		cursor = Math.min(cursor, choices.length - 1);

		if (matchesKey(data, Key.up)) {
			cursor = Math.max(0, cursor - 1);
			hint = undefined;
			invalidate();
			return;
		}
		if (matchesKey(data, Key.down)) {
			cursor = Math.min(choices.length - 1, cursor + 1);
			hint = undefined;
			invalidate();
			return;
		}
		if (matchesKey(data, Key.space)) {
			toggleMultiSelect(choices[cursor], question);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			confirmChoice();
			return;
		}
		if (data === "n" || data === "N") {
			mode = "notes";
			modeQuestion = questionIndex;
			editor.setText(record(questionIndex).notes ?? "");
			editor.disableSubmit = false;
			invalidate();
		}
	}

	// -- rendering -----------------------------------------------------------

	function currentPreview(): string | undefined {
		if (mode !== "options" || questionIndex >= questions.length) return undefined;
		const question = questions[questionIndex];
		if (!question || question.multiSelect === true) return undefined;
		const choice = choicesFor(question)[cursor];
		return choice?.kind === "option" ? choice.option.preview : undefined;
	}

	function renderInput(width: number): string[] {
		const out: string[] = [];
		const question = questions[modeQuestion];
		const label =
			mode === "notes" ? "Notes:" : mode === "chat" ? "Your response:" : `Your answer${question ? ` for "${question.header || `Q${modeQuestion + 1}`}"` : ""}:`;
		pushWrapped(out, " ", theme.fg("muted", label), width);
		const editorWidth = Math.max(1, width - 2);
		for (const line of editor.render(editorWidth)) {
			out.push(` ${line}`);
		}
		out.push("");
		pushWrapped(out, " ", theme.fg("dim", "Enter to submit • Esc to go back"), width);
		return out;
	}

	function render(width: number): string[] {
		if (cachedLines) return cachedLines;
		const w = Math.max(24, width);
		const lines: string[] = [];
		lines.push(theme.fg("borderMuted", "─".repeat(w)));

		const onSubmitTab = questionIndex === questions.length;
		const question = onSubmitTab ? undefined : questions[questionIndex];
		const multi = question?.multiSelect === true;
		const preview = currentPreview();

		if (questions.length > 1) {
			lines.push(
				...renderTabBar(
					theme,
					{
						questions,
						activeIndex: questionIndex,
						answered: questions.map((_, index) => isAnswered(index)),
						allAnswered: allAnswered(),
					},
					w,
				),
			);
			lines.push("");
		}

		if (onSubmitTab) {
			lines.push(...renderSubmitTab(theme, { questions, records, allAnswered: allAnswered() }, w));
		} else if (mode !== "options") {
			if (question) lines.push(...renderQuestionTitle(theme, question, questionIndex, w));
			lines.push("");
			lines.push(...renderInput(w));
		} else if (question) {
			lines.push(...renderQuestionTitle(theme, question, questionIndex, w));
			if (multi) {
				pushWrapped(lines, " ", theme.fg("dim", "Select one or more, then press Enter."), w);
			}
			lines.push("");
			const selection = { cursor, record: records.get(questionIndex) };
			if (preview && w >= 96) {
				const leftWidth = Math.max(28, Math.floor(w * 0.46));
				const rightWidth = w - leftWidth - 3;
				lines.push(
					...mergeColumns(
						theme,
						renderChoices(theme, question, selection, leftWidth),
						renderPreviewBox(theme, markdownTheme, preview, rightWidth),
						leftWidth,
					),
				);
			} else {
				lines.push(...renderChoices(theme, question, selection, w));
				if (preview) {
					lines.push("");
					lines.push(...renderPreviewBox(theme, markdownTheme, preview, w));
				}
			}
		}

		// Footer: hint / countdown / key help.
		lines.push("");
		if (afkTimeoutMs > 0 && afkRemainingMs <= afkCountdownMs) {
			const seconds = Math.max(0, Math.ceil(afkRemainingMs / 1000));
			pushWrapped(lines, " ", theme.fg("warning", `auto-continue in ${seconds}s · any key to stay`), w);
		}
		if (hint) {
			pushWrapped(lines, " ", theme.fg("warning", hint), w);
		}
		pushWrapped(lines, " ", theme.fg("dim", helpText({ mode, onSubmitTab, multiSelect: multi })), w);
		lines.push(theme.fg("borderMuted", "─".repeat(w)));

		cachedLines = lines;
		return lines;
	}

	// -- AFK timer -----------------------------------------------------------

	if (afkTimeoutMs > 0) {
		afkTimer = setInterval(() => {
			if (finished) return;
			afkRemainingMs -= 1000;
			if (afkRemainingMs <= 0) {
				finish({ kind: "afk", afkTimeoutMs, ...buildPayload() });
				return;
			}
			invalidate();
		}, 1000);
		afkTimer.unref?.();
	}

	let focused = false;

	return {
		get focused(): boolean {
			return focused;
		},
		set focused(value: boolean) {
			focused = value;
			editor.focused = value;
		},
		render,
		handleInput,
		invalidate,
		dispose: () => {
			if (afkTimer) {
				clearInterval(afkTimer);
				afkTimer = undefined;
			}
		},
	};
}
