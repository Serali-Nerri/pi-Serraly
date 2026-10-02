import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { generateBoundedDiff } from "../src/diff.ts";
import { applyPatchWithSnapshots, type Change, type ChangeSnapshot, type PatchOutcome } from "../src/files.ts";
import { buildPatchReport, TOTAL_DIFF_MAX_BYTES, TOTAL_DIFF_MAX_LINES, type ApplyPatchReport, type FileFacts } from "../src/report.ts";

function snapshot(change: Change, before: string | null, after: string | null, sourceBefore?: string): ChangeSnapshot {
	return sourceBefore === undefined ? { ...change, before, after } : { ...change, before, after, sourceBefore };
}

function outcome(entries: ChangeSnapshot[]): PatchOutcome {
	return {
		changes: entries.map(({ kind, path, moveFrom }) => (moveFrom === undefined ? { kind, path } : { kind, path, moveFrom })),
		snapshots: entries,
	};
}

function report(...entries: ChangeSnapshot[]): ApplyPatchReport {
	return buildPatchReport(outcome(entries));
}

function add(path: string, after: string): ChangeSnapshot {
	return snapshot({ kind: "add", path }, null, after);
}

function update(path: string, before: string, after: string): ChangeSnapshot {
	return snapshot({ kind: "update", path }, before, after);
}

function remove(path: string, before: string): ChangeSnapshot {
	return snapshot({ kind: "delete", path }, before, null);
}

function absent(): FileFacts {
	return { exists: false, bytes: 0, lines: 0, bom: false, endings: { lf: 0, crlf: 0, cr: 0 }, finalNewline: false };
}

/** A helper that must not run; work-guarded views have to skip it entirely. */
function refusingDiff(): { calls: number[]; generate: typeof generateBoundedDiff } {
	const calls: number[] = [];
	const generate: typeof generateBoundedDiff = () => {
		calls.push(1);
		throw new Error("diff helper must not run");
	};
	return { calls, generate };
}

test("no-op outcome reports the empty v1 format", () => {
	const result = buildPatchReport({ changes: [], snapshots: [] });
	assert.deepEqual(result, { format: "apply_patch.v1", changes: [] });
});

test("add is a linear view with exact facts and rows", () => {
	const refusing = refusingDiff();
	const result = buildPatchReport(outcome([add("new.txt", "x\ny\n")]), { generateDiff: refusing.generate });
	assert.equal(refusing.calls.length, 0, "adds must not run the diff helper");
	assert.deepEqual(result.changes.map((change) => [change.kind, change.path]), [["add", "new.txt"]]);
	const [view] = result.changes[0].views;
	assert.equal(view.role, "file");
	assert.deepEqual(view.before, absent());
	assert.deepEqual(view.after, {
		exists: true,
		bytes: 4,
		lines: 2,
		bom: false,
		endings: { lf: 2, crlf: 0, cr: 0 },
		finalNewline: true,
	});
	assert.equal(view.added, 2);
	assert.equal(view.removed, 0);
	assert.equal(view.availability, "complete");
	assert.equal(view.diff, "+1 x\n+2 y");
	assert.equal(view.diffTotalLines, 2);
	assert.equal(view.lineEndingsChanged, false);
	assert.equal("reason" in view, false);
});

test("delete counts removed logical lines", () => {
	const refusing = refusingDiff();
	const result = buildPatchReport(outcome([remove("gone.txt", "x\ny\n")]), { generateDiff: refusing.generate });
	assert.equal(refusing.calls.length, 0, "deletes must not run the diff helper");
	const [view] = result.changes[0].views;
	assert.equal(view.role, "file");
	assert.equal(view.before.exists, true);
	assert.deepEqual(view.after, absent());
	assert.equal(view.added, 0);
	assert.equal(view.removed, 2);
	assert.equal(view.availability, "complete");
	assert.equal(view.diff, "-1 x\n-2 y");
	assert.equal(view.diffTotalLines, 2);
});

