import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { chmod, cp, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { applyPatch, applyPatchWithSnapshots, MAX_FILE_BYTES, MAX_PATCH_BYTES, type FileLock } from "../src/files.ts";

async function workspace(t: TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-apply-patch-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}
const patch = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;
const text = (root: string, path: string) => readFile(join(root, path), "utf8");

async function snapshot(root: string): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	async function visit(dir: string, prefix: string) {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const relative = prefix + entry.name;
			if (entry.isDirectory()) {
				result[relative + "/"] = "directory";
				await visit(join(dir, entry.name), relative + "/");
			} else {
				result[relative] = (await readFile(join(dir, entry.name))).toString("base64");
			}
		}
	}
	try { await visit(root, ""); } catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return result;
}

const fixtures = fileURLToPath(new URL("./fixtures/codex/", import.meta.url));
for (const scenario of (await readdir(fixtures)).filter((name) => /^\d/.test(name)).sort()) {
	test(`upstream fixture: ${scenario}`, async (t) => {
		const root = await workspace(t);
		const source = join(fixtures, scenario);
		try { await cp(join(source, "input"), root, { recursive: true }); } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const before = await snapshot(root);
		const input = await readFile(join(source, "patch.txt"), "utf8");
		const fails = /^(005|006|007|008|009|012|013|015)_/.test(scenario);
		if (fails) await assert.rejects(applyPatch(input, root));
		else await applyPatch(input, root);
		// Intentional improvement over the standalone upstream CLI: validation of
		// a later hunk fails before any earlier hunk is written.
		const expected = scenario.startsWith("015_") ? before : await snapshot(join(source, "expected"));
		assert.deepEqual(await snapshot(root), expected);
	});
}

test("validation failure leaves all files untouched", async (t) => {
	const root = await workspace(t);
	await writeFile(join(root, "old.txt"), "original\n");
	await assert.rejects(applyPatch(patch("*** Add File: new.txt\n+new\n*** Update File: old.txt\n@@\n-missing\n+changed"), root), /expected lines/);
	assert.equal(await text(root, "old.txt"), "original\n");
	assert.deepEqual(await readdir(root), ["old.txt"]);
});

test("no-op updates return no changes and never replace the file", async (t) => {
	const root = await workspace(t);
	const file = join(root, "file.txt");
	for (const body of ["@@\n alpha\n bravo", "@@\n-alpha\n+alpha\n bravo"]) {
		for (const original of ["alpha\nbravo\ncharlie\n", "alpha\nbravo\ncharlie", "\uFEFFalpha\r\nbravo\ncharlie"]) {
			await writeFile(file, original);
			const before = await lstat(file, { bigint: true });
			assert.deepEqual(await applyPatch(patch(`*** Update File: file.txt\n${body}`), root), []);
			const after = await lstat(file, { bigint: true });
			assert.equal(await text(root, "file.txt"), original);
			assert.equal(after.ino, before.ino);
			assert.equal(after.mtimeNs, before.mtimeNs);
			assert.equal(after.ctimeNs, before.ctimeNs);
			assert.deepEqual(await readdir(root), ["file.txt"]);
		}
	}
});

test("mixed patches report only actual changes", async (t) => {
	const root = await workspace(t);
	await writeFile(join(root, "same.txt"), "alpha\nbravo");
	await writeFile(join(root, "edit.txt"), "old\n");
	const before = await lstat(join(root, "same.txt"), { bigint: true });
	const changes = await applyPatch(patch(
		"*** Update File: same.txt\n@@\n alpha\n*** Update File: edit.txt\n@@\n-old\n+new",
	), root);
	assert.deepEqual(changes, [{ kind: "update", path: "edit.txt" }]);
	assert.equal(await text(root, "same.txt"), "alpha\nbravo");
	assert.equal((await lstat(join(root, "same.txt"), { bigint: true })).ino, before.ino);
	assert.equal(await text(root, "edit.txt"), "new\n");
});

