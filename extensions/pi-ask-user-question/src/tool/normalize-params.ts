import type { QuestionParams } from "./types.js";

/**
 * Normalize line terminators in one model-supplied text field.
 *
 * Some models serialize a bare carriage return inside tool-call string
 * arguments at token boundaries where the text was meant to be contiguous
 * (`GEMBA\r_LOG\r_FILE` for `GEMBA_LOG_FILE`). A raw CR is a cursor-control
 * byte, not text: rendering it returns the terminal to column 0 so later text
 * overwrites the row, and wrapping may split the option into stacked rows.
 * Both symptoms have the same fix at our boundary:
 *
 * - `\r\n` → `\n` keeps genuine multi-line content (preview markdown) intact.
 * - a lone `\r` is deleted — never a space (phantom gaps inside words) and
 *   never `\n` (reintroduces the vertical fragmentation). This matches
 *   pi-coding-agent's own display normalization (`normalizeDisplayText`).
 */
export function normalizeLineTerminators(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "");
}

/**
 * Copy `obj`, normalizing the listed keys that hold strings. Keys absent from
 * `obj` (e.g. an omitted `preview`) stay absent so `"preview" in option`
 * checks and `hasPreview` derivations are unchanged.
 */
function normalizeStringFields<T extends object>(obj: T, keys: readonly (keyof T)[]): T {
	const out = { ...obj };
	for (const key of keys) {
		const value = obj[key];
		if (typeof value === "string") out[key] = normalizeLineTerminators(value) as T[typeof key];
	}
	return out;
}

/**
 * Return a copy of the tool params with every user-facing string field
 * (`question`, `header`, `options[].label`, `options[].description`,
 * `options[].preview`) line-terminator-normalized. Runs once at tool entry,
 * BEFORE `validateQuestionnaire`, so the reserved-label and duplicate-label
 * guards compare the text the user will actually see (`"Other\r"` must not
 * slip past `reserved_label`), and so the TUI, the RPC dialog walker and the
 * envelope echo all carry the same clean text. Pure: the input object is never
 * mutated.
 */
export function normalizeQuestionParams(params: QuestionParams): QuestionParams {
	return {
		...params,
		questions: params.questions.map((q) => ({
			...normalizeStringFields(q, ["question", "header"]),
			options: q.options.map((o) => normalizeStringFields(o, ["label", "description", "preview"])),
		})),
	};
}