test("empty, newline-only, and BOM-only files keep accurate facts", () => {
	const empty = report(add("empty.txt", "")).changes[0].views[0];
	assert.equal(empty.after.exists, true);
	assert.deepEqual(empty.after, { ...absent(), exists: true });
	assert.equal(empty.added, 0);
	assert.equal(empty.removed, 0);
	assert.equal(empty.availability, "complete");
	assert.equal(empty.diff, "");
	assert.equal(empty.diffTotalLines, 0);

	const newline = report(add("blank.txt", "\n")).changes[0].views[0];
	assert.equal(newline.after.bytes, 1);
	assert.equal(newline.after.lines, 1);
	assert.equal(newline.after.finalNewline, true);
	assert.equal(newline.added, 1);
	assert.equal(newline.diff, "+1 ");

	const bomOnly = report(add("bom.txt", "\uFEFF")).changes[0].views[0];
	assert.deepEqual(bomOnly.after, {
		exists: true,
		bytes: 3,
		lines: 0,
		bom: true,
		endings: { lf: 0, crlf: 0, cr: 0 },
		finalNewline: false,
	});
	assert.equal(bomOnly.added, 0);
	assert.equal(bomOnly.diff, "");

	const newlineOverEmpty = report(update("blank.txt", "", "\n")).changes[0].views[0];
	assert.equal(newlineOverEmpty.before.exists, true);
	assert.equal(newlineOverEmpty.before.bytes, 0);
	assert.equal(newlineOverEmpty.added, 1);
	assert.equal(newlineOverEmpty.removed, 0);
	assert.equal(newlineOverEmpty.diff, "+1 ");
});

test("add that overwrites an existing file uses a text diff, not a fresh add", () => {
	const entry = snapshot({ kind: "add", path: "existing.txt" }, "old\n", "new\n");
	const [view] = report(entry).changes[0].views;
	assert.equal(view.before.exists, true);
	assert.equal(view.added, 1);
	assert.equal(view.removed, 1);
	assert.equal(view.diff, "-1 old\n+1 new");
	assert.equal(view.diffTotalLines, 2);
});

test("update renders Pi-format diff rows with exact statistics", () => {
	const [view] = report(update("a.txt", "a\nb\nc\n", "a\nB\nc\n")).changes[0].views;
	assert.equal(view.role, "file");
	assert.equal(view.added, 1);
	assert.equal(view.removed, 1);
	assert.equal(view.availability, "complete");
	assert.equal(view.diff, " 1 a\n-2 b\n+2 B\n 3 c");
	assert.equal(view.diffTotalLines, 4);
	assert.equal(view.lineEndingsChanged, false);
	assert.ok(!(view.diff ?? "").includes("\u001b"), "reports must not embed ANSI escapes");
});

test("terminator-only edits report +0/-0 and explain themselves through facts", () => {
	const converted = report(update("crlf.txt", "a\r\nb\r\n", "a\nb\n")).changes[0].views[0];
	assert.equal(converted.added, 0);
	assert.equal(converted.removed, 0);
	assert.equal(converted.availability, "complete");
	assert.equal(converted.diff, "");
	assert.equal(converted.diffTotalLines, 0);
	assert.deepEqual(converted.before.endings, { lf: 0, crlf: 2, cr: 0 });
	assert.deepEqual(converted.after.endings, { lf: 2, crlf: 0, cr: 0 });
	assert.equal(converted.before.bytes, 6);
	assert.equal(converted.after.bytes, 4);
	assert.equal(converted.lineEndingsChanged, true);

	const reordered = report(update("mixed.txt", "a\r\nb\n", "a\nb\r\n")).changes[0].views[0];
	assert.equal(reordered.added, 0);
	assert.equal(reordered.removed, 0);
	assert.equal(reordered.lineEndingsChanged, true, "mixed terminator order changes must be detected");

	const bomRemoved = report(update("bom.txt", "\uFEFFa\n", "a\n")).changes[0].views[0];
	assert.equal(bomRemoved.before.bom, true);
	assert.equal(bomRemoved.after.bom, false);
	assert.equal(bomRemoved.before.bytes, 5);
	assert.equal(bomRemoved.after.bytes, 2);
	assert.equal(bomRemoved.added, 0);
	assert.equal(bomRemoved.diff, "");
	assert.equal(bomRemoved.lineEndingsChanged, false);

	const newlineAdded = report(update("tail.txt", "a", "a\n")).changes[0].views[0];
	assert.equal(newlineAdded.before.finalNewline, false);
	assert.equal(newlineAdded.after.finalNewline, true);
	assert.equal(newlineAdded.added, 0);
	assert.equal(newlineAdded.removed, 0);
	assert.equal(newlineAdded.lineEndingsChanged, false);
});

test("facts summarize mixed terminators and unterminated final lines", () => {
	const mixed = "a\r\nb\nc\rd";
	const [view] = report(update("mixed.txt", mixed, mixed)).changes[0].views;
	assert.deepEqual(view.before, {
		exists: true,
		bytes: 8,
		lines: 4,
		bom: false,
		endings: { lf: 1, crlf: 1, cr: 1 },
		finalNewline: false,
	});
	assert.deepEqual(view.after, view.before);
	assert.equal(view.added, 0);
	assert.equal(view.removed, 0);
	assert.equal(view.lineEndingsChanged, false);
});