test("invalid no-op context fails preflight before any writes", async (t) => {
	const root = await workspace(t);
	await writeFile(join(root, "file.txt"), "alpha");
	await assert.rejects(applyPatch(patch(
		"*** Add File: new.txt\n+new\n*** Update File: file.txt\n@@\n-missing\n+missing",
	), root), /expected lines/);
	assert.equal(await text(root, "file.txt"), "alpha");
	assert.deepEqual(await readdir(root), ["file.txt"]);
});

test("no-op moves preserve bytes and distinguish real destinations from aliases", async (t) => {
	const root = await workspace(t);
	await writeFile(join(root, "file.txt"), "alpha\nbravo");
	const before = await lstat(join(root, "file.txt"), { bigint: true });
	assert.deepEqual(await applyPatch(patch(
		"*** Update File: file.txt\n*** Move to: ./file.txt\n@@\n-alpha\n+alpha",
	), root), []);
	assert.equal((await lstat(join(root, "file.txt"), { bigint: true })).ino, before.ino);
	assert.deepEqual(await applyPatch(patch(
		"*** Update File: file.txt\n*** Move to: moved.txt\n@@\n alpha",
	), root), [{ kind: "update", path: "moved.txt", moveFrom: "file.txt" }]);
	assert.equal(await text(root, "moved.txt"), "alpha\nbravo");
	assert.deepEqual(await readdir(root), ["moved.txt"]);
});

test("reports net changes rather than hunks that cancel or repeat", async (t) => {
	const root = await workspace(t);
	await writeFile(join(root, "file.txt"), "alpha\n");
	const before = await lstat(join(root, "file.txt"), { bigint: true });
	assert.deepEqual(await applyPatch(patch(
		"*** Update File: file.txt\n@@\n-alpha\n+bravo\n*** Update File: ./file.txt\n@@\n-bravo\n+alpha\n" +
		"*** Add File: transient.txt\n+temporary\n*** Delete File: transient.txt\n*** Add File: file.txt\n+alpha",
	), root), []);
	const after = await lstat(join(root, "file.txt"), { bigint: true });
	assert.equal(after.ino, before.ino);
	assert.equal(after.mtimeNs, before.mtimeNs);
	assert.deepEqual(await readdir(root), ["file.txt"]);
	assert.deepEqual(await applyPatch(patch(
		"*** Update File: file.txt\n@@\n-alpha\n+bravo\n*** Update File: file.txt\n@@\n-bravo\n+charlie\n" +
		"*** Update File: file.txt\n@@\n charlie",
	), root), [{ kind: "update", path: "file.txt" }]);
});

test("multiple operations on the same file see prior hunks", async (t) => {
	const root = await workspace(t);
	const changes = await applyPatch(patch("*** Add File: file.txt\n+one\n*** Update File: file.txt\n@@\n-one\n+two\n*** Update File: file.txt\n*** Move to: renamed.txt\n@@\n-two\n+three"), root);
	assert.deepEqual(changes, [{ kind: "add", path: "renamed.txt" }]);
	assert.equal(await text(root, "renamed.txt"), "three\n");
	assert.deepEqual(await readdir(root), ["renamed.txt"]);
});

test("add, update and delete summaries reflect net file existence and bytes", async (t) => {
	const root = await workspace(t);
	await writeFile(join(root, "file.txt"), "alpha\n");
	assert.deepEqual(await applyPatch(patch("*** Add File: file.txt\n+alpha"), root), []);
	assert.deepEqual(await applyPatch(patch(
		"*** Delete File: file.txt\n*** Add File: file.txt\n+alpha",
	), root), []);
	assert.deepEqual(await applyPatch(patch("*** Add File: file.txt\n+bravo"), root), [
		{ kind: "update", path: "file.txt" },
	]);
	assert.deepEqual(await applyPatch(patch(
		"*** Update File: file.txt\n@@\n-bravo\n+charlie\n*** Delete File: file.txt",
	), root), [{ kind: "delete", path: "file.txt" }]);
	assert.deepEqual(await applyPatch(patch(
		"*** Add File: file.txt\n+alpha\n*** Update File: file.txt\n@@\n-alpha\n+bravo",
	), root), [{ kind: "add", path: "file.txt" }]);
});

