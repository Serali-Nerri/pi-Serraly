/**
 * Tests for the Codex `apply_patch` port in ../src/patch.ts.
 *
 * Run with Node's native TypeScript support (no dependencies):
 *   node --test test/patch.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { applyUpdate, parsePatch } from "../src/patch.ts";
import type { Chunk } from "../src/patch.ts";

function errorMessage(action: () => unknown): string {
	try {
		action();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("expected the action to throw");
}

function firstUpdateChunks(patch: string): Chunk[] {
	const hunks = parsePatch(patch);
	assert.equal(hunks.length, 1);
	const hunk = hunks[0];
	assert.equal(hunk?.type, "update");
	if (hunk === undefined || hunk.type !== "update") throw new Error("unreachable");
	return hunk.chunks;
}

function chunk(overrides: Partial<Chunk>): Chunk {
	return { oldLines: [], newLines: [], contextLines: [], eof: false, ...overrides };
}

// ---------------------------------------------------------------------------
// Parser: happy paths
// ---------------------------------------------------------------------------

test("parsePatch: adds file content with LF endings", () => {
	assert.deepStrictEqual(
		parsePatch("*** Begin Patch\n*** Add File: path/to/new.txt\n+one\n+two\n*** End Patch"),
		[{ type: "add", path: "path/to/new.txt", content: "one\ntwo\n" }],
	);
	assert.deepStrictEqual(parsePatch("*** Begin Patch\n*** Add File: empty.txt\n*** End Patch"), [
		{ type: "add", path: "empty.txt", content: "" },
	]);
});

test("parsePatch: parses add, delete, update, and move hunks together", () => {
	const patch = [
		"*** Begin Patch",
		"*** Add File: path/add.py",
		"+abc",
		"+def",
		"*** Delete File: path/delete.py",
		"*** Update File: path/update.py",
		"*** Move to: path/update2.py",
		"@@ def f():",
		"-    pass",
		"+    return 123",
		"*** End Patch",
	].join("\n");
	assert.deepStrictEqual(parsePatch(patch), [
		{ type: "add", path: "path/add.py", content: "abc\ndef\n" },
		{ type: "delete", path: "path/delete.py" },
		{
			type: "update",
			path: "path/update.py",
			moveTo: "path/update2.py",
			chunks: [
				{
					context: "def f():",
					oldLines: ["    pass"],
					newLines: ["    return 123"],
					contextLines: [],
					eof: false,
				},
			],
		},
	]);
});

test("parsePatch: update chunk without a leading @@ marker", () => {
	const patch = "*** Begin Patch\n*** Update File: file2.py\n import foo\n+bar\n*** End Patch";
	assert.deepStrictEqual(parsePatch(patch), [
		{
			type: "update",
			path: "file2.py",
			chunks: [
				{
					oldLines: ["import foo"],
					newLines: ["import foo", "bar"],
					contextLines: [[0, 0]],
					eof: false,
				},
			],
		},
	]);
});

test("parsePatch: @@ anchors with and without context text", () => {
	const patch = [
		"*** Begin Patch",
		"*** Update File: f.py",
		"@@ def f():",
		"-old",
		"+new",
		"@@ extra context",
		"-x",
		"+y",
		"@@",
		"-z",
		"+w",
		"*** End Patch",
	].join("\n");
	const hunks = parsePatch(patch);
	assert.equal(hunks.length, 1);
	const hunk = hunks[0];
	assert.equal(hunk?.type, "update");
	if (hunk === undefined || hunk.type !== "update") throw new Error("unreachable");
	assert.deepStrictEqual(hunk.chunks, [
		{ context: "def f():", oldLines: ["old"], newLines: ["new"], contextLines: [], eof: false },
		{ context: "extra context", oldLines: ["x"], newLines: ["y"], contextLines: [], eof: false },
		{ oldLines: ["z"], newLines: ["w"], contextLines: [], eof: false },
	]);
});

test("parsePatch: bare blank lines inside updates are empty context lines", () => {
	const patch = [
		"*** Begin Patch",
		"*** Update File: file.txt",
		"@@",
		" context before",
		"",
		" context after",
		"*** End Patch",
	].join("\n");
	assert.deepStrictEqual(firstUpdateChunks(patch), [
		{
			oldLines: ["context before", "", "context after"],
			newLines: ["context before", "", "context after"],
			contextLines: [
				[0, 0],
				[1, 1],
				[2, 2],
			],
			eof: false,
		},
	]);
});

test("parsePatch: End of File marker is preserved", () => {
	const patch = [
		"*** Begin Patch",
		"*** Update File: file.txt",
		"@@",
		"+quux",
		"*** End of File",
		"",
		"*** End Patch",
	].join("\n");
	assert.deepStrictEqual(firstUpdateChunks(patch), [
		{ oldLines: [], newLines: ["quux"], contextLines: [], eof: true },
	]);

	const withOldLines = "*** Begin Patch\n*** Update File: f\n@@\n-old\n+new\n*** End of File\n*** End Patch";
	assert.deepStrictEqual(firstUpdateChunks(withOldLines), [
		{ oldLines: ["old"], newLines: ["new"], contextLines: [], eof: true },
	]);
});

test("parsePatch: update hunk followed by another hunk", () => {
	const patch = [
		"*** Begin Patch",
		"*** Update File: file.py",
		"@@",
		"+line",
		"*** Add File: other.py",
		"+content",
		"*** End Patch",
	].join("\n");
	assert.deepStrictEqual(parsePatch(patch), [
		{
			type: "update",
			path: "file.py",
			chunks: [{ oldLines: [], newLines: ["line"], contextLines: [], eof: false }],
		},
		{ type: "add", path: "other.py", content: "content\n" },
	]);
});

test("parsePatch: indented hunk markers inside update bodies are context lines", () => {
	const patch = [
		"*** Begin Patch",
		"*** Update File: a.txt",
		"@@",
		"-old a",
		"+new a",
		" *** Update File: b.txt",
		"@@",
		"-old b",
		"+new b",
		"*** End Patch",
	].join("\n");
	assert.deepStrictEqual(firstUpdateChunks(patch), [
		{
			oldLines: ["old a", "*** Update File: b.txt"],
			newLines: ["new a", "*** Update File: b.txt"],
			contextLines: [[1, 1]],
			eof: false,
		},
		{ oldLines: ["old b"], newLines: ["new b"], contextLines: [], eof: false },
	]);
});

test("parsePatch: accepts optional heredoc wrappers", () => {
	for (const opener of ["<<EOF", "<<'EOF'", "<<\"EOF\""]) {
		const patch = [opener, "*** Begin Patch", "*** Add File: x.txt", "+hi", "*** End Patch", "EOF"].join("\n");
		assert.deepStrictEqual(parsePatch(patch), [{ type: "add", path: "x.txt", content: "hi\n" }]);
	}
});

test("parsePatch: rejects mismatched or broken heredoc wrappers", () => {
	const mismatched = ["<<\"EOF'", "*** Begin Patch", "*** Add File: x.txt", "+hi", "*** End Patch", "EOF"].join("\n");
	assert.match(errorMessage(() => parsePatch(mismatched)), /The first line of the patch must be/);

	const missingClose = ["<<EOF", "*** Begin Patch", "*** Update File: file2.py", "EOF"].join("\n");
	assert.match(errorMessage(() => parsePatch(missingClose)), /The last line of the patch must be/);
});

test("parsePatch: accepts CRLF patch input", () => {
	const lf = "*** Begin Patch\n*** Update File: f.txt\n@@\n-old\n+new\n*** End Patch";
	const crlf = lf.replace(/\n/g, "\r\n");
	assert.deepStrictEqual(parsePatch(crlf), parsePatch(lf));
	assert.equal(parsePatch(crlf).length, 1);
	// Added lines always use LF, regardless of the patch's line terminators.
	assert.deepStrictEqual(parsePatch("*** Begin Patch\r\n*** Add File: x.txt\r\n+hi\r\n*** End Patch\r\n"), [
		{ type: "add", path: "x.txt", content: "hi\n" },
	]);
});

test("parsePatch: strips only the CR of a CRLF line terminator", () => {
	const patch = "*** Begin Patch\r\n*** Update File: file.txt\r\n@@\r\n-old\r\r\n+new\r\n*** End Patch\r\n";
	assert.deepStrictEqual(firstUpdateChunks(patch), [
		{ oldLines: ["old\r"], newLines: ["new"], contextLines: [], eof: false },
	]);
});

test("parsePatch: a padded End Patch is accepted as the final line", () => {
	const patch = "*** Begin Patch\n*** Update File: file.txt\n@@\n-old\n+new\n *** End Patch";
	assert.deepStrictEqual(firstUpdateChunks(patch), [
		{ oldLines: ["old"], newLines: ["new"], contextLines: [], eof: false },
	]);
});

test("parsePatch: accepts padded marker lines", () => {
	const patch = "  *** Begin Patch  \n  *** Add File: spaced.txt \n+hi\n  *** Delete File: gone.txt  \n*** End Patch  ";
	assert.deepStrictEqual(parsePatch(patch), [
		{ type: "add", path: "spaced.txt", content: "hi\n" },
		{ type: "delete", path: "gone.txt" },
	]);
});

test("parsePatch: Begin/End with no hunks is a valid, empty patch", () => {
	assert.deepStrictEqual(parsePatch("*** Begin Patch\n*** End Patch"), []);
});

// ---------------------------------------------------------------------------
// Parser: errors
// ---------------------------------------------------------------------------

test("parsePatch: rejects empty input", () => {
	assert.match(errorMessage(() => parsePatch("")), /the patch is empty/);
	assert.match(errorMessage(() => parsePatch("  \n\n\t")), /the patch is empty/);
});

test("parsePatch: enforces Begin and End boundaries", () => {
	assert.match(errorMessage(() => parsePatch("nope")), /The first line of the patch must be '\*\*\* Begin Patch'/);
	assert.match(
		errorMessage(() => parsePatch("*** Begin Patch\n*** Add File: x\n+hi")),
		/The last line of the patch must be '\*\*\* End Patch'/,
	);
});

test("parsePatch: reports malformed hunk headers with line numbers", () => {
	assert.equal(
		errorMessage(() => parsePatch("*** Begin Patch\n*** Frobnicate File: foo\n*** End Patch")),
		"invalid hunk at line 2, '*** Frobnicate File: foo' is not a valid hunk header. " +
			"Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'",
	);
	assert.match(
		errorMessage(() => parsePatch("*** Begin Patch\n*** Add File: a\n+ok\nnot a header\n*** End Patch")),
		/invalid hunk at line 4, 'not a header' is not a valid hunk header/,
	);
});

test("parsePatch: rejects empty update hunks and chunks", () => {
	assert.equal(
		errorMessage(() => parsePatch("*** Begin Patch\n*** Update File: foo.txt\n*** End Patch")),
		"invalid hunk at line 2, Update file hunk for path 'foo.txt' is empty",
	);
	assert.equal(
		errorMessage(() => parsePatch("*** Begin Patch\n*** Update File: file.txt\n@@\n*** End Patch")),
		"invalid hunk at line 4, Update hunk does not contain any lines",
	);
	assert.equal(
		errorMessage(() => parsePatch("*** Begin Patch\n*** Update File: file.txt\n@@\n*** End of File\n*** End Patch")),
		"invalid hunk at line 4, Update hunk does not contain any lines",
	);
	assert.match(
		errorMessage(() => parsePatch("*** Begin Patch\n*** Update File: file.txt\n@@\n@@\n*** End Patch")),
		/invalid hunk at line 4, Unexpected line found in update hunk: '@@'/,
	);
	assert.match(
		errorMessage(() => parsePatch("*** Begin Patch\n*** Update File: f.txt\n@@\n-old\nbad\n*** End Patch")),
		/invalid hunk at line 5, Expected update hunk to start with a @@ context marker, got: 'bad'/,
	);
	assert.match(
		errorMessage(() => parsePatch("*** Begin Patch\n*** Update File: f.txt\n@@\n*** Update File: other.txt\n*** End Patch")),
		/invalid hunk at line 4, Unexpected line found in update hunk: '\*\*\* Update File: other.txt'/,
	);
});

test("parsePatch: rejects content after End Patch", () => {
	assert.match(
		errorMessage(() => parsePatch("*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch\nextra\n*** End Patch")),
		/The last line of the patch must be '\*\*\* End Patch'/,
	);
	// Whitespace-only trailing content is trimmed before parsing.
	assert.deepStrictEqual(parsePatch("*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch\n \t\n"), [
		{ type: "add", path: "a.txt", content: "hi\n" },
	]);
});

test("parsePatch: rejects duplicate Move to headers", () => {
	const patch = [
		"*** Begin Patch",
		"*** Update File: a.txt",
		"*** Move to: b.txt",
		"*** Move to: c.txt",
		"@@",
		"-old",
		"+new",
		"*** End Patch",
	].join("\n");
	assert.match(errorMessage(() => parsePatch(patch)), /invalid hunk at line 4, duplicate '\*\*\* Move to:' header/);
});

test("parsePatch: rejects environment IDs with an explicit error", () => {
	const patch = "*** Begin Patch\n*** Environment ID: remote\n*** Add File: hello.txt\n+hello\n*** End Patch";
	assert.match(errorMessage(() => parsePatch(patch)), /environment_id is not supported \(line 2\)/);
});

test("parsePatch: rejects NUL bytes in paths", () => {
	const patch = "*** Begin Patch\n*** Add File: bad\u0000name\n+hi\n*** End Patch";
	assert.match(errorMessage(() => parsePatch(patch)), /invalid hunk at line 2, file path must not contain NUL/);

	const movePatch = "*** Begin Patch\n*** Update File: a\n*** Move to: b\u0000c\n@@\n-x\n+y\n*** End Patch";
	assert.match(errorMessage(() => parsePatch(movePatch)), /file path must not contain NUL/);
});

test("parsePatch: rejects headers with empty paths", () => {
	// Trimming turns these into non-headers, so they never parse as empty paths.
	assert.match(
		errorMessage(() => parsePatch("*** Begin Patch\n*** Add File:\n+hi\n*** End Patch")),
		/invalid hunk at line 2, '\*\*\* Add File:' is not a valid hunk header/,
	);
	assert.match(
		errorMessage(() => parsePatch("*** Begin Patch\n*** Update File: a\n*** Move to:\n@@\n-x\n+y\n*** End Patch")),
		/invalid hunk at line 3, Unexpected line found in update hunk: '\*\*\* Move to:'/,
	);
});

// ---------------------------------------------------------------------------
// applyUpdate: core behavior
// ---------------------------------------------------------------------------

test("applyUpdate: replaces lines and keeps a trailing newline", () => {
	assert.equal(
		applyUpdate("line1\nline2\n", [chunk({ oldLines: ["line2"], newLines: ["changed"] })], "f.txt"),
		"line1\nchanged\n",
	);
});

test("applyUpdate: applies multiple chunks in source order", () => {
	const chunks = firstUpdateChunks(
		"*** Begin Patch\n*** Update File: multi.txt\n@@\n-line2\n+changed2\n@@\n-line4\n+changed4\n*** End Patch",
	);
	assert.equal(
		applyUpdate("line1\nline2\nline3\nline4\n", chunks, "multi.txt"),
		"line1\nchanged2\nline3\nchanged4\n",
	);
});

test("applyUpdate: preserves change order when lines repeat", () => {
	const chunks = firstUpdateChunks(
		"*** Begin Patch\n*** Update File: repeated.txt\n@@\n-a\n-b\n+b\n+b\n+a\n*** End Patch",
	);
	assert.equal(applyUpdate("a\nb\n", chunks, "repeated.txt"), "b\nb\na\n");
});

test("applyUpdate: uses @@ anchors to disambiguate matches", () => {
	const chunks = firstUpdateChunks(
		[
			"*** Begin Patch",
			"*** Update File: f.txt",
			"@@ first",
			"-middle",
			"+MIDDLE",
			"@@ second",
			"-middle",
			"+MIDDLE2",
			"*** End Patch",
		].join("\n"),
	);
	assert.equal(
		applyUpdate("first\nmiddle\nsecond\nmiddle\n", chunks, "f.txt"),
		"first\nMIDDLE\nsecond\nMIDDLE2\n",
	);
});

test("applyUpdate: duplicate text matches the first occurrence per chunk", () => {
	const chunks = [
		chunk({ oldLines: ["foo"], newLines: ["ONE"] }),
		chunk({ oldLines: ["foo"], newLines: ["TWO"] }),
	];
	assert.equal(applyUpdate("foo\nbar\nfoo\n", chunks, "f.txt"), "ONE\nbar\nTWO\n");
});

test("applyUpdate: appends to empty and non-empty files", () => {
	assert.equal(applyUpdate("", [chunk({ newLines: ["new"] })], "f.txt"), "new\n");
	assert.equal(applyUpdate("a\nb\n", [chunk({ newLines: ["c"] })], "f.txt"), "a\nb\nc\n");
	assert.equal(applyUpdate("a", [chunk({ newLines: ["b"] })], "f.txt"), "a\nb\n");
});

test("applyUpdate: adds a final newline to unterminated files", () => {
	assert.equal(applyUpdate("one\ntwo", [chunk({ oldLines: ["one"], newLines: ["ONE"] })], "f.txt"), "ONE\ntwo\n");
	assert.equal(
		applyUpdate(
			"no newline at end",
			[chunk({ oldLines: ["no newline at end"], newLines: ["first line", "second line"] })],
			"f.txt",
		),
		"first line\nsecond line\n",
	);
});

test("applyUpdate: no-op chunks preserve exact bytes, endings and BOM", () => {
	const bodies = [
		"@@\n alpha\n bravo",
		"@@\n-alpha\n+alpha\n bravo",
		"@@ alpha\n-bravo\n+bravo",
		"@@\n charlie\n*** End of File",
		"@@\n-charlie\n+charlie\n \n*** End of File",
	];
	for (const body of bodies) {
		const chunks = firstUpdateChunks(`*** Begin Patch\n*** Update File: f.txt\n${body}\n*** End Patch`);
		for (const ending of ["\n", "\r\n", "\r"]) {
			for (const suffix of ["", ending]) {
				for (const bom of ["", "﻿"]) {
					const original = `${bom}alpha${ending}bravo${ending}charlie${suffix}`;
					assert.equal(applyUpdate(original, chunks, "f.txt"), original);
				}
			}
		}
		const mixed = "﻿alpha\r\nbravo\ncharlie\r";
		assert.equal(applyUpdate(mixed, chunks, "f.txt"), mixed);
	}
});

test("applyUpdate: no-op context still validates anchors, EOF and chunk order", () => {
	for (const body of [
		"@@ missing\n alpha",
		"@@\n missing",
		"@@\n-missing\n+missing",
		"@@\n alpha\n*** End of File",
		"@@\n bravo\n@@\n-alpha\n+alpha",
	]) {
		const chunks = firstUpdateChunks(`*** Begin Patch\n*** Update File: f.txt\n${body}\n*** End Patch`);
		assert.throws(() => applyUpdate("alpha\nbravo", chunks, "f.txt"), /Failed to find/);
	}
});

test("applyUpdate: no-op replacements do not normalize mixed endings alongside real edits", () => {
	const chunks = firstUpdateChunks(
		"*** Begin Patch\n*** Update File: f.txt\n@@\n alpha\n-bravo\n+bravo\n@@\n-charlie\n+CHARLIE\n*** End Patch",
	);
	assert.equal(applyUpdate("alpha\r\nbravo\ncharlie", chunks, "f.txt"), "alpha\r\nbravo\nCHARLIE\r\n");
});

test("applyUpdate: fuzzy context is unchanged but replacement text can be a real edit", () => {
	const context = firstUpdateChunks("*** Begin Patch\n*** Update File: f.txt\n@@\n alpha\n*** End Patch");
	assert.equal(applyUpdate("  alpha  ", context, "f.txt"), "  alpha  ");
	const replacement = firstUpdateChunks("*** Begin Patch\n*** Update File: f.txt\n@@\n-alpha\n+alpha\n*** End Patch");
	assert.equal(applyUpdate("  alpha  ", replacement, "f.txt"), "alpha\n");
	const alreadyApplied = firstUpdateChunks("*** Begin Patch\n*** Update File: f.txt\n@@\n-  alpha  \n+alpha\n*** End Patch");
	assert.equal(applyUpdate("alpha", alreadyApplied, "f.txt"), "alpha");
});

test("applyUpdate: cancelling replacements do not introduce a newline or normalize endings", () => {
	const chunks = firstUpdateChunks(
		"*** Begin Patch\n*** Update File: f.txt\n@@\n-alpha\n alpha\n+alpha\n*** End Patch",
	);
	for (const original of ["alpha\nalpha", "alpha\r\nalpha\n"]) {
		assert.equal(applyUpdate(original, chunks, "f.txt"), original);
	}
});

test("applyUpdate: deletion-only updates can produce an empty file", () => {
	assert.equal(applyUpdate("only\n", [chunk({ oldLines: ["only"], newLines: [] })], "f.txt"), "");
	assert.equal(applyUpdate("only", [chunk({ oldLines: ["only"], newLines: [] })], "f.txt"), "");
});

test("applyUpdate: inserts lines between context lines", () => {
	const chunks = firstUpdateChunks(
		"*** Begin Patch\n*** Update File: f.txt\n@@\n boundary\n+inserted\n after\n*** End Patch",
	);
	assert.deepStrictEqual(chunks, [
		{
			oldLines: ["boundary", "after"],
			newLines: ["boundary", "inserted", "after"],
			contextLines: [
				[0, 0],
				[1, 2],
			],
			eof: false,
		},
	]);
	assert.equal(applyUpdate("before\nboundary\nafter\n", chunks, "f.txt"), "before\nboundary\ninserted\nafter\n");
});

// ---------------------------------------------------------------------------
// applyUpdate: line endings and BOM
// ---------------------------------------------------------------------------

test("applyUpdate: preserves CRLF endings and uses CRLF for new lines", () => {
	const chunks = firstUpdateChunks(
		"*** Begin Patch\n*** Update File: crlf.txt\n@@\n-one\n+uno\n@@\n two\n+\n+between\n three\n*** End Patch",
	);
	assert.deepStrictEqual(chunks[1], {
		oldLines: ["two", "three"],
		newLines: ["two", "", "between", "three"],
		contextLines: [
			[0, 0],
			[1, 3],
		],
		eof: false,
	});
	assert.equal(
		applyUpdate("one\r\ntwo\r\nthree\r\n", chunks, "crlf.txt"),
		"uno\r\ntwo\r\n\r\nbetween\r\nthree\r\n",
	);
});

test("applyUpdate: appends after a trailing blank CRLF line", () => {
	const chunks = firstUpdateChunks("*** Begin Patch\n*** Update File: trailing_blank.txt\n@@\n+new\n*** End Patch");
	assert.equal(applyUpdate("a\r\n\r\n", chunks, "trailing_blank.txt"), "a\r\n\r\nnew\r\n");
});

test("applyUpdate: preserves CR-only line endings", () => {
	const chunks = firstUpdateChunks(
		"*** Begin Patch\n*** Update File: cr.txt\n@@\n-one\n+uno\n@@\n two\n+\n+between\n three\n*** End Patch",
	);
	assert.equal(applyUpdate("one\rtwo\rthree\r", chunks, "cr.txt"), "uno\rtwo\r\rbetween\rthree\r");
});

test("applyUpdate: preserves untouched mixed line endings", () => {
	const chunks = firstUpdateChunks(
		"*** Begin Patch\n*** Update File: mixed.txt\n@@\n one\n two\n-three\n+THREE\n four\n*** End Patch",
	);
	assert.equal(
		applyUpdate("one\r\ntwo\rthree\nfour\r\n", chunks, "mixed.txt"),
		"one\r\ntwo\rTHREE\r\nfour\r\n",
	);
});

test("applyUpdate: preserves the ending of a repeated context line", () => {
	const chunks = firstUpdateChunks(
		"*** Begin Patch\n*** Update File: repeated_context.txt\n@@\n-same\n same\n*** End Patch",
	);
	assert.deepStrictEqual(chunks, [
		{ oldLines: ["same", "same"], newLines: ["same"], contextLines: [[1, 0]], eof: false },
	]);
	assert.equal(applyUpdate("same\r\nsame\n", chunks, "repeated_context.txt"), "same\n");
});

test("applyUpdate: uses CRLF for a new trailing newline", () => {
	const chunks = firstUpdateChunks(
		"*** Begin Patch\n*** Update File: no_trailing_newline.txt\n@@\n-one\n+ONE\n*** End Patch",
	);
	assert.equal(applyUpdate("one\r\ntwo", chunks, "no_trailing_newline.txt"), "ONE\r\ntwo\r\n");
});

test("applyUpdate: preserves a leading BOM", () => {
	assert.equal(applyUpdate("﻿one\ntwo\n", [chunk({ oldLines: ["one"], newLines: ["ONE"] })], "f.txt"), "﻿ONE\ntwo\n");
	// Matches on the first line work even though the BOM is not part of it.
	assert.equal(
		applyUpdate("﻿one\ntwo\n", [chunk({ context: "one", oldLines: ["two"], newLines: ["TWO"] })], "f.txt"),
		"﻿one\nTWO\n",
	);
	assert.equal(applyUpdate("﻿a\n", [chunk({ newLines: ["b"] })], "f.txt"), "﻿a\nb\n");
});

test("applyUpdate: drops the BOM when all content is deleted", () => {
	assert.equal(applyUpdate("﻿only\n", [chunk({ oldLines: ["only"], newLines: [] })], "f.txt"), "");
});

// ---------------------------------------------------------------------------
// applyUpdate: matching behavior
// ---------------------------------------------------------------------------

test("applyUpdate: end-of-file chunks prefer the file end", () => {
	const chunks = [chunk({ oldLines: ["a"], newLines: ["A"], eof: true })];
	assert.equal(applyUpdate("a\nb\na\n", chunks, "f.txt"), "a\nb\nA\n");
});

test("applyUpdate: retries patterns with a trailing empty line", () => {
	assert.equal(
		applyUpdate("line\nlast", [chunk({ oldLines: ["last", ""], newLines: ["LAST"] })], "f.txt"),
		"line\nLAST\n",
	);
	assert.equal(
		applyUpdate("line\nlast", [chunk({ oldLines: ["last", ""], newLines: ["LAST", ""] })], "f.txt"),
		"line\nLAST\n",
	);
});

test("applyUpdate: whitespace-only fallbacks (rstrip, then trim)", () => {
	assert.equal(
		applyUpdate("foo   \nbar\t\n", [chunk({ oldLines: ["foo", "bar"], newLines: ["FOO", "BAR"] })], "f.txt"),
		"FOO\nBAR\n",
	);
	assert.equal(
		applyUpdate("    foo   \n", [chunk({ oldLines: ["foo"], newLines: ["FOO"] })], "f.txt"),
		"FOO\n",
	);
});

test("applyUpdate: unicode punctuation fallback", () => {
	assert.equal(
		applyUpdate("a\n“quoted”\nd\n", [chunk({ oldLines: ["\"quoted\""], newLines: ["\"QUOTED\""] })], "f.txt"),
		"a\n\"QUOTED\"\nd\n",
	);
});

test("applyUpdate: preserves matched context bytes and endings on fuzzy matches", () => {
	const chunks = [chunk({ oldLines: ["keep", "old"], newLines: ["keep", "new"], contextLines: [[0, 0]] })];
	assert.equal(applyUpdate("  keep  \nold\n", chunks, "f.txt"), "  keep  \nnew\n");
});

test("applyUpdate: reports missing context and missing lines", () => {
	assert.equal(
		errorMessage(() => applyUpdate("line1\nline2\n", [chunk({ oldLines: ["missing"], newLines: ["x"] })], "f.txt")),
		"Failed to find expected lines in f.txt:\nmissing",
	);
	assert.equal(
		errorMessage(() =>
			applyUpdate("line1\nline2\n", [chunk({ context: "nope", oldLines: ["line1"], newLines: ["x"] })], "f.txt"),
		),
		"Failed to find context 'nope' in f.txt",
	);
});

test("applyUpdate: rejects overlapping end-of-file chunks", () => {
	const chunks = firstUpdateChunks(
		[
			"*** Begin Patch",
			"*** Update File: overlapping.txt",
			"@@",
			"-one",
			"+first",
			"@@",
			"-one",
			"+second",
			"*** End of File",
			"*** End Patch",
		].join("\n"),
	);
	assert.equal(chunks.length, 2);
	assert.equal(chunks[1]?.eof, true);
	assert.match(
		errorMessage(() => applyUpdate("one\n", chunks, "overlapping.txt")),
		/Failed to find expected lines in overlapping.txt:\none/,
	);
});

test("applyUpdate: rejects out-of-order context line indices", () => {
	const chunks: Chunk[] = [
		{ oldLines: ["a", "b", "c"], newLines: ["a", "b", "c"], contextLines: [[2, 2], [0, 0]], eof: false },
	];
	assert.match(errorMessage(() => applyUpdate("a\nb\nc\n", chunks, "f.txt")), /out of order/);
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

test("parsePatch + applyUpdate: heredoc patch end to end", () => {
	const patch = [
		"<<'EOF'",
		"*** Begin Patch",
		"*** Update File: notes.txt",
		"@@",
		"-line2",
		"+LINE2",
		"@@",
		"-line4",
		"+LINE4",
		"*** End Patch",
		"EOF",
	].join("\n");
	const chunks = firstUpdateChunks(patch);
	assert.equal(
		applyUpdate("line1\nline2\nline3\nline4\n", chunks, "notes.txt"),
		"line1\nLINE2\nline3\nLINE4\n",
	);
});