test("lineEndingsChanged ignores ordinary line edits and added lines", () => {
	const crlfEdit = report(update("crlf.txt", "a\r\nb\r\n", "a\r\nB\r\n")).changes[0].views[0];
	assert.equal(crlfEdit.added, 1);
	assert.equal(crlfEdit.removed, 1);
	assert.equal(crlfEdit.lineEndingsChanged, false);

	const appended = report(update("lf.txt", "a\n", "a\nb\n")).changes[0].views[0];
	assert.equal(appended.added, 1);
	assert.equal(appended.lineEndingsChanged, false);

	const mixedEdit = report(update("mixed.txt", "a\r\nb\n", "a\r\nB\n")).changes[0].views[0];
	assert.equal(mixedEdit.added, 1);
	assert.equal(mixedEdit.removed, 1);
	assert.equal(mixedEdit.lineEndingsChanged, false);

	const newKind = report(update("crlf.txt", "a\r\nb\r\n", "a\r\nb\n")).changes[0].views[0];
	assert.equal(newKind.lineEndingsChanged, true, "a newly mixed file changed its ending distribution");
});

test("mixed ending redistribution is visible alongside real text edits", () => {
	const view = report(update("mixed.txt", "a\r\nb\nc\n", "a\r\nB\r\nc\n")).changes[0].views[0];
	assert.equal(view.added, 1);
	assert.equal(view.removed, 1);
	assert.equal(view.lineEndingsChanged, true);
	assert.deepEqual(view.before.endings, { lf: 2, crlf: 1, cr: 0 });
	assert.deepEqual(view.after.endings, { lf: 1, crlf: 2, cr: 0 });
});

test("large linear previews and later empty files need no diff search or full row materialization", () => {
	const refusing = refusingDiff();
	const text = "\n".repeat(1_000_000);
	const result = buildPatchReport(outcome([
		add("one", text), add("two", text), add("three", text), add("empty", ""),
	]), { generateDiff: refusing.generate });
	assert.equal(refusing.calls.length, 0);
	for (const change of result.changes.slice(0, 3)) {
		const view = change.views[0];
		assert.equal(view.added, 1_000_000);
		assert.equal(view.after.lines, 1_000_000);
		assert.equal(view.availability, "truncated");
		assert.equal(view.diff?.split("\n").length, 200);
	}
	const empty = result.changes[3].views[0];
	assert.equal(empty.after.exists, true);
	assert.equal(empty.availability, "complete");
	assert.equal(empty.diff, "");
});

test("move to a new destination is one view from the source text", () => {
	const entry = snapshot({ kind: "update", path: "moved.txt", moveFrom: "old.txt" }, null, "body\n", "body\n");
	const result = report(entry);
	assert.equal(result.changes[0].moveFrom, "old.txt");
	assert.equal(result.changes[0].path, "moved.txt");
	const [view] = result.changes[0].views;
	assert.equal(view.role, "move");
	assert.equal(view.before.exists, true);
	assert.equal(view.before.bytes, 5);
	assert.equal(view.before.lines, 1);
	assert.equal(view.after.bytes, 5);
	assert.equal(view.added, 0);
	assert.equal(view.removed, 0);
	assert.equal(view.availability, "complete");
	assert.equal(view.diff, "");
	assert.equal(view.diffTotalLines, 0);
	assert.equal(view.lineEndingsChanged, false);
});

test("move over an existing destination keeps both source-delete and destination views", () => {
	const entry = snapshot({ kind: "update", path: "dest.txt", moveFrom: "src.txt" }, "dest old\n", "dest new\n", "src body\n");
	const [sourceDelete, destination] = report(entry).changes[0].views;
	assert.equal(sourceDelete.role, "source-delete");
	assert.equal(sourceDelete.before.bytes, 9);
	assert.deepEqual(sourceDelete.after, absent());
	assert.equal(sourceDelete.added, 0);
	assert.equal(sourceDelete.removed, 1);
	assert.equal(sourceDelete.diff, "-1 src body");
	assert.equal(sourceDelete.diffTotalLines, 1);

	assert.equal(destination.role, "destination");
	assert.equal(destination.before.exists, true);
	assert.equal(destination.after.exists, true);
	assert.equal(destination.added, 1);
	assert.equal(destination.removed, 1);
	assert.equal(destination.diff, "-1 dest old\n+1 dest new");
	assert.equal(destination.diffTotalLines, 2);

	const unchanged = snapshot({ kind: "update", path: "dest.txt", moveFrom: "src.txt" }, "same\n", "same\n", "same\n");
	const [deleted, kept] = report(unchanged).changes[0].views;
	assert.equal(deleted.role, "source-delete");
	assert.equal(deleted.removed, 1);
	assert.equal(deleted.diff, "-1 same");
	assert.equal(kept.role, "destination");
	assert.equal(kept.added, 0);
	assert.equal(kept.removed, 0);
	assert.equal(kept.availability, "complete");
	assert.equal(kept.diff, "");
	assert.equal(kept.diffTotalLines, 0);
	assert.deepEqual(kept.after, kept.before);
});