test("a move onto identical bytes still reports the source removal without rewriting the destination", async (t) => {
	const root = await workspace(t);
	for (const path of ["source", "destination"]) await writeFile(join(root, path), "alpha");
	const before = await lstat(join(root, "destination"), { bigint: true });
	assert.deepEqual(await applyPatch(patch(
		"*** Update File: source\n*** Move to: destination\n@@\n alpha",
	), root), [{ kind: "update", path: "destination", moveFrom: "source" }]);
	const after = await lstat(join(root, "destination"), { bigint: true });
	assert.equal(after.ino, before.ino);
	assert.equal(after.mtimeNs, before.mtimeNs);
	assert.equal(await text(root, "destination"), "alpha");
	assert.deepEqual(await readdir(root), ["destination"]);
});

test("transient moves report only surviving paths", async (t) => {
	const root = await workspace(t);
	await writeFile(join(root, "source"), "alpha");
	assert.deepEqual(await applyPatch(patch(
		"*** Update File: source\n*** Move to: intermediate\n@@\n alpha\n" +
		"*** Update File: intermediate\n*** Move to: destination\n@@\n alpha",
	), root), [{ kind: "delete", path: "source" }, { kind: "add", path: "destination" }]);
	assert.equal(await text(root, "destination"), "alpha");
	assert.deepEqual(await readdir(root), ["destination"]);
	assert.deepEqual(await applyPatch(patch(
		"*** Update File: destination\n*** Move to: intermediate\n@@\n alpha\n" +
		"*** Update File: intermediate\n*** Move to: destination\n@@\n alpha",
	), root), []);
	assert.deepEqual(await readdir(root), ["destination"]);
});

test("replacement of a move destination invalidates its old provenance", async (t) => {
	const root = await workspace(t);
	for (const replacement of [
		"*** Add File: destination\n+bravo",
		"*** Delete File: destination\n*** Add File: destination\n+bravo",
		"*** Add File: transient\n+bravo\n*** Update File: transient\n*** Move to: destination\n@@\n bravo",
	]) {
		await writeFile(join(root, "source"), "alpha\n");
		await rm(join(root, "destination"), { force: true });
		assert.deepEqual(await applyPatch(patch(
			"*** Update File: source\n*** Move to: destination\n@@\n alpha\n" + replacement,
		), root), [{ kind: "delete", path: "source" }, { kind: "add", path: "destination" }]);
		assert.equal(await text(root, "destination"), "bravo\n");
	}
});

test("the most recent move cannot fall back to stale provenance if its source is restored", async (t) => {
	const root = await workspace(t);
	await writeFile(join(root, "a"), "alpha\n");
	await writeFile(join(root, "c"), "charlie\n");
	assert.deepEqual(await applyPatch(patch(
		"*** Update File: a\n*** Move to: destination\n@@\n alpha\n" +
		"*** Update File: c\n*** Move to: destination\n@@\n charlie\n*** Add File: c\n+fresh",
	), root), [
		{ kind: "delete", path: "a" },
		{ kind: "add", path: "destination" },
		{ kind: "update", path: "c" },
	]);
});

test("the newest valid move into a destination keeps its own source snapshot", async (t) => {
	const root = await workspace(t);
	await writeFile(join(root, "a"), "alpha\n");
	await writeFile(join(root, "c"), "charlie\n");
	const outcome = await applyPatchWithSnapshots(patch(
		"*** Update File: a\n*** Move to: destination\n@@\n alpha\n" +
		"*** Update File: c\n*** Move to: destination\n@@\n charlie",
	), root);
	assert.deepEqual(outcome.changes, [
		{ kind: "delete", path: "a" },
		{ kind: "update", path: "destination", moveFrom: "c" },
	]);
	assert.equal(outcome.snapshots[1].sourceBefore, "charlie\n");
	assert.equal(await text(root, "destination"), "charlie\n");
});

