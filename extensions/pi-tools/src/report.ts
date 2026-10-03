/**
 * Pure post-commit presentation report for `apply_patch` (`apply_patch.v1`).
 *
 * The report is derived from the immutable snapshots captured under the commit
 * locks. It never reads or writes the filesystem, never re-reads a target, and
 * embeds no ANSI styling. A failure here must never turn a committed patch into
 * a failure: every projection is bounded, per-view degradation is expressed
 * through `availability`/`reason`, and any unexpected construction error falls
 * back to `reportUnavailable: "diff-error"` with the change list preserved.
 *
 * Facts are computed from the raw snapshot text (real UTF-8 bytes, BOM,
 * line-ending histogram, logical line count, final terminator). The display
 * diff uses a copy with the leading BOM removed, CRLF/CR normalized to LF, and
 * a canonical trailing newline, so terminator-only edits cannot masquerade as
 * line changes: they report +0/-0 and surface through the fact fields instead.
 *
 * `lineEndingsChanged` is true when an ending kind appears or disappears, or
 * when a mixed file's terminator distribution/order changes. Ordinary edits
 * in a single-style file are not ending changes. A side with no terminator
 * is covered by `finalNewline`/`bytes` rather than this flag.
 *
 * A move change carries an optional `contentChanged` comparing the captured
 * source text with the captured destination text. It is present only when the
 * snapshots make that comparison possible; a degraded report never guesses.
 *
 * Diff rows use Pi's edit display format (`+17 text`, `-17 text`, ` 17 text`).
 * Update views run one jsdiff search with edit-distance and time budgets;
 * adds and deletes are counted linearly. Output budgets are applied with
 * truncateHead over complete lines, so a giant first line is omitted rather
 * than cut. `added`/`removed` are the complete logical diff statistics computed
 * before any truncation; an unknown count stays `null` and is never reported as
 * 0. `diff` is a string whenever the availability is `complete` or `truncated`
 * (it may be empty when the logical diff has no rows) and is absent only when
 * the diff is omitted. `diffTotalLines` is the complete diff row count whenever
 * it is known.
 */
import { truncateHead } from "@earendil-works/pi-coding-agent";
import {
	APPLY_PATCH_FORMAT,
	PER_VIEW_DIFF_MAX_BYTES,
	PER_VIEW_DIFF_MAX_LINES,
	TOTAL_DIFF_MAX_BYTES,
	TOTAL_DIFF_MAX_LINES,
	type ApplyPatchChange,
	type ApplyPatchFileFacts,
	type ApplyPatchReason,
	type ApplyPatchReport,
	type ApplyPatchRole,
	type ApplyPatchView,
} from "pi-apply-patch-protocol";
import { generateBoundedDiff, type BoundedDiff } from "./diff.ts";
import type { Change, ChangeSnapshot, PatchOutcome } from "./files.ts";

/** Largest combined normalized text for which a diff search may run. */
export const MAX_NORMALIZED_DIFF_BYTES = 2 * 1024 * 1024;
/** Largest combined logical line count for which a diff search may run. */
export const MAX_DIFF_LOGICAL_LINES = 50_000;
/** Maximum actual inserted/deleted lines searched for in one view. */
export const MAX_DIFF_EDIT_LENGTH = 1_000;
/** Successful searches charge actual edits; exhausted searches charge their allowance. */
export const TOTAL_DIFF_EDIT_BUDGET = 4_000;
/** Cooperative search deadlines; not hard real-time limits on all report processing. */
export const MAX_DIFF_SEARCH_MS = 250;
export const TOTAL_DIFF_SEARCH_MS = 1_000;

const FORMAT = APPLY_PATCH_FORMAT;

/** Wire names used throughout this producer; the contract lives in the protocol library. */
type FileFacts = ApplyPatchFileFacts;
type ViewRole = ApplyPatchRole;
type ReportView = ApplyPatchView;
type ReportChange = ApplyPatchChange;
type Reason = ApplyPatchReason;

interface TextInfo {
	raw: string;
	facts: FileFacts;
}

interface ViewSeed {
	role: ViewRole;
	before: FileFacts;
	after: FileFacts;
	lineEndingsChanged: boolean;
}

interface BuildState {
	generateDiff: typeof generateBoundedDiff;
	aborted: boolean;
	now: () => number;
	deadline: number;
	editsLeft: number;
	output: { rows: number; bytes: number };
}

interface ReportOptions {
	signal?: AbortSignal;
	generateDiff?: typeof generateBoundedDiff;
	/** Monotonic clock injection for deterministic deadline tests. */
	now?: () => number;
}

