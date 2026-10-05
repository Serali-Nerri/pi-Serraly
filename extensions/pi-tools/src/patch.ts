/**
 * apply_patch parser and text updater (no filesystem access).
 *
 * Behavior notes:
 *  - The parser is buffered; it does not stream.
 *  - `*** Environment ID:` is recognized and rejected with an explicit error.
 *  - Patch paths are validated (non-empty, no NUL) at parse time.
 *  - A duplicate `*** Move to:` header gets its own error message.
 *  - A leading UTF-8 BOM is stripped before matching and restored afterwards.
 *  - Overlapping or out-of-order replacements are rejected instead of applied.
 *  - No-op updates preserve the original bytes instead of adding a newline.
 */

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

export interface Chunk {
	/** Optional `@@ ...` anchor line that narrows down where the chunk applies. */
	context?: string;
	/** Lines removed (or matched as context) from the existing file. */
	oldLines: string[];
	/** Lines written in place of `oldLines`. */
	newLines: string[];
	/** `[oldIndex, newIndex]` pairs marking lines parsed as context. */
	contextLines: Array<[number, number]>;
	/** When true, `oldLines` should be matched at the end of the file. */
	eof: boolean;
}

export type Hunk =
	| { type: "add"; path: string; content: string }
	| { type: "delete"; path: string }
	| { type: "update"; path: string; moveTo?: string; chunks: Chunk[] };

// ---------------------------------------------------------------------------
// Patch markers (apply-patch grammar)
// ---------------------------------------------------------------------------

const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";
const EOF_MARKER = "*** End of File";
const CHANGE_CONTEXT_MARKER = "@@ ";
const EMPTY_CHANGE_CONTEXT_MARKER = "@@";
const ENVIRONMENT_ID_MARKER = "*** Environment ID:";

const VALID_HUNK_HEADERS =
	"Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'";

function invalidPatch(message: string): Error {
	return new Error(`invalid patch: ${message}`);
}

function invalidHunk(lineNumber: number, message: string): Error {
	return new Error(`invalid hunk at line ${lineNumber}, ${message}`);
}

