import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	DIR_ADD_USAGE,
	dirExists,
	expandUserPath,
	hasUnsafeCharacters,
	isWithinDir,
	mergeScopedDirs,
	parseAddArgs,
	resolveDir,
	validateStoredPaths,
} from "../src/directories.ts";

async function temporary(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-add-dir-paths-"));
	t.after(async () => {
		await rm(directory, { recursive: true, force: true });
	});
	return directory;
}

test("parses session, project and global directory arguments", () => {
	assert.deepEqual(parseAddArgs(undefined), { source: "session", path: "" });
	assert.deepEqual(parseAddArgs("   "), { source: "session", path: "" });
	assert.deepEqual(parseAddArgs("/tmp/one"), { source: "session", path: "/tmp/one" });
	assert.deepEqual(parseAddArgs("--project /tmp/two"), { source: "project", path: "/tmp/two" });
	assert.deepEqual(parseAddArgs("--global"), { source: "global", path: "" });
	assert.deepEqual(parseAddArgs("--global /tmp/with space"), { source: "global", path: "/tmp/with space" });
});

test("rejects unknown flags and clears the project-only invocation", () => {
	assert.throws(() => parseAddArgs("--scope /tmp"), new RegExp(DIR_ADD_USAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("expands only a leading home directory reference", () => {
	const home = expandUserPath("~");
	assert.ok(home.startsWith("/"), "home resolves to an absolute path");
	assert.equal(expandUserPath("~nope"), "~nope");
});

test("canonicalizes relative, symlinked and missing paths", async (t) => {
	const root = await temporary(t);
	const target = join(root, "target");
	await mkdir(target);
	const link = join(root, "link");
	await symlink(target, link);
	assert.equal(resolveDir("target", root), target);
	assert.equal(resolveDir(link, root), target, "symlinked aliases resolve to one canonical path");
	assert.equal(resolveDir(join(root, "missing"), root), join(root, "missing"), "missing paths stay resolvable for diagnostics");
	assert.equal(dirExists(target), true);
	assert.equal(dirExists(join(root, "missing")), false);
});

test("detects nested directory overlap", () => {
	assert.equal(isWithinDir("/a/b", "/a/b"), true);
	assert.equal(isWithinDir("/a/b", "/a/b/c"), true);
	assert.equal(isWithinDir("/a/b", "/a/bc"), false);
	assert.equal(isWithinDir("/a/b", "/a"), false);
});

test("rejects non-absolute and control-character stored paths", () => {
	assert.throws(() => validateStoredPaths(["relative/path"], "project"));
	assert.throws(() => validateStoredPaths(["/tmp/line\nbreak"], "global"));
	assert.doesNotThrow(() => validateStoredPaths(["/tmp/ok", "/tmp/other"], "session"));
});

test("refuses terminal controls and line separators but supports shaped names", () => {
	for (const value of ["\u001b", "\u0000", "\u001b[31m", "\u009b", "\u2028", "\u2029", "line\u2028break"]) {
		assert.equal(hasUnsafeCharacters(value), true, JSON.stringify(value));
	}
	for (const value of ["", "plain", "/tmp/ok", "目录 with spaces 📁", "repo-\u{1f469}\u200d\u{1f4bb}", "glyph-\ue000"]) {
		assert.equal(hasUnsafeCharacters(value), false, JSON.stringify(value));
	}
});

test("keeps session directories active without existence checks", () => {
	const snapshot = mergeScopedDirs({
		cwd: "/work/current",
		sessionDirs: [{ absolutePath: "/elsewhere/missing", label: "missing" }],
		projectPaths: [],
		globalPaths: [],
	});
	assert.deepEqual(snapshot.addedDirs.map((dir) => dir.absolutePath), ["/elsewhere/missing"]);
});

test("resolves scope precedence, inactive reasons and active ordering", async (t) => {
	const root = await temporary(t);
	const shared = join(root, "shared");
	const nested = join(root, "shared", "nested");
	const other = join(root, "other");
	await mkdir(nested, { recursive: true });
	await mkdir(other);
	const missing = join(root, "gone");
	const cwd = join(root, "work");
	await mkdir(cwd);
	const snapshot = mergeScopedDirs({
		cwd,
		sessionDirs: [{ absolutePath: shared, label: "shared" }],
		projectPaths: [shared, missing, other, nested],
		globalPaths: [],
	});
	assert.deepEqual(snapshot.addedDirs.map(({ absolutePath, source }) => [absolutePath, source]), [
		[shared, "session"],
		[other, "project"],
	]);
	const inactive = new Map(snapshot.managedDirs.map((dir) => [dir.absolutePath, dir.inactiveReason]));
	assert.match(inactive.get(shared) ?? "", /shadowed by session scope/);
	assert.match(inactive.get(missing) ?? "", /does not exist/);
	assert.match(inactive.get(nested) ?? "", /overlaps session directory/);
	assert.ok(snapshot.skipped.some((dir) => dir.absolutePath === missing), "skips are reported for diagnostics");
});

test("deactivates persistent directories that overlap the working directory", async (t) => {
	const root = await temporary(t);
	const cwd = join(root, "work");
	await mkdir(cwd);
	const snapshot = mergeScopedDirs({
		cwd,
		sessionDirs: [],
		projectPaths: [root],
		globalPaths: [cwd],
	});
	assert.deepEqual(snapshot.addedDirs, []);
	assert.match(snapshot.managedDirs[0]?.inactiveReason ?? "", /overlaps current working directory scope/);
	assert.match(snapshot.managedDirs[1]?.inactiveReason ?? "", /overlaps current working directory scope/);
});