interface DiffFit {
	availability: "complete" | "truncated" | "omitted";
	reason?: "result-limit";
	diff?: string;
	diffTotalLines: number;
}

interface FormattedRows {
	text: string;
	rows: number;
	bytes: number;
	truncated: boolean;
}

export function buildPatchReport(
	outcome: PatchOutcome,
	options: ReportOptions = {},
): ApplyPatchReport {
	try {
		return buildReport(outcome, options);
	} catch {
		return unavailableReport(outcome);
	}
}

function buildReport(
	outcome: PatchOutcome,
	options: ReportOptions,
): ApplyPatchReport {
	const snapshots = new Map<string, ChangeSnapshot>();
	for (const snapshot of outcome.snapshots ?? []) snapshots.set(snapshot.path, snapshot);
	const now = options.now ?? (() => performance.now());
	const state: BuildState = {
		generateDiff: options.generateDiff ?? generateBoundedDiff,
		aborted: options.signal?.aborted === true,
		now,
		deadline: now() + TOTAL_DIFF_SEARCH_MS,
		editsLeft: TOTAL_DIFF_EDIT_BUDGET,
		output: { rows: TOTAL_DIFF_MAX_LINES, bytes: TOTAL_DIFF_MAX_BYTES },
	};
	const changes = (outcome.changes ?? []).map((change): ReportChange => {
		const snapshot = snapshots.get(change.path);
		if (snapshot === undefined || snapshot.kind !== change.kind || snapshot.moveFrom !== change.moveFrom) {
			throw new Error(`Missing or inconsistent change snapshot: ${JSON.stringify(change.path)}`);
		}
		if (change.moveFrom === undefined) return { ...change, views: buildViews(change, snapshot, state) };
		const contentChanged = movedContentChanged(snapshot);
		const views = buildViews(change, snapshot, state);
		return contentChanged === undefined ? { ...change, views } : { ...change, contentChanged, views };
	});
	return { format: FORMAT, changes };
}

/** Captured source vs. final destination bytes; unknown if either side is absent. */
function movedContentChanged(snapshot: ChangeSnapshot): boolean | undefined {
	if (typeof snapshot.sourceBefore !== "string" || typeof snapshot.after !== "string") return undefined;
	return snapshot.sourceBefore !== snapshot.after;
}

/** Last-resort report: keep the change list, claim nothing about content. */
function unavailableReport(outcome: PatchOutcome): ApplyPatchReport {
	let changes: ReportChange[] = [];
	try {
		changes = (outcome?.changes ?? []).map((change): ReportChange => ({ ...change, views: [] }));
	} catch {
		changes = [];
	}
	return { format: FORMAT, changes, reportUnavailable: "diff-error" };
}

function buildViews(change: Change, snapshot: ChangeSnapshot, state: BuildState): ReportView[] {
	if (change.moveFrom !== undefined) {
		if (typeof snapshot.sourceBefore !== "string") {
			throw new Error(`Move snapshot has no source text: ${JSON.stringify(change.path)}`);
		}
		if (snapshot.before == null) return [buildView("move", snapshot.sourceBefore, snapshot.after, state)];
		return [
			buildView("source-delete", snapshot.sourceBefore, null, state),
			buildView("destination", snapshot.before, snapshot.after, state),
		];
	}
	return [buildView("file", snapshot.before, snapshot.after, state)];
}

function buildView(role: ViewRole, beforeText: string | null, afterText: string | null, state: BuildState): ReportView {
	const beforeInfo = beforeText === null ? null : analyze(beforeText);
	const afterInfo = afterText === null ? null : analyze(afterText);
	const seed: ViewSeed = {
		role,
		before: beforeInfo?.facts ?? absentFacts(),
		after: afterInfo?.facts ?? absentFacts(),
		lineEndingsChanged: endingsChanged(beforeInfo, afterInfo),
	};
	if (state.aborted) {
		return { ...seed, added: null, removed: null, availability: "omitted", reason: "cancelled" };
	}
	if (beforeInfo !== null && afterInfo !== null) return textChangeView(seed, beforeInfo, afterInfo, state);
	if (beforeInfo === null && afterInfo !== null) return linearView(seed, afterInfo, "+", state);
	if (beforeInfo !== null && afterInfo === null) return linearView(seed, beforeInfo, "-", state);
	// Neither side exists: a real change list should not contain this, but a
	// deterministic empty view is safer than failing the whole report.
	return { ...seed, added: 0, removed: 0, availability: "complete", diff: "", diffTotalLines: 0 };
}