test("updates after a move preserve its provenance and exact before/after snapshots", async (t) => {
	const root = await workspace(t);
	await writeFile(join(root, "source"), "alpha\n");
	await writeFile(join(root, "destination"), "overwritten\n");
	const outcome = await applyPatchWithSnapshots(patch(
		"*** Update File: source\n*** Move to: destination\n@@\n alpha\n" +
		"*** Update File: destination\n@@\n-alpha\n+bravo\n*** Update File: destination\n@@\n bravo",
	), root);
	assert.deepEqual(outcome, {
		changes: [{ kind: "update", path: "destination", moveFrom: "source" }],
		snapshots: [{
			kind: "update", path: "destination", moveFrom: "source",
			before: "overwritten\n", after: "bravo\n", sourceBefore: "alpha\n",
		}],
	});
});

test("snapshots describe the commit even if a later writer changes the file", async (t) => {
	const root = await workspace(t);
	await writeFile(join(root, "file"), "\uFEFFalpha\r\nbravo");
	const withFileLock: FileLock = async (_path, action) => {
		const outcome = await action();
		await writeFile(join(root, "file"), "later writer\n");
		return outcome;
	};
	const outcome = await applyPatchWithSnapshots(patch(
		"*** Update File: file\n@@\n-alpha\n+ALPHA",
	), root, { withFileLock });
	assert.deepEqual(outcome.snapshots, [{
		kind: "update", path: "file",
		before: "\uFEFFalpha\r\nbravo", after: "\uFEFFALPHA\r\nbravo\r\n",
	}]);
	assert.equal(await text(root, "file"), "later writer\n");
});

test("empty files and no-ops keep existence distinct in snapshots", async (t) => {
	const root = await workspace(t);
	assert.deepEqual(await applyPatchWithSnapshots(patch("*** Add File: empty"), root), {
		changes: [{ kind: "add", path: "empty" }],
		snapshots: [{ kind: "add", path: "empty", before: null, after: "" }],
	});
	assert.deepEqual(await applyPatchWithSnapshots(patch(
		"*** Update File: empty\n*** Move to: moved\n@@\n ",
	), root), {
		changes: [{ kind: "update", path: "moved", moveFrom: "empty" }],
		snapshots: [{ kind: "update", path: "moved", moveFrom: "empty", before: null, after: "", sourceBefore: "" }],
	});
	assert.deepEqual(await applyPatchWithSnapshots(patch("*** Add File: moved"), root), {
		changes: [], snapshots: [],
	});
	assert.deepEqual(await applyPatchWithSnapshots(patch("*** Delete File: moved"), root), {
		changes: [{ kind: "delete", path: "moved" }],
		snapshots: [{ kind: "delete", path: "moved", before: "", after: null }],
	});
});

test("self move never deletes its source", async (t) => {
	const root = await workspace(t);
	await writeFile(join(root, "file.txt"), "old\n");
	await applyPatch(patch("*** Update File: file.txt\n*** Move to: ./file.txt\n@@\n-old\n+new"), root);
	assert.equal(await text(root, "file.txt"), "new\n");
});

test("absolute paths, spaces and Unicode filenames resolve without a shell", async (t) => {
	const root = await workspace(t);
	const destination = join(root, "子目录", "file with spaces.txt");
	await applyPatch(patch(`*** Add File: ${destination}\n+你好`), root);
	assert.equal(await readFile(destination, "utf8"), "你好\n");
});

test("preserves BOM, mixed endings and executable permissions", async (t) => {
	const root = await workspace(t);
	const file = join(root, "script.sh");
	await writeFile(file, "\uFEFF#!/bin/sh\r\necho old\nlast\r\n");
	await chmod(file, 0o751);
	await applyPatch(patch("*** Update File: script.sh\n@@\n #!/bin/sh\n-echo old\n+echo new\n last"), root);
	assert.equal(await readFile(file, "utf8"), "\uFEFF#!/bin/sh\r\necho new\r\nlast\r\n");
	if (process.platform !== "win32") assert.equal((await lstat(file)).mode & 0o777, 0o751);
});

test("rejects binary files, invalid UTF-8 and NUL input without mutation", async (t) => {
	const root = await workspace(t);
	for (const bytes of [Buffer.from([65, 0, 66]), Buffer.from([0xff, 0xfe])]) {
		await writeFile(join(root, "file"), bytes);
		await assert.rejects(applyPatch(patch("*** Add File: file\n+replacement"), root), /Binary|UTF-8/);
		assert.deepEqual(await readFile(join(root, "file")), bytes);
	}
	await assert.rejects(applyPatch(patch("*** Add File: other\n+\0"), root), /NUL/);
});