test("move contentChanged compares captured source and destination bytes", () => {
	const pureMove = report(snapshot({ kind: "update", path: "moved.txt", moveFrom: "old.txt" }, null, "body\n", "body\n"));
	assert.equal(pureMove.changes[0].contentChanged, false);
	assert.equal(
		"contentChanged" in report(add("plain.txt", "x\n")).changes[0],
		false,
		"only moves carry contentChanged",
	);

	const edited = report(snapshot({ kind: "update", path: "moved.txt", moveFrom: "old.txt" }, null, "baaa\n", "aaaa\n"));
	assert.equal(edited.changes[0].contentChanged, true, "equal-length replacements still change the moved content");

	const overwritten = report(
		snapshot({ kind: "update", path: "dest.txt", moveFrom: "src.txt" }, "target old\n", "same\n", "same\n"),
	);
	assert.equal(overwritten.changes[0].contentChanged, false, "rewriting the discarded target is not a moved-content edit");

	const destAlreadyFinal = report(
		snapshot({ kind: "update", path: "dest.txt", moveFrom: "src.txt" }, "final\n", "final\n", "source\n"),
	);
	assert.equal(destAlreadyFinal.changes[0].contentChanged, true, "an unchanged destination does not hide a moved-content edit");
	const [sourceDelete, destination] = destAlreadyFinal.changes[0].views;
	assert.equal(sourceDelete.role, "source-delete");
	assert.equal(destination.role, "destination");
	assert.equal(destination.added, 0);
	assert.equal(destination.removed, 0);
	assert.equal(destination.diff, "");

	const formatOnly = report(
		snapshot({ kind: "update", path: "moved.txt", moveFrom: "old.txt" }, null, "a\n", "\uFEFFa\r\n"),
	);
	assert.equal(formatOnly.changes[0].contentChanged, true, "BOM/terminator-only edits are byte changes");
	assert.equal(formatOnly.changes[0].views[0].diff, "");
	assert.equal(formatOnly.changes[0].views[0].lineEndingsChanged, true);

	const undetermined = report(
		snapshot({ kind: "update", path: "dest.txt", moveFrom: "src.txt" }, "old\n", null, "src\n"),
	);
	assert.equal("contentChanged" in undetermined.changes[0], false, "an absent destination cannot decide the comparison");
});

test("sparse edits far apart in 600 lines still produce a complete diff", () => {
	const before = Array.from({ length: 600 }, (_, index) => `line ${index + 1}`);
	const after = [...before];
	after[5] = "changed near the beginning";
	after[590] = "changed near the end";
	const view = report(update("spread.txt", before.join("\n") + "\n", after.join("\n") + "\n")).changes[0].views[0];
	assert.equal(view.availability, "complete");
	assert.equal(view.added, 2);
	assert.equal(view.removed, 2);
	assert.match(view.diff ?? "", /^-\s*6 line 6$/m);
	assert.match(view.diff ?? "", /^\+\s*591 changed near the end$/m);
});

test("sparse edits among repeated lines are not rejected as a large changed window", () => {
	const before = Array(600).fill("repeated");
	const after = [...before];
	after[5] = "first change";
	after[590] = "last change";
	const view = report(update("repeated.txt", before.join("\n") + "\n", after.join("\n") + "\n")).changes[0].views[0];
	assert.equal(view.availability, "complete");
	assert.equal(view.added, 2);
	assert.equal(view.removed, 2);
	assert.match(view.diff ?? "", /first change/);
	assert.match(view.diff ?? "", /last change/);
});

test("distributed document edits retain statistics when 609 lines become 597", () => {
	const before = Array.from({ length: 609 }, (_, index) => `段落 ${index + 1}：用于测试的原始文档内容。`);
	const after = [...before];
	for (let index = 0; index < 16; index++) after[5 + 36 * index] = `第 ${index + 1} 处局部修改。`;
	after.splice(20, 12);
	const view = report(update("document.md", before.join("\n") + "\n", after.join("\n") + "\n")).changes[0].views[0];
	assert.notEqual(view.availability, "omitted");
	assert.equal(view.before.lines, 609);
	assert.equal(view.after.lines, 597);
	assert.equal(view.added, 16);
	assert.equal(view.removed, 28);
});