function textChangeView(seed: ViewSeed, before: TextInfo, after: TextInfo, state: BuildState): ReportView {
	const beforeDisplay = displayText(before.raw);
	const afterDisplay = displayText(after.raw);
	if (beforeDisplay === afterDisplay) {
		return { ...seed, added: 0, removed: 0, availability: "complete", diff: "", diffTotalLines: 0 };
	}
	if (
		Buffer.byteLength(beforeDisplay, "utf8") + Buffer.byteLength(afterDisplay, "utf8") > MAX_NORMALIZED_DIFF_BYTES ||
		before.facts.lines + after.facts.lines > MAX_DIFF_LOGICAL_LINES
	) {
		return { ...seed, added: null, removed: null, availability: "omitted", reason: "work-limit" };
	}
	const timeLeft = state.deadline - state.now();
	if (!(timeLeft > 0) || state.editsLeft <= 0) {
		return { ...seed, added: null, removed: null, availability: "omitted", reason: "work-limit" };
	}
	const allowance = Math.min(MAX_DIFF_EDIT_LENGTH, state.editsLeft);
	// Reserve first: failed/aborted searches must not be retried for free.
	state.editsLeft -= allowance;
	let generated: BoundedDiff;
	try {
		const result = state.generateDiff(beforeDisplay, afterDisplay, {
			maxEditLength: allowance,
			timeout: Math.min(MAX_DIFF_SEARCH_MS, timeLeft),
		});
		if (result === undefined) {
			return { ...seed, added: null, removed: null, availability: "omitted", reason: "work-limit" };
		}
		if (typeof result.diff !== "string" || !Number.isSafeInteger(result.added) ||
				!Number.isSafeInteger(result.removed) || result.added < 0 || result.removed < 0 ||
				result.added + result.removed > allowance) {
			throw new Error("Invalid bounded diff result");
		}
		generated = result;
	} catch {
		return { ...seed, added: null, removed: null, availability: "omitted", reason: "diff-error" };
	}
	state.editsLeft += allowance - generated.added - generated.removed;
	return { ...seed, added: generated.added, removed: generated.removed, ...fitDiff(generated.diff, state) };
}

function linearView(seed: ViewSeed, info: TextInfo, marker: "+" | "-", state: BuildState): ReportView {
	const totalLines = info.facts.lines;
	const stats = marker === "+" ? { added: totalLines, removed: 0 } : { added: 0, removed: totalLines };
	if (totalLines === 0) {
		return { ...seed, ...stats, availability: "complete", diff: "", diffTotalLines: 0 };
	}
	const maxLines = Math.min(PER_VIEW_DIFF_MAX_LINES, state.output.rows);
	const maxBytes = Math.min(PER_VIEW_DIFF_MAX_BYTES, state.output.bytes);
	if (maxLines <= 0 || maxBytes <= 0) {
		return { ...seed, ...stats, availability: "omitted", reason: "result-limit", diffTotalLines: totalLines };
	}
	const formatted = formatRows(logicalLines(info.raw), totalLines, marker, maxLines, maxBytes);
	state.output.rows -= formatted.rows;
	state.output.bytes -= formatted.bytes;
	if (!formatted.truncated) {
		return { ...seed, ...stats, availability: "complete", diff: formatted.text, diffTotalLines: totalLines };
	}
	if (formatted.text === "") {
		return { ...seed, ...stats, availability: "omitted", reason: "result-limit", diffTotalLines: totalLines };
	}
	return {
		...seed,
		...stats,
		availability: "truncated",
		reason: "result-limit",
		diff: formatted.text,
		diffTotalLines: totalLines,
	};
}

function fitDiff(fullText: string, state: BuildState): DiffFit {
	const totalLines = countRows(fullText);
	const maxLines = Math.min(PER_VIEW_DIFF_MAX_LINES, state.output.rows);
	const maxBytes = Math.min(PER_VIEW_DIFF_MAX_BYTES, state.output.bytes);
	if (maxLines <= 0 || maxBytes <= 0) {
		return { availability: "omitted", reason: "result-limit", diffTotalLines: totalLines };
	}
	const bounded = truncateHead(fullText, { maxLines, maxBytes });
	state.output.rows -= bounded.outputLines;
	state.output.bytes -= bounded.outputBytes;
	if (!bounded.truncated) {
		return { availability: "complete", diff: bounded.content, diffTotalLines: totalLines };
	}
	if (bounded.content === "") {
		// truncateHead returns no content when the first line alone exceeds the
		// byte budget; the view is omitted rather than cut mid-line.
		return { availability: "omitted", reason: "result-limit", diffTotalLines: totalLines };
	}
	return { availability: "truncated", reason: "result-limit", diff: bounded.content, diffTotalLines: totalLines };
}