test("rejects file symlinks, including dangling links", { skip: process.platform === "win32" }, async (t) => {
	const root = await workspace(t);
	await writeFile(join(root, "target"), "original\n");
	await symlink("target", join(root, "alias"));
	await symlink("missing", join(root, "dangling"));
	for (const path of ["alias", "dangling"]) {
		await assert.rejects(applyPatch(patch(`*** Add File: ${path}\n+replacement`), root), /symlinks/);
		assert.equal((await lstat(join(root, path))).isSymbolicLink(), true);
	}
	assert.equal(await text(root, "target"), "original\n");
});

test("rejects hard links rather than silently breaking their relationship", async (t) => {
	const root = await workspace(t);
	await writeFile(join(root, "target"), "original\n");
	await link(join(root, "target"), join(root, "alias"));
	await assert.rejects(applyPatch(patch("*** Add File: alias\n+replacement"), root), /Hard-linked/);
	assert.equal(await text(root, "target"), "original\n");
});

test("deduplicates directory aliases before acquiring ordered file locks", { skip: process.platform === "win32" }, async (t) => {
	const root = await workspace(t);
	await mkdir(join(root, "real"));
	await symlink("real", join(root, "alias"));
	await writeFile(join(root, "real/file"), "old\n");
	const locked: string[] = [];
	const withFileLock: FileLock = async (path, action) => { locked.push(path); return action(); };
	const changes = await applyPatch(patch("*** Update File: alias/file\n@@\n-old\n+new\n*** Update File: real/file\n@@\n-new\n+last"), root, { withFileLock });
	assert.deepEqual(changes, [{ kind: "update", path: "alias/file" }]);
	assert.equal(locked.length, 1);
	assert.equal(await text(root, "real/file"), "last\n");
});

test("rejects conflicting file/descendant paths before creating anything", async (t) => {
	const root = await workspace(t);
	await assert.rejects(applyPatch(patch("*** Add File: dir\n+file\n*** Add File: dir/child\n+child"), root), /Conflicting/);
	assert.deepEqual(await readdir(root), []);
});

test("separate targets do not conflict just because a POSIX filename contains a backslash", { skip: process.platform === "win32" }, async (t) => {
	const root = await workspace(t);
	await applyPatch(patch("*** Add File: file\n+first\n*** Add File: file\\other\n+second"), root);
	assert.equal(await text(root, "file\\other"), "second\n");
});

test("aborted calls and aborts while waiting for locks do not modify files", async (t) => {
	const root = await workspace(t);
	const input = patch("*** Add File: file\n+new");
	await assert.rejects(applyPatch(input, root, { signal: AbortSignal.abort() }), /abort/i);
	const controller = new AbortController();
	const withFileLock: FileLock = async (_path, action) => { controller.abort(); return action(); };
	await assert.rejects(applyPatch(input, root, { signal: controller.signal, withFileLock }), /abort/i);
	assert.deepEqual(await readdir(root), []);
});

test("cancellation before rename is explicit and cleans up the temporary file", async (t) => {
	const root = await workspace(t);
	await writeFile(join(root, "file"), "old\n");
	const controller = new AbortController();
	const check = controller.signal.throwIfAborted.bind(controller.signal);
	t.mock.method(controller.signal, "throwIfAborted", () => {
		// Deterministically cancel at the commit checkpoint, without timing races.
		if (readdirSync(root).some((name) => name.startsWith(".pi-patch-"))) controller.abort();
		check();
	});
	await assert.rejects(applyPatch(patch("*** Update File: file\n@@\n-old\n+new"), root, {
		signal: controller.signal,
	}), (error: Error) => {
		assert.match(error.message, /^Patch aborted before any file replacements or deletions were committed:/);
		assert.doesNotMatch(error.message, /failed|rollback/);
		return true;
	});
	assert.equal(await text(root, "file"), "old\n");
	assert.deepEqual(await readdir(root), ["file"]);
});