test("multiple sparse files consume actual edits rather than cumulative spans", () => {
	const entries = Array.from({ length: 8 }, (_, file) => {
		const before = Array.from({ length: 600 }, (_, line) => `file ${file} line ${line}`);
		const after = [...before];
		after[100] = "first changed line";
		after[500] = "second changed line";
		return update(`file-${file}.txt`, before.join("\n") + "\n", after.join("\n") + "\n");
	});
	for (const change of report(...entries).changes) {
		assert.equal(change.views[0].availability, "complete", change.path);
		assert.equal(change.views[0].added, 2, change.path);
		assert.equal(change.views[0].removed, 2, change.path);
	}
});

test("guarded diff work: oversized combined normalized text skips the helper", () => {
	const refusing = refusingDiff();
	const line = "x".repeat(60);
	const before = Array.from({ length: 20_000 }, () => line).join("\n") + "\n";
	const after = Array.from({ length: 19_999 }, () => line).join("\n") + "\nreplacement\n";
	const result = buildPatchReport(outcome([update("big.txt", before, after)]), { generateDiff: refusing.generate });
	assert.equal(refusing.calls.length, 0);
	const [view] = result.changes[0].views;
	assert.equal(view.availability, "omitted");
	assert.equal(view.reason, "work-limit");
	assert.equal(view.added, null);
	assert.equal(view.removed, null);
	assert.equal("diff" in view, false);
	assert.equal("diffTotalLines" in view, false);
	assert.equal(view.before.bytes, 20_000 * 61);
	assert.equal(view.before.lines, 20_000);
	assert.equal(view.lineEndingsChanged, false);
});

test("guarded diff work: too many combined logical lines skips the helper", () => {
	const refusing = refusingDiff();
	const before = "a\n".repeat(26_000);
	const after = `${"a\n".repeat(13_000)}b\n${"a\n".repeat(12_999)}`;
	const result = buildPatchReport(outcome([update("long.txt", before, after)]), { generateDiff: refusing.generate });
	assert.equal(refusing.calls.length, 0);
	const [view] = result.changes[0].views;
	assert.equal(view.availability, "omitted");
	assert.equal(view.reason, "work-limit");
	assert.equal(view.added, null);
	assert.equal(view.removed, null);
	assert.equal(view.before.lines, 26_000);
	assert.equal(view.after.lines, 26_000);
});

test("guarded diff work: an exhausted bounded search degrades without reporting a tool failure", () => {
	const budgets: Array<{ maxEditLength: number; timeout: number }> = [];
	const before = Array.from({ length: 600 }, (_, index) => `before ${index}`).join("\n") + "\n";
	const after = Array.from({ length: 600 }, (_, index) => `after ${index}`).join("\n") + "\n";
	const [view] = buildPatchReport(outcome([update("middle.txt", before, after)]), {
		generateDiff: (_before, _after, budget) => { budgets.push(budget); return undefined; },
	}).changes[0].views;
	assert.equal(budgets.length, 1, "the bounded search, not the line span, decides");
	assert.equal(budgets[0].maxEditLength, 1_000);
	assert.ok(budgets[0].timeout > 0 && budgets[0].timeout <= 250);
	assert.equal(view.availability, "omitted");
	assert.equal(view.reason, "work-limit");
	assert.equal(view.added, null);
	assert.equal(view.removed, null);
	assert.equal("diffTotalLines" in view, false);
});

test("guarded diff work: successful searches consume actual edit counts across files", () => {
	const budgets: number[] = [];
	const generate: typeof generateBoundedDiff = (before, after, budget) => {
		budgets.push(budget.maxEditLength);
		return generateBoundedDiff(before, after, { ...budget, timeout: 10_000 });
	};
	const entries = Array.from({ length: 5 }, (_, index) =>
		update(
			`file-${index}.txt`,
			Array.from({ length: 450 }, (_, line) => `old ${index} ${line}`).join("\n") + "\n",
			Array.from({ length: 450 }, (_, line) => `new ${index} ${line}`).join("\n") + "\n",
		),
	);
	const result = buildPatchReport(outcome(entries), { generateDiff: generate, now: () => 0 });
	assert.deepEqual(budgets, [1_000, 1_000, 1_000, 1_000, 400]);
	const views = result.changes.map((change) => change.views[0]);
	for (const view of views.slice(0, 4)) assert.equal(view.added, 450);
	assert.equal(views[4].availability, "omitted");
	assert.equal(views[4].reason, "work-limit");
	assert.equal(views[4].added, null);
	assert.equal(views[4].removed, null);
});