/** Format add/delete rows linearly, stopping before any partial line/byte. */
function formatRows(lines: Iterable<string>, totalLines: number, marker: "+" | "-", maxLines: number, maxBytes: number): FormattedRows {
	const width = String(totalLines).length;
	let text = "";
	let rows = 0;
	let bytes = 0;
	for (const line of lines) {
		if (rows >= maxLines) return { text, rows, bytes, truncated: true };
		const row = `${marker}${String(rows + 1).padStart(width, " ")} ${line}`;
		const rowBytes = Buffer.byteLength(row, "utf8") + (rows > 0 ? 1 : 0);
		if (bytes + rowBytes > maxBytes) return { text, rows, bytes, truncated: true };
		text += (rows > 0 ? "\n" : "") + row;
		rows += 1;
		bytes += rowBytes;
	}
	return { text, rows, bytes, truncated: false };
}

function absentFacts(): FileFacts {
	return { exists: false, bytes: 0, lines: 0, bom: false, endings: { lf: 0, crlf: 0, cr: 0 }, finalNewline: false };
}

function analyze(raw: string): TextInfo {
	const bom = raw.charCodeAt(0) === 0xfeff;
	const body = bom ? raw.slice(1) : raw;
	let lf = 0;
	let crlf = 0;
	let cr = 0;
	for (let index = 0; index < body.length; index++) {
		const code = body.charCodeAt(index);
		if (code === 0x0d) {
			if (body.charCodeAt(index + 1) === 0x0a) {
				crlf += 1;
				index += 1;
			} else {
				cr += 1;
			}
		} else if (code === 0x0a) {
			lf += 1;
		}
	}
	const finalNewline = /[\r\n]$/u.test(body);
	return {
		raw,
		facts: {
			exists: true,
			bytes: Buffer.byteLength(raw, "utf8"),
			lines: lf + crlf + cr + (body.length > 0 && !finalNewline ? 1 : 0),
			bom,
			endings: { lf, crlf, cr },
			finalNewline,
		},
	};
}

/** Stream only the preview's needed logical lines, even for huge empty-line files. */
function* logicalLines(raw: string): Generator<string> {
	let start = raw.charCodeAt(0) === 0xfeff ? 1 : 0;
	const endings = /\r\n|\r|\n/gu;
	endings.lastIndex = start;
	let ending: RegExpExecArray | null;
	while ((ending = endings.exec(raw)) !== null) {
		yield raw.slice(start, ending.index);
		start = ending.index + ending[0].length;
	}
	if (start < raw.length) yield raw.slice(start);
}

/** Display copy: no BOM, LF-only terminators, canonical trailing newline. */
function displayText(raw: string): string {
	const body = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
	const normalized = body.replace(/\r\n|\r/gu, "\n");
	return normalized.length > 0 && !normalized.endsWith("\n") ? normalized + "\n" : normalized;
}

/** Logical lines of a display copy; a trailing newline adds no extra line. */
function splitLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function countRows(text: string): number {
	return splitLines(text).length;
}

function endingsChanged(before: TextInfo | null, after: TextInfo | null): boolean {
	if (before === null || after === null) return false;
	const was = before.facts.endings;
	const now = after.facts.endings;
	if (was.lf + was.crlf + was.cr === 0 || now.lf + now.crlf + now.cr === 0) return false;
	if ((was.lf > 0) !== (now.lf > 0) || (was.crlf > 0) !== (now.crlf > 0) || (was.cr > 0) !== (now.cr > 0)) return true;
	if (Number(was.lf > 0) + Number(was.crlf > 0) + Number(was.cr > 0) < 2) return false;
	// Compare mixed terminators without storing a per-line array; updates may
	// also change text while changing the ending of a rewritten line.
	const oldEndings = before.raw.matchAll(/\r\n|\r|\n/gu);
	const newEndings = after.raw.matchAll(/\r\n|\r|\n/gu);
	while (true) {
		const oldEnding = oldEndings.next();
		const newEnding = newEndings.next();
		if (oldEnding.done || newEnding.done) return oldEnding.done !== newEnding.done;
		if (oldEnding.value[0] !== newEnding.value[0]) return true;
	}
}
