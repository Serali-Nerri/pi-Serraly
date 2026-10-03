/**
 * `apply_patch.v1` wire contract shared by the producer (`pi-tools`) and the
 * presentation parser (`pi-ui`).
 *
 * This library owns the format identifier, the four output budgets and the wire
 * type declarations. Both sides keep their own policy: the producer owns its diff
 * algorithm, work/edit/time budgets and truncation strategy; the consumer owns its
 * change/view defence thresholds, sanitizer and degradation for unknown shapes.
 */

/** Format identifier carried by every `apply_patch` report. */
export const APPLY_PATCH_FORMAT = "apply_patch.v1";
/** Maximum rows of diff text kept for a single view. */
export const PER_VIEW_DIFF_MAX_LINES = 200;
/** Maximum bytes of diff text kept for a single view. */
export const PER_VIEW_DIFF_MAX_BYTES = 16 * 1024;
/** Maximum diff rows kept across one report. */
export const TOTAL_DIFF_MAX_LINES = 600;
/** Maximum diff bytes kept across one report. */
export const TOTAL_DIFF_MAX_BYTES = 64 * 1024;

export interface ApplyPatchFileFacts {
	exists: boolean;
	bytes: number;
	lines: number;
	bom: boolean;
	endings: { lf: number; crlf: number; cr: number };
	finalNewline: boolean;
}

export type ApplyPatchRole = "file" | "move" | "source-delete" | "destination";
export type ApplyPatchAvailability = "complete" | "truncated" | "omitted";
export type ApplyPatchReason = "work-limit" | "result-limit" | "diff-error" | "cancelled";

export interface ApplyPatchView {
	role: ApplyPatchRole;
	before: ApplyPatchFileFacts;
	after: ApplyPatchFileFacts;
	added: number | null;
	removed: number | null;
	diff?: string;
	availability: ApplyPatchAvailability;
	reason?: ApplyPatchReason;
	diffTotalLines?: number;
	lineEndingsChanged: boolean;
}

export interface ApplyPatchChange {
	kind: "add" | "update" | "delete";
	path: string;
	moveFrom?: string;
	/**
	 * Move metadata: whether the captured destination text differs from the
	 * captured source text. Present only for moves whose snapshots are known.
	 */
	contentChanged?: boolean;
	views: ApplyPatchView[];
}

export interface ApplyPatchReport {
	format: typeof APPLY_PATCH_FORMAT;
	changes: ApplyPatchChange[];
	reportUnavailable?: "diff-error";
}