function checkPatchPath(path: string, lineNumber: number): void {
	if (path.length === 0) throw invalidHunk(lineNumber, "file path must not be empty");
	if (path.includes("\u0000")) throw invalidHunk(lineNumber, "file path must not contain NUL");
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse an apply_patch document into hunks.
 *
 * Accepts the lenient form: leading/trailing whitespace around
 * markers, CRLF input, and optional `<<EOF` / `<<'EOF'` / `<<"EOF"` heredoc
 * wrappers. Throws an `Error` with a line number for malformed patches.
 */
export function parsePatch(input: string): Hunk[] {
	const text = input.trim();
	if (text.length === 0) {
		throw invalidPatch("the patch is empty; expected '*** Begin Patch' as the first line");
	}
	const rawLines = text.split("\n");
	const lines = rawLines.map((line, index) =>
		index < rawLines.length - 1 && line.endsWith("\r") ? line.slice(0, -1) : line,
	);
	return parsePatchLines(checkPatchBoundaries(lines));
}

/** Validates the first/last lines, unwrapping a lenient heredoc if present. */
function checkPatchBoundaries(lines: string[]): string[] {
	try {
		checkPatchMarkers(lines);
		return lines;
	} catch (error) {
		const first = lines[0];
		const last = lines[lines.length - 1];
		const isHeredoc =
			lines.length >= 4 &&
			(first === "<<EOF" || first === "<<'EOF'" || first === "<<\"EOF\"") &&
			last !== undefined &&
			last.endsWith("EOF");
		if (!isHeredoc) throw error;
		const inner = lines.slice(1, -1);
		checkPatchMarkers(inner);
		return inner;
	}
}

function checkPatchMarkers(lines: string[]): void {
	const first = lines[0]?.trim();
	const last = lines[lines.length - 1]?.trim();
	if (first === BEGIN_PATCH_MARKER && last === END_PATCH_MARKER) return;
	if (first !== BEGIN_PATCH_MARKER) {
		throw invalidPatch("The first line of the patch must be '*** Begin Patch'");
	}
	throw invalidPatch("The last line of the patch must be '*** End Patch'");
}

type ParseMode = "notStarted" | "started" | "addFile" | "deleteFile" | "updateFile" | "endedPatch";

function newChunk(context?: string): Chunk {
	const chunk: Chunk = { oldLines: [], newLines: [], contextLines: [], eof: false };
	if (context !== undefined) chunk.context = context;
	return chunk;
}

function pushContextLine(chunk: Chunk, text: string): void {
	chunk.contextLines.push([chunk.oldLines.length, chunk.newLines.length]);
	chunk.oldLines.push(text);
	chunk.newLines.push(text);
}

/**
 * Buffered parser: `lines` are already
 * free of line terminators and line numbers are 1-based over the patch text.
 */
function parsePatchLines(lines: string[]): Hunk[] {
	const hunks: Hunk[] = [];
	let mode: ParseMode = "notStarted";
	let updateHunkLineNumber = 0;

	const updateHunk = (): (Hunk & { type: "update" }) | undefined => {
		const hunk = hunks[hunks.length - 1];
		return hunk !== undefined && hunk.type === "update" ? hunk : undefined;
	};

	const ensureUpdateHunkIsNotEmpty = (line: string, lineNumber: number): void => {
		const hunk = updateHunk();
		if (hunk === undefined) return;
		if (hunk.chunks.length === 0 && mode === "updateFile") {
			throw invalidHunk(updateHunkLineNumber, `Update file hunk for path '${hunk.path}' is empty`);
		}
		const last = hunk.chunks[hunk.chunks.length - 1];
		if (last !== undefined && last.oldLines.length === 0 && last.newLines.length === 0) {
			if (line === END_PATCH_MARKER) {
				throw invalidHunk(lineNumber, "Update hunk does not contain any lines");
			}
			throw invalidHunk(
				lineNumber,
				`Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
			);
		}
	};

	const handleHunkHeadersAndEndPatch = (line: string, lineNumber: number): boolean => {
		if (line.startsWith(ENVIRONMENT_ID_MARKER)) {
			throw invalidPatch(`apply_patch environment_id is not supported (line ${lineNumber})`);
		}
		if (line === END_PATCH_MARKER) {
			ensureUpdateHunkIsNotEmpty(line, lineNumber);
			mode = "endedPatch";
			return true;
		}
		if (line.startsWith(ADD_FILE_MARKER)) {
			ensureUpdateHunkIsNotEmpty(line, lineNumber);
			const path = line.slice(ADD_FILE_MARKER.length);
			checkPatchPath(path, lineNumber);
			hunks.push({ type: "add", path, content: "" });
			mode = "addFile";
			return true;
		}
		if (line.startsWith(DELETE_FILE_MARKER)) {
			ensureUpdateHunkIsNotEmpty(line, lineNumber);
			const path = line.slice(DELETE_FILE_MARKER.length);
			checkPatchPath(path, lineNumber);
			hunks.push({ type: "delete", path });
			mode = "deleteFile";
			return true;
		}
		if (line.startsWith(UPDATE_FILE_MARKER)) {
			ensureUpdateHunkIsNotEmpty(line, lineNumber);
			const path = line.slice(UPDATE_FILE_MARKER.length);
			checkPatchPath(path, lineNumber);
			hunks.push({ type: "update", path, chunks: [] });
			updateHunkLineNumber = lineNumber;
			mode = "updateFile";
			return true;
		}
		return false;
	};

	const chunkForLine = (chunks: Chunk[]): Chunk => {
		if (chunks.length === 0) chunks.push(newChunk());
		const chunk = chunks[chunks.length - 1];
		if (chunk === undefined) throw invalidPatch("internal parser error: missing update chunk");
		return chunk;
	};

	const processUpdateLine = (line: string, lineNumber: number): void => {
		const updateLine = line.trimEnd();
		if (handleHunkHeadersAndEndPatch(updateLine, lineNumber)) return;
		const hunk = updateHunk();
		if (hunk === undefined) throw invalidPatch("internal parser error: missing update hunk");
		const chunks = hunk.chunks;
		const last = chunks[chunks.length - 1];

		if (updateLine.startsWith(MOVE_TO_MARKER) && hunk.moveTo !== undefined) {
			throw invalidHunk(lineNumber, `duplicate '*** Move to:' header: already moving to '${hunk.moveTo}'`);
		}
		if (last !== undefined && last.eof) {
			if (updateLine === "") return;
			if (updateLine !== EMPTY_CHANGE_CONTEXT_MARKER && !updateLine.startsWith(CHANGE_CONTEXT_MARKER)) {
				throw invalidHunk(lineNumber, `Expected update hunk to start with a @@ context marker, got: '${line}'`);
			}
		}
		if (chunks.length === 0 && hunk.moveTo === undefined && updateLine.startsWith(MOVE_TO_MARKER)) {
			const moveTo = updateLine.slice(MOVE_TO_MARKER.length);
			checkPatchPath(moveTo, lineNumber);
			hunk.moveTo = moveTo;
			return;
		}
		if (
			(updateLine === EMPTY_CHANGE_CONTEXT_MARKER || updateLine.startsWith(CHANGE_CONTEXT_MARKER)) &&
			last !== undefined &&
			last.oldLines.length === 0 &&
			last.newLines.length === 0
		) {
			throw invalidHunk(
				lineNumber,
				`Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
			);
		}
		if (updateLine === EMPTY_CHANGE_CONTEXT_MARKER) {
			chunks.push(newChunk());
			return;
		}
		if (updateLine.startsWith(CHANGE_CONTEXT_MARKER)) {
			chunks.push(newChunk(updateLine.slice(CHANGE_CONTEXT_MARKER.length)));
			return;
		}
		if (updateLine === EOF_MARKER) {
			if (last !== undefined && last.oldLines.length === 0 && last.newLines.length === 0) {
				throw invalidHunk(lineNumber, "Update hunk does not contain any lines");
			}
			if (last !== undefined) last.eof = true;
			return;
		}
		if (line === "") {
			pushContextLine(chunkForLine(chunks), "");
			return;
		}
		if (line.startsWith(" ")) {
			pushContextLine(chunkForLine(chunks), line.slice(1));
			return;
		}
		if (line.startsWith("+")) {
			chunkForLine(chunks).newLines.push(line.slice(1));
			return;
		}
		if (line.startsWith("-")) {
			chunkForLine(chunks).oldLines.push(line.slice(1));
			return;
		}
		if (last !== undefined && (last.oldLines.length > 0 || last.newLines.length > 0)) {
			throw invalidHunk(lineNumber, `Expected update hunk to start with a @@ context marker, got: '${line}'`);
		}
		throw invalidHunk(
			lineNumber,
			`Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
		);
	};

	const processLine = (line: string, lineNumber: number): void => {
		const trimmed = line.trim();
		if (mode === "notStarted") {
			if (trimmed === BEGIN_PATCH_MARKER) {
				mode = "started";
				return;
			}
			throw invalidPatch("The first line of the patch must be '*** Begin Patch'");
		}
		if (mode === "started") {
			if (handleHunkHeadersAndEndPatch(trimmed, lineNumber)) return;
			throw invalidHunk(lineNumber, `'${trimmed}' is not a valid hunk header. ${VALID_HUNK_HEADERS}`);
		}
		if (mode === "addFile") {
			if (handleHunkHeadersAndEndPatch(trimmed, lineNumber)) return;
			if (line.startsWith("+")) {
				const hunk = hunks[hunks.length - 1];
				if (hunk !== undefined && hunk.type === "add") {
					hunk.content += `${line.slice(1)}\n`;
					return;
				}
			}
			throw invalidHunk(lineNumber, `'${trimmed}' is not a valid hunk header. ${VALID_HUNK_HEADERS}`);
		}
		if (mode === "deleteFile") {
			if (handleHunkHeadersAndEndPatch(trimmed, lineNumber)) return;
			throw invalidHunk(lineNumber, `'${trimmed}' is not a valid hunk header. ${VALID_HUNK_HEADERS}`);
		}
		if (mode === "updateFile") {
			processUpdateLine(line, lineNumber);
			return;
		}
		if (trimmed === "") return;
		throw invalidPatch("The last line of the patch must be '*** End Patch'");
	};

	const parseEnded = (): boolean => mode === "endedPatch";

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const lineNumber = index + 1;
		// A padded `*** End Patch` is accepted even in update hunks when it is
		// the final line.
		if (index === lines.length - 1 && line.trim() === END_PATCH_MARKER) {
			handleHunkHeadersAndEndPatch(line.trim(), lineNumber);
			continue;
		}
		processLine(line, lineNumber);
	}
	if (!parseEnded()) {
		throw invalidPatch("The last line of the patch must be '*** End Patch'");
	}
	return hunks;
}

// ---------------------------------------------------------------------------
// Fuzzy line seeking (ported from seek_sequence.rs)
// ---------------------------------------------------------------------------

const NORMALIZED_PUNCTUATION: Record<string, string> = {
	"‐": "-",
	"‑": "-",
	"‒": "-",
	"–": "-",
	"—": "-",
	"―": "-",
	"−": "-",
	"‘": "'",
	"’": "'",
	"‚": "'",
	"‛": "'",
	"“": "\"",
	"”": "\"",
	"„": "\"",
	"‟": "\"",
	" ": " ",
	" ": " ",
	" ": " ",
	" ": " ",
	" ": " ",
	" ": " ",
	" ": " ",
	" ": " ",
	" ": " ",
	" ": " ",
	" ": " ",
	" ": " ",
	"　": " ",
};

function normalizePunctuation(value: string): string {
	let result = "";
	for (const char of value.trim()) result += NORMALIZED_PUNCTUATION[char] ?? char;
	return result;
}

function equalSlice(lines: string[], start: number, pattern: string[], compare: (a: string, b: string) => boolean): boolean {
	for (let offset = 0; offset < pattern.length; offset += 1) {
		if (!compare(lines[start + offset] ?? "", pattern[offset] ?? "")) return false;
	}
	return true;
}

/**
 * Find `pattern` in `lines` at or after `start`, with decreasing strictness:
 * exact, rstrip, trim, then Unicode punctuation normalization. When `eof` is
 * set, searching starts at the last possible position so end-of-file patterns
 * bind to the file end (but never before `start`, which keeps chunks from
 * matching an already-updated region).
 */
function seekSequence(lines: string[], pattern: string[], start: number, eof: boolean): number | null {
	if (pattern.length === 0) return start;
	if (pattern.length > lines.length) return null;
	const lastStart = lines.length - pattern.length;
	const searchStart = eof ? Math.max(lastStart, start) : start;

	for (let index = searchStart; index <= lastStart; index += 1) {
		if (equalSlice(lines, index, pattern, (a, b) => a === b)) return index;
	}
	for (let index = searchStart; index <= lastStart; index += 1) {
		if (equalSlice(lines, index, pattern, (a, b) => a.trimEnd() === b.trimEnd())) return index;
	}
	for (let index = searchStart; index <= lastStart; index += 1) {
		if (equalSlice(lines, index, pattern, (a, b) => a.trim() === b.trim())) return index;
	}
	for (let index = searchStart; index <= lastStart; index += 1) {
		if (equalSlice(lines, index, pattern, (a, b) => normalizePunctuation(a) === normalizePunctuation(b))) return index;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Source file model (ported from text_file.rs, PreserveLineEndings mode)
// ---------------------------------------------------------------------------

interface SourceLine {
	text: string;
	ending: string | null;
}

interface Replacement {
	start: number;
	oldLen: number;
	newLines: string[];
}

/** Splits contents into lines while retaining each line's terminator. */
function parseSourceFile(contents: string): { lines: SourceLine[]; preferredEnding: string } {
	const lines: SourceLine[] = [];
	let preferredEnding: string | null = null;
	let lineStart = 0;
	let cursor = 0;
	while (cursor < contents.length) {
		let ending: string | null = null;
		if (contents[cursor] === "\r" && contents[cursor + 1] === "\n") ending = "\r\n";
		else if (contents[cursor] === "\r") ending = "\r";
		else if (contents[cursor] === "\n") ending = "\n";
		if (ending === null) {
			cursor += 1;
			continue;
		}
		if (preferredEnding === null) preferredEnding = ending;
		lines.push({ text: contents.slice(lineStart, cursor), ending });
		cursor += ending.length;
		lineStart = cursor;
	}
	if (lineStart < contents.length) {
		lines.push({ text: contents.slice(lineStart), ending: null });
	}
	return { lines, preferredEnding: preferredEnding ?? "\n" };
}

function renderSourceFile(lines: SourceLine[]): string {
	let result = "";
	for (const line of lines) {
		result += line.text;
		if (line.ending !== null) result += line.ending;
	}
	return result;
}

/**
 * Rebuilds the file from source-ordered, non-overlapping replacements.
 * Unchanged lines keep their original terminators, inserted lines use the
 * preferred terminator, and every remaining line receives a terminator when
 * the line contents change.
 */
function applyReplacements(lines: SourceLine[], preferredEnding: string, replacements: Replacement[]): SourceLine[] {
	const result: SourceLine[] = [];
	let sourceIndex = 0;
	for (const replacement of replacements) {
		while (sourceIndex < replacement.start) {
			const line = lines[sourceIndex];
			if (line === undefined) break;
			result.push(line);
			sourceIndex += 1;
		}
		sourceIndex += replacement.oldLen;
		for (const text of replacement.newLines) result.push({ text, ending: preferredEnding });
	}
	while (sourceIndex < lines.length) {
		const line = lines[sourceIndex];
		if (line === undefined) break;
		result.push(line);
		sourceIndex += 1;
	}
	// Deletions and insertions can cancel out even across context boundaries.
	// Check the line contents before normalizing any terminators.
	if (result.length === lines.length && result.every((line, index) => line.text === lines[index]?.text)) {
		return lines;
	}
	for (const line of result) {
		if (line.ending === null) line.ending = preferredEnding;
	}
	return result;
}

// ---------------------------------------------------------------------------
// Patch application (ported from file_update.rs, PreserveLineEndings mode)
// ---------------------------------------------------------------------------

function computeReplacements(originalLines: string[], path: string, chunks: Chunk[]): Replacement[] {
	const replacements: Replacement[] = [];
	let lineIndex = 0;

	for (const chunk of chunks) {
		if (chunk.context !== undefined) {
			const contextIndex = seekSequence(originalLines, [chunk.context], lineIndex, false);
			if (contextIndex === null) {
				throw new Error(`Failed to find context '${chunk.context}' in ${path}`);
			}
			lineIndex = contextIndex + 1;
		}

		if (chunk.oldLines.length === 0) {
			// Pure additions append at the end of the file.
			replacements.push({ start: originalLines.length, oldLen: 0, newLines: [...chunk.newLines] });
			continue;
		}

		let pattern = chunk.oldLines;
		let newSlice = chunk.newLines;
		let found = seekSequence(originalLines, pattern, lineIndex, chunk.eof);
		if (found === null && pattern[pattern.length - 1] === "") {
			// Retry without the trailing empty line that represents the final newline.
			pattern = pattern.slice(0, -1);
			if (newSlice[newSlice.length - 1] === "") newSlice = newSlice.slice(0, -1);
			found = seekSequence(originalLines, pattern, lineIndex, chunk.eof);
		}
		if (found === null) {
			throw new Error(`Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`);
		}

		// Keep context lines in place so their exact bytes and terminators survive
		// when a fuzzy (whitespace/punctuation) match was used to locate the chunk.
		let oldStart = 0;
		let newStart = 0;
		for (const [oldContext, newContext] of chunk.contextLines) {
			if (oldContext >= pattern.length || newContext >= newSlice.length) break;
			if (oldContext < oldStart || newContext < newStart) {
				throw new Error(`Failed to apply update to ${path}: context line indices are out of order`);
			}
			if (oldStart !== oldContext || newStart !== newContext) {
				replacements.push({
					start: found + oldStart,
					oldLen: oldContext - oldStart,
					newLines: newSlice.slice(newStart, newContext),
				});
			}
			oldStart = oldContext + 1;
			newStart = newContext + 1;
		}
		if (oldStart !== pattern.length || newStart !== newSlice.length) {
			replacements.push({
				start: found + oldStart,
				oldLen: pattern.length - oldStart,
				newLines: newSlice.slice(newStart),
			});
		}
		lineIndex = found + pattern.length;
	}

	replacements.sort((a, b) => a.start - b.start);
	for (let index = 1; index < replacements.length; index += 1) {
		const previous = replacements[index - 1];
		const current = replacements[index];
		if (previous === undefined || current === undefined) continue;
		if (current.start < previous.start + previous.oldLen) {
			throw new Error(`Failed to apply update to ${path}: overlapping replacements`);
		}
	}
	return replacements;
}

/**
 * Apply update chunks to the contents of an existing file and return the new
 * contents. Preserves per-line terminators and a leading BOM; new lines use
 * the file's first existing terminator style. No-op updates retain the original
 * bytes; actual edits produce newline-terminated non-empty results.
 */
export function applyUpdate(content: string, chunks: Chunk[], path: string): string {
	const hasBom = content.startsWith("﻿");
	const body = hasBom ? content.slice(1) : content;
	const { lines, preferredEnding } = parseSourceFile(body);
	const originalLines = lines.map((line) => line.text);
	// Match and validate every chunk first, including no-ops. Compare against
	// the actual source, not the patch's old lines: fuzzy matches can differ.
	const replacements = computeReplacements(originalLines, path, chunks).filter((replacement) =>
		replacement.oldLen !== replacement.newLines.length ||
		replacement.newLines.some((line, index) => line !== originalLines[replacement.start + index]),
	);
	if (replacements.length === 0) return content;
	const updated = renderSourceFile(applyReplacements(lines, preferredEnding, replacements));
	return hasBom && updated.length > 0 ? `\uFEFF${updated}` : updated;
}