test("aborted searches reserve their whole edit allowance; cheap adds still render", () => {
	const entries = Array.from({ length: 6 }, (_, index) => update(`f-${index}`, "old\n", "new\n"));
	let calls = 0;
	const result = buildPatchReport(outcome([...entries, add("created", "ok\n")]), {
		generateDiff: () => { calls++; return undefined; },
		now: () => 0,
	});
	assert.equal(calls, 4);
	assert.ok(result.changes.slice(0, 6).every((change) => change.views[0].reason === "work-limit"));
	assert.equal(result.changes[6].views[0].diff, "+1 ok");
});

test("aggregate elapsed-time budget limits subsequent searches and cannot fail committed changes", () => {
	let clock = 0;
	const budgets: number[] = [];
	const result = buildPatchReport(outcome([
		update("a", "a\n", "A\n"), update("b", "b\n", "B\n"), update("c", "c\n", "C\n"), add("new", "ok\n"),
	]), {
		now: () => clock,
		generateDiff: (before, after, budget) => {
			budgets.push(budget.timeout);
			clock = budgets.length === 1 ? 950 : 1_001;
			return generateBoundedDiff(before, after, { ...budget, timeout: 10_000 });
		},
	});
	assert.deepEqual(budgets, [250, 50]);
	assert.equal(result.reportUnavailable, undefined);
	assert.equal(result.changes[0].views[0].added, 1);
	assert.equal(result.changes[1].views[0].added, 1);
	assert.equal(result.changes[2].views[0].reason, "work-limit");
	assert.equal(result.changes[2].views[0].added, null);
	assert.equal(result.changes[3].views[0].diff, "+1 ok");
});

test("result budget: per-view truncation keeps the complete statistics", () => {
	const before = Array.from({ length: 300 }, (_, index) => `old ${index}`).join("\n") + "\n";
	const after = Array.from({ length: 300 }, (_, index) => `new ${index}`).join("\n") + "\n";
	const [view] = report(update("many.txt", before, after)).changes[0].views;
	assert.equal(view.availability, "truncated");
	assert.equal(view.reason, "result-limit");
	assert.equal(view.added, 300);
	assert.equal(view.removed, 300);
	assert.equal(view.diffTotalLines, 600);
	const full = generateDiffString(before, after).diff;
	assert.equal(view.diff, full.split("\n").slice(0, 200).join("\n"));
	assert.equal((view.diff ?? "").split("\n").length, 200);
});

test("result budget: a giant first row is omitted, never cut", () => {
	const giant = "a".repeat(20_000);
	const result = buildPatchReport(
		outcome([update("giant.txt", `${giant}\n`, `${"b".repeat(20_000)}\n`), add("later.txt", "ok\n")]),
	);
	const [view, later] = result.changes.map((change) => change.views[0]);
	assert.equal(view.availability, "omitted");
	assert.equal(view.reason, "result-limit");
	assert.equal(view.added, 1);
	assert.equal(view.removed, 1);
	assert.equal(view.diffTotalLines, 2);
	assert.equal("diff" in view, false);
	assert.equal(later.availability, "complete");
	assert.equal(later.diff, "+1 ok");

	const [linear] = report(add("huge.txt", "中".repeat(6_000))).changes[0].views;
	assert.equal(linear.after.bytes, 18_000);
	assert.equal(linear.added, 1);
	assert.equal(linear.removed, 0);
	assert.equal(linear.availability, "omitted");
	assert.equal(linear.reason, "result-limit");
	assert.equal(linear.diffTotalLines, 1);
	assert.equal("diff" in linear, false);
});

test("result budget: the report-wide row budget omits later views", () => {
	const entries = Array.from({ length: 4 }, (_, index) =>
		update(
			`file-${index}.txt`,
			Array.from({ length: 100 }, (_, line) => `old ${index} ${line}`).join("\n") + "\n",
			Array.from({ length: 100 }, (_, line) => `new ${index} ${line}`).join("\n") + "\n",
		),
	);
	const views = report(...entries).changes.map((change) => change.views[0]);
	for (const view of views.slice(0, 3)) {
		assert.equal(view.availability, "complete");
		assert.equal(view.added, 100);
		assert.equal(view.removed, 100);
		assert.equal(view.diffTotalLines, 200);
	}
	assert.equal(views[3].availability, "omitted");
	assert.equal(views[3].reason, "result-limit");
	assert.equal(views[3].added, 100);
	assert.equal(views[3].removed, 100);
	assert.equal(views[3].diffTotalLines, 200);
	assert.equal("diff" in views[3], false);
	const rows = views.reduce((total, view) => total + (view.diff === undefined ? 0 : view.diff.split("\n").length), 0);
	assert.ok(rows <= TOTAL_DIFF_MAX_LINES, `kept ${rows} diff rows`);
});

