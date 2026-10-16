import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import {
	createAddDirConfigStore,
	latestSessionDirs,
	mutateProjectConfig,
	parseAddDirConfig,
	readProjectPaths,
	readSessionDirs,
} from "../src/storage.ts";

const execFileAsync = promisify(execFile);

async function temporary(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-add-dir-storage-"));
	t.after(async () => {
		await rm(directory, { recursive: true, force: true });
	});
	return directory;
}

async function realExec(command: string, args: string[], options: { cwd?: string } = {}): Promise<ExecResult> {
	try {
		const result = await execFileAsync(command, args, { cwd: options.cwd, encoding: "utf8", timeout: 15_000 });
		return { code: 0, killed: false, stdout: result.stdout, stderr: result.stderr };
	} catch (error) {
		const failure = error as Error & { code?: number; killed?: boolean; stdout?: string; stderr?: string };
		return {
			code: typeof failure.code === "number" ? failure.code : 1,
			killed: failure.killed ?? false,
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? failure.message,
		};
	}
}

test("validates the global configuration schema", () => {
	assert.deepEqual(parseAddDirConfig({ directories: ["/a", "/b"] }), { directories: ["/a", "/b"] });
	assert.throws(() => parseAddDirConfig({ directories: ["relative"] }), /absolute paths/);
	assert.throws(() => parseAddDirConfig({ directories: ["/a\n"] }), /absolute paths/);
	assert.throws(() => parseAddDirConfig({ directories: ["/a", "/a"] }), /unique/);
	assert.throws(() => parseAddDirConfig({ directories: [], extra: 1 }), /only a "directories" array/);
});

test("treats a missing global configuration as empty without creating it", async (t) => {
	const agentDir = await temporary(t);
	const store = createAddDirConfigStore(agentDir);
	assert.deepEqual(store.loadSync(), { source: "missing", value: { directories: [] } });
	await assert.rejects(readFile(store.path, "utf8"), /ENOENT/);
});

test("never overwrites malformed global configuration", async (t) => {
	const agentDir = await temporary(t);
	const store = createAddDirConfigStore(agentDir);
	await mkdir(join(agentDir, "config/pi-add-dir"), { recursive: true });
	await writeFile(store.path, '{"directories":["relative"]}\n');
	assert.throws(() => store.loadSync(), /absolute paths/);
	await assert.rejects(store.update((current) => ({ directories: [...current.directories, "/new"] })), /absolute paths/);
	assert.equal(await readFile(store.path, "utf8"), '{"directories":["relative"]}\n');
});

test("restores only the last session state entry and filters invalid records", () => {
	const branch = [
		{ type: "custom", customType: "add-dir:state", data: { dirs: [{ absolutePath: "/first", label: "first" }] } },
		{ type: "message" },
		{
			type: "custom",
			customType: "add-dir:state",
			data: { dirs: [{ absolutePath: "/second", label: "second" }, { absolutePath: "relative", label: "bad" }, { label: "bad" }] },
		},
	];
	assert.deepEqual(latestSessionDirs(branch), [{ absolutePath: "/second", label: "second" }]);
	assert.deepEqual(latestSessionDirs([]), []);
	assert.deepEqual(readSessionDirs(undefined), []);
	assert.deepEqual(readSessionDirs({ dirs: "nope" }), []);
});

test("reads NUL-delimited project paths and requires a Git repository", async (t) => {
	const root = await temporary(t);
	const paths = ["/one", "/two"];
	const exec = async (_command: string, args: string[]): Promise<ExecResult> => {
		if (args[0] === "rev-parse") return { code: 0, killed: false, stdout: "true\n", stderr: "" };
		return { code: 0, killed: false, stdout: `${paths.join("\0")}\0`, stderr: "" };
	};
	assert.deepEqual(await readProjectPaths(exec, root, false), paths);
	const outside = async (_command: string, args: string[]): Promise<ExecResult> =>
		args[0] === "rev-parse"
			? { code: 128, killed: false, stdout: "", stderr: "fatal: not a git repository" }
			: { code: 1, killed: false, stdout: "", stderr: "" };
	assert.deepEqual(await readProjectPaths(outside, root, false), []);
	await assert.rejects(readProjectPaths(outside, root, true), /require a Git repository/);
});

test("rejects persisted project values that are not absolute paths", async (t) => {
	const root = await temporary(t);
	const exec = async (_command: string, args: string[]): Promise<ExecResult> =>
		args[0] === "rev-parse"
			? { code: 0, killed: false, stdout: "true\n", stderr: "" }
			: { code: 0, killed: false, stdout: "relative\n", stderr: "" };
	await assert.rejects(readProjectPaths(exec, root, false), /absolute paths/);
});

test("retries transient project config lock contention", async (t) => {
	const root = await temporary(t);
	let attempts = 0;
	const exec = async (): Promise<ExecResult> => {
		attempts += 1;
		if (attempts < 3) return { code: 128, killed: false, stdout: "", stderr: "error: could not lock config file .git/config: File exists" };
		return { code: 0, killed: false, stdout: "", stderr: "" };
	};
	await mutateProjectConfig(exec, ["--replace-all", "pi-add-dir.directory", "/x", "/x"], root, "save project directory");
	assert.equal(attempts, 3);
	const fatal = async (): Promise<ExecResult> => ({ code: 1, killed: false, stdout: "", stderr: "fatal: bad config" });
	await assert.rejects(mutateProjectConfig(fatal, [], root, "save project directory"), /Cannot save project directory: fatal: bad config/);
});

test("shares project directories across linked Git worktrees", { skip: process.platform === "win32", timeout: 30000 }, async (t) => {
	const root = await temporary(t);
	const repository = join(root, "repository");
	const worktree = join(root, "worktree");
	const external = join(root, "external");
	await mkdir(external);
	for (const args of [["init", "--initial-branch=main", repository],
		["-C", repository, "config", "user.email", "fixture@example.com"],
		["-C", repository, "config", "user.name", "Fixture"],
		["-C", repository, "commit", "--allow-empty", "-m", "init"]]) {
		const result = await realExec("git", args);
		assert.equal(result.code, 0, result.stderr);
	}
	const added = await realExec("git", ["-C", repository, "worktree", "add", worktree, "-b", "other"]);
	assert.equal(added.code, 0, added.stderr);
	await mutateProjectConfig(realExec, ["--replace-all", "--fixed-value", "pi-add-dir.directory", external, external], repository, "save");
	assert.deepEqual(await readProjectPaths(realExec, worktree, true), [external], "linked worktrees share the local config");
	await mutateProjectConfig(realExec, ["--unset-all", "--fixed-value", "pi-add-dir.directory", external], repository, "remove");
	assert.deepEqual(await readProjectPaths(realExec, worktree, true), []);
});