test("cancellation after a committed file still reports partial changes", async (t) => {
	const root = await workspace(t);
	const controller = new AbortController();
	const check = controller.signal.throwIfAborted.bind(controller.signal);
	t.mock.method(controller.signal, "throwIfAborted", () => {
		if (existsSync(join(root, "a"))) controller.abort();
		check();
	});
	await assert.rejects(applyPatch(patch("*** Add File: a\n+one\n*** Add File: b\n+two"), root, {
		signal: controller.signal,
	}), (error: Error) => {
		assert.match(error.message, /^Patch aborted at/);
		assert.ok(error.message.includes(`Completed file operations: ${JSON.stringify([join(root, "a")])}`));
		assert.match(error.message, /No automatic rollback/);
		return true;
	});
	assert.equal(await text(root, "a"), "one\n");
	assert.deepEqual(await readdir(root), ["a"]);
});

test("concurrent patches share Pi's per-file mutation queue", async (t) => {
	const root = await workspace(t);
	await writeFile(join(root, "file"), "base\n");
	await Promise.all(Array.from({ length: 6 }, (_, i) => applyPatch(
		patch(`*** Update File: file\n@@\n+line${i}`), root, { withFileLock: withFileMutationQueue },
	)));
	const lines = (await text(root, "file")).trim().split("\n");
	assert.equal(lines.length, 7);
	assert.equal(new Set(lines).size, 7);
});

test("opposite multi-file patch order does not deadlock", { timeout: 3000 }, async (t) => {
	const root = await workspace(t);
	await writeFile(join(root, "a"), "base\n");
	await writeFile(join(root, "b"), "base\n");
	const append = (file: string, value: string) => `*** Update File: ${file}\n@@\n+${value}`;
	await Promise.all([
		applyPatch(patch(`${append("a", "one")}\n${append("b", "one")}`), root, { withFileLock: withFileMutationQueue }),
		applyPatch(patch(`${append("b", "two")}\n${append("a", "two")}`), root, { withFileLock: withFileMutationQueue }),
	]);
	for (const file of ["a", "b"]) {
		assert.deepEqual((await text(root, file)).trim().split("\n").sort(), ["base", "one", "two"]);
	}
});

test("bounds patch input and source file sizes", async (t) => {
	const root = await workspace(t);
	await assert.rejects(applyPatch("x".repeat(MAX_PATCH_BYTES + 1), root), /1 MiB/);
	await writeFile(join(root, "big"), "x".repeat(MAX_FILE_BYTES + 1));
	await assert.rejects(applyPatch(patch("*** Delete File: big"), root), /10 MiB/);
});

test("atomic replacement respects existing file write protection", {
	skip: process.platform === "win32" || process.getuid?.() === 0,
}, async (t) => {
	const root = await workspace(t);
	const file = join(root, "protected");
	await writeFile(file, "old\n");
	await chmod(file, 0o444);
	try {
		await assert.rejects(applyPatch(patch("*** Add File: a-first\n+new\n*** Update File: protected\n@@\n-old\n+new"), root), /EACCES|EPERM/);
		assert.equal(await readFile(file, "utf8"), "old\n");
		assert.deepEqual(await readdir(root), ["protected"]);
	} finally {
		await chmod(file, 0o644);
	}
});

test("I/O failure reports completed files without deleting a move source", {
	skip: process.platform === "win32" || process.getuid?.() === 0,
}, async (t) => {
	const root = await workspace(t);
	const blocked = join(root, "blocked");
	await mkdir(blocked);
	await writeFile(join(root, "source"), "old\n");
	await chmod(blocked, 0o500);
	try {
		await assert.rejects(applyPatch(patch("*** Add File: a-first\n+ok\n*** Update File: source\n*** Move to: blocked/dest\n@@\n-old\n+new"), root), /Completed file operations:.*a-first.*No automatic rollback/s);
		assert.equal(await text(root, "a-first"), "ok\n");
		assert.equal(await text(root, "source"), "old\n");
		assert.deepEqual(await readdir(blocked), []);
	} finally {
		await chmod(blocked, 0o700);
	}
});