test("result budget: the report-wide byte budget stops later views", () => {
	const line = "x".repeat(8_000);
	const entries = Array.from({ length: 5 }, (_, index) =>
		update(`file-${index}.txt`, `${line}\n${line}\n`, `${"y".repeat(8_000)}\n${"z".repeat(8_000)}\n`),
	);
	const views = report(...entries).changes.map((change) => change.views[0]);
	for (const view of views.slice(0, 4)) {
		assert.equal(view.availability, "truncated");
		assert.equal(view.reason, "result-limit");
		assert.equal(view.added, 2);
		assert.equal(view.removed, 2);
		assert.equal(view.diffTotalLines, 4);
	}
	assert.equal(views[4].availability, "omitted");
	assert.equal(views[4].reason, "result-limit");
	assert.equal(views[4].added, 2);
	assert.equal(views[4].removed, 2);
	assert.equal(views[4].diffTotalLines, 4);
	assert.equal("diff" in views[4], false);
	const bytes = views.reduce((total, view) => total + Buffer.byteLength(view.diff ?? "", "utf8"), 0);
	assert.ok(bytes <= TOTAL_DIFF_MAX_BYTES, `kept ${bytes} diff bytes`);
});

test("a throwing diff helper degrades only that view", () => {
	let calls = 0;
	const generate: typeof generateBoundedDiff = (before, after, budget) => {
		calls += 1;
		if (calls === 1) throw new Error("boom");
		return generateBoundedDiff(before, after, budget);
	};
	const result = buildPatchReport(
		outcome([update("a.txt", "a\n", "b\n"), update("b.txt", "c\n", "d\n")]),
		{ generateDiff: generate },
	);
	assert.equal("reportUnavailable" in result, false);
	const [failed, rendered] = result.changes.map((change) => change.views[0]);
	assert.equal(failed.availability, "omitted");
	assert.equal(failed.reason, "diff-error");
	assert.equal(failed.added, null);
	assert.equal(failed.removed, null);
	assert.equal("diff" in failed, false);
	assert.equal("diffTotalLines" in failed, false);
	assert.equal(failed.before.exists, true);
	assert.equal(failed.after.bytes, 2);
	assert.equal(failed.lineEndingsChanged, false);
	assert.equal(rendered.availability, "complete");
	assert.equal(rendered.diff, "-1 c\n+1 d");
});

test("invalid bounded search statistics degrade rather than bypass the edit budget", () => {
	for (const generated of [
		{ diff: "+1 x", added: NaN, removed: 0 },
		{ diff: "+1 x", added: 1_001, removed: 0 },
		{ diff: "+1 x", added: 1, removed: -1 },
	]) {
		const result = buildPatchReport(outcome([update("a.txt", "a\n", "b\n")]), {
			generateDiff: () => generated,
		});
		assert.equal(result.reportUnavailable, undefined);
		assert.equal(result.changes[0].views[0].reason, "diff-error");
		assert.equal(result.changes[0].views[0].added, null);
	}
});

test("an already-aborted signal degrades views without failing the report", () => {
	const refusing = refusingDiff();
	const controller = new AbortController();
	controller.abort();
	const result = buildPatchReport(outcome([update("a.txt", "a\n", "b\n"), add("b.txt", "body\n")]), {
		signal: controller.signal,
		generateDiff: refusing.generate,
	});
	assert.equal(refusing.calls.length, 0);
	assert.equal("reportUnavailable" in result, false);
	assert.deepEqual(result.changes.map((change) => [change.kind, change.path]), [
		["update", "a.txt"],
		["add", "b.txt"],
	]);
	for (const view of result.changes.flatMap((change) => change.views)) {
		assert.equal(view.availability, "omitted");
		assert.equal(view.reason, "cancelled");
		assert.equal(view.added, null);
		assert.equal(view.removed, null);
		assert.equal("diff" in view, false);
		assert.equal("diffTotalLines" in view, false);
		assert.equal(view.after.exists, true);
	}
	assert.equal(result.changes[0].views[0].before.exists, true);
	assert.deepEqual(result.changes[1].views[0].before, absent());
});

test("missing or inconsistent snapshots fall back to reportUnavailable", () => {
	const missing = buildPatchReport({ changes: [{ kind: "update", path: "a.txt" }], snapshots: [] });
	assert.deepEqual(missing, {
		format: "apply_patch.v1",
		changes: [{ kind: "update", path: "a.txt", views: [] }],
		reportUnavailable: "diff-error",
	});

	const mismatched = buildPatchReport({
		changes: [{ kind: "delete", path: "a.txt" }],
		snapshots: [update("a.txt", "a\n", "b\n")],
	});
	assert.deepEqual(mismatched, {
		format: "apply_patch.v1",
		changes: [{ kind: "delete", path: "a.txt", views: [] }],
		reportUnavailable: "diff-error",
	});

	const missingSource = buildPatchReport(outcome([snapshot({ kind: "update", path: "moved.txt", moveFrom: "src.txt" }, null, "x\n")]));
	assert.equal(missingSource.reportUnavailable, "diff-error");
	assert.deepEqual(missingSource.changes[0].views, []);
	assert.equal("contentChanged" in missingSource.changes[0], false, "a degraded report must not claim move metadata");
});

test("linear truncation keeps complete multibyte rows", () => {
	const lines = Array.from({ length: 300 }, (_, index) => `第${index + 1}行 中文`);
	const [view] = report(add("cjk.txt", lines.join("\n") + "\n")).changes[0].views;
	assert.equal(view.added, 300);
	assert.equal(view.removed, 0);
	assert.equal(view.availability, "truncated");
	assert.equal(view.reason, "result-limit");
	assert.equal(view.diffTotalLines, 300);
	const rows = (view.diff ?? "").split("\n");
	assert.equal(rows.length, 200);
	assert.equal(rows[0], "+  1 第1行 中文");
	assert.equal(rows[199], "+200 第200行 中文");
	assert.equal(Buffer.from(view.diff ?? "", "utf8").toString("utf8"), view.diff);
	assert.ok(Buffer.byteLength(view.diff ?? "", "utf8") <= 16 * 1024);
});

test("real commit snapshots drive file, update, move, and overwrite views", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-apply-patch-report-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "keep.txt"), "keep\n");
	await writeFile(join(root, "old.txt"), "move me\n");
	await writeFile(join(root, "dest.txt"), "dest old\n");
	await writeFile(join(root, "src.txt"), "src old\n");
	const patch = [
		"*** Begin Patch",
		"*** Add File: new.txt",
		"+hello",
		"*** Update File: keep.txt",
		"@@",
		" keep",
		"+more",
		"*** Update File: old.txt",
		"*** Move to: moved.txt",
		"@@",
		"-move me",
		"+moved body",
		"*** Update File: src.txt",
		"*** Move to: dest.txt",
		"@@",
		"-src old",
		"+src new",
		"*** End Patch",
	].join("\n");
	const result = buildPatchReport(await applyPatchWithSnapshots(patch, root));
	assert.equal("reportUnavailable" in result, false);
	assert.deepEqual(
		result.changes.map((change) => [change.kind, change.path, change.moveFrom ?? null]),
		[
			["add", "new.txt", null],
			["update", "keep.txt", null],
			["update", "moved.txt", "old.txt"],
			["update", "dest.txt", "src.txt"],
		],
	);

	const added = result.changes[0].views[0];
	assert.equal(added.role, "file");
	assert.deepEqual(added.before, absent());
	assert.equal(added.after.bytes, 6);
	assert.equal(added.after.lines, 1);
	assert.equal(added.diff, "+1 hello");

	const updated = result.changes[1].views[0];
	assert.equal(updated.role, "file");
	assert.equal(updated.before.bytes, 5);
	assert.equal(updated.after.bytes, 10);
	assert.equal(updated.after.lines, 2);
	assert.equal(updated.added, 1);
	assert.equal(updated.removed, 0);
	assert.equal(updated.diff, " 1 keep\n+2 more");

	const moved = result.changes[2].views[0];
	assert.equal(result.changes[2].contentChanged, true);
	assert.equal(moved.role, "move");
	assert.equal(moved.before.bytes, Buffer.byteLength("move me\n", "utf8"));
	assert.equal(moved.after.bytes, Buffer.byteLength("moved body\n", "utf8"));
	assert.equal(moved.before.lines, 1);
	assert.equal(moved.after.lines, 1);
	assert.equal(moved.added, 1);
	assert.equal(moved.removed, 1);
	assert.equal(moved.diff, "-1 move me\n+1 moved body");

	const [sourceDelete, destination] = result.changes[3].views;
	assert.equal(result.changes[3].contentChanged, true);
	assert.equal(sourceDelete.role, "source-delete");
	assert.equal(sourceDelete.before.bytes, Buffer.byteLength("src old\n", "utf8"));
	assert.deepEqual(sourceDelete.after, absent());
	assert.equal(sourceDelete.removed, 1);
	assert.equal(sourceDelete.diff, "-1 src old");
	assert.equal(destination.role, "destination");
	assert.equal(destination.before.bytes, Buffer.byteLength("dest old\n", "utf8"));
	assert.equal(destination.after.bytes, Buffer.byteLength("src new\n", "utf8"));
	assert.equal(destination.added, 1);
	assert.equal(destination.removed, 1);
	assert.equal(destination.diff, "-1 dest old\n+1 src new");
});
