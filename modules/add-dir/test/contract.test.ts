import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { addDirHarness, type ScriptedExec } from "./harness.ts";

async function temporary(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-add-dir-contract-"));
	t.after(async () => {
		await rm(directory, { recursive: true, force: true });
	});
	return directory;
}

async function externalDirectory(t: { after: (fn: () => Promise<void>) => void }, skill?: string): Promise<string> {
	const root = await temporary(t);
	if (skill) {
		await mkdir(join(root, ".pi/skills", skill), { recursive: true });
		await writeFile(join(root, ".pi/skills", skill, "SKILL.md"), `# ${skill}\n`);
	}
	return root;
}

const stateEntry = (...dirs: Array<{ absolutePath: string; label: string }>) => ({
	type: "custom",
	customType: "add-dir:state",
	data: { dirs },
});

const branchEntry = (id: string, ...dirs: Parameters<typeof stateEntry>) => ({
	id,
	parentId: null,
	...stateEntry(...dirs),
});

interface ScriptedExecResult {
	code: number;
	killed: boolean;
	stdout: string;
	stderr: string;
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function navigationHarness(t: TestContext, exec?: ScriptedExec) {
	const agentDir = await temporary(t);
	const root = await temporary(t);
	const first = join(root, "branch-a");
	const selected = join(root, "branch-b");
	const work = join(root, "work");
	for (const directory of [first, selected, work]) await mkdir(directory);
	const h = addDirHarness(t, { agentDir, exec });
	h.state.cwd = work;
	h.state.branch = () => h.state.branchEntries;
	const branchA = { id: "navigation-a", parentId: null, ...stateEntry({ absolutePath: first, label: "branch-a" }) };
	const branchB = { id: "navigation-b", parentId: null, ...stateEntry({ absolutePath: selected, label: "branch-b" }) };
	h.navigate([branchA]);
	h.rememberEntry(branchB);
	await h.emit("session_start");
	// The host has already navigated; this extension's session_tree delivery is still pending.
	h.navigate([branchB]);
	return { h, root, selected, branchA, branchB };
}

/** Models `git config --local` semantics so tests can assert what was really persisted. */
function gitConfigExec(
	options: {
		onWrite?: (attempt: number) => Promise<void> | void;
		failProbe?: (count: number) => boolean;
		onProbe?: (count: number) => Promise<void> | void;
		/** The first write attempt fails as if another process held the config lock. */
		lockOnce?: boolean;
	} = {},
) {
	const values: string[] = [];
	let probes = 0;
	let writes = 0;
	const exec = async (_command: string, args: string[]): Promise<ScriptedExecResult> => {
		if (args[0] === "rev-parse") {
			probes += 1;
			await options.onProbe?.(probes);
			return options.failProbe?.(probes)
				? { code: 0, killed: true, stdout: "", stderr: "" }
				: { code: 0, killed: false, stdout: "true\n", stderr: "" };
		}
		if (args.includes("--get-all")) {
			return values.length === 0
				? { code: 1, killed: false, stdout: "", stderr: "" }
				: { code: 0, killed: false, stdout: `${values.join("\0")}\0`, stderr: "" };
		}
		if (args.includes("--replace-all")) {
			writes += 1;
			await options.onWrite?.(writes);
			if (options.lockOnce && writes === 1) {
				return { code: 128, killed: false, stdout: "", stderr: "fatal: could not lock config file .git/config: File exists" };
			}
			const value = args.at(-1) ?? "";
			if (!values.includes(value)) values.push(value);
			return { code: 0, killed: false, stdout: "", stderr: "" };
		}
		if (args.includes("--unset-all")) {
			const index = values.indexOf(args.at(-1) ?? "");
			if (index < 0) return { code: 5, killed: false, stdout: "", stderr: "fatal: bad value" };
			values.splice(index, 1);
			return { code: 0, killed: false, stdout: "", stderr: "" };
		}
		return { code: 0, killed: false, stdout: "", stderr: "" };
	};
	return {
		values,
		exec,
		get writes() {
			return writes;
		},
	};
}

async function loopingSession(t: TestContext) {
	const agentDir = await temporary(t);
	const root = await temporary(t);
	const broken = join(root, "broken");
	const healthy = join(root, "healthy");
	await mkdir(broken);
	await mkdir(join(healthy, ".pi/skills/live"), { recursive: true });
	await writeFile(join(healthy, "AGENTS.md"), "healthy-only rules");
	const skillPath = join(healthy, ".pi/skills/live/SKILL.md");
	await writeFile(skillPath, "---\nname: live\ndescription: Local fixture\n---\nLocal instructions.\n");
	const git = gitConfigExec();
	const h = addDirHarness(t, { agentDir, exec: git.exec });
	h.state.cwd = await temporary(t);
	h.state.branch = () => h.state.branchEntries;
	await h.emit("session_start");
	await h.command("dir-add", broken);
	await h.command("dir-add", healthy);
	await rm(broken, { recursive: true });
	await symlink("broken", broken, "dir");
	return { h, git, broken, healthy, skillPath };
}

test("registers exactly two directory commands and no model tools", (t) => {
	const h = addDirHarness(t);
	assert.deepEqual([...h.commands.keys()].sort(), ["dir-add", "dir-ls"]);
	assert.deepEqual(h.tools, []);
	assert.match(h.commands.get("dir-add")?.description ?? "", /external directory/i);
});

test("restores the active branch and publishes external skills to the host", async (t) => {
	const directory = await externalDirectory(t, "demo");
	const agentDir = await temporary(t);
	const h = addDirHarness(t, { agentDir });
	h.state.branch = () => [
		stateEntry(),
		{ type: "message" },
		stateEntry({ absolutePath: directory, label: "demo" }),
	];
	await h.emit("session_start");
	assert.deepEqual(h.appendedEntries, [], "restoring does not rewrite the session");
	assert.deepEqual(await h.emit("resources_discover"), { skillPaths: [join(directory, ".pi/skills/demo/SKILL.md")] });
	assert.ok(h.renderWidget().join(" ").includes(directory.split("/").at(-1) ?? ""), "the widget reflects restored directories");
});

test("adding a directory without skills stays quiet, adding skills asks for /reload", async (t) => {
	const agentDir = await temporary(t);
	const plain = await externalDirectory(t);
	const skilled = await externalDirectory(t, "demo");
	const h = addDirHarness(t, { agentDir });
	await h.emit("session_start");
	await h.command("dir-add", plain);
	assert.match(h.notices.at(-1)?.message ?? "", /Added/);
	assert.ok(!/\/reload/.test(h.notices.at(-1)?.message ?? ""), "no skill change means no reload hint");
	await h.command("dir-add", skilled);
	assert.match(h.notices.at(-1)?.message ?? "", /Run \/reload to update external skills\./);
	assert.equal(h.state.reloadCount, 0, "the extension never reloads itself");
	assert.deepEqual(h.sentMessages, [], "the extension never sends user messages");
	assert.deepEqual(h.appendedEntries.map((entry) => entry.customType), ["add-dir:state", "add-dir:state"]);
});

test("a failed session append does not publish the new directory", async (t) => {
	const agentDir = await temporary(t);
	const skilled = await externalDirectory(t, "demo");
	const h = addDirHarness(t, { agentDir });
	await h.emit("session_start");
	h.state.appendError = new Error("appendEntry unavailable");
	await h.command("dir-add", skilled);
	assert.match(h.notices.at(-1)?.message ?? "", /appendEntry unavailable/);
	assert.equal(h.notices.at(-1)?.level, "error");
	assert.equal(await h.emit("resources_discover"), undefined, "the failed directory is not discoverable");
	h.state.appendError = null;
	await h.command("dir-add", skilled);
	assert.deepEqual(await h.emit("resources_discover"), { skillPaths: [join(skilled, ".pi/skills/demo/SKILL.md")] });
});

test("promotes a session directory to global scope and persists it once", async (t) => {
	const agentDir = await temporary(t);
	const directory = await externalDirectory(t);
	const h = addDirHarness(t, { agentDir });
	await h.emit("session_start");
	await h.command("dir-add", directory);
	await h.command("dir-add", `--global ${directory}`);
	assert.match(h.notices.at(-1)?.message ?? "", /global scope/);
	const label = directory.split("/").at(-1) ?? "root";
	assert.deepEqual(h.appendedEntries.map((entry) => (entry.data as { dirs: unknown[] }).dirs), [
		[{ absolutePath: directory, label }],
		[],
	], "the session copy is removed on promotion");
	const config = JSON.parse(await readFile(join(agentDir, "config/pi-add-dir/config.json"), "utf8"));
	assert.deepEqual(config, { directories: [directory] });
	assert.equal((await stat(join(agentDir, "config/pi-add-dir/config.json"))).mode & 0o777, 0o600);
});

test("rejects project persistence outside a Git repository", async (t) => {
	const agentDir = await temporary(t);
	const directory = await externalDirectory(t);
	const outside = await temporary(t);
	const exec = async (): Promise<{ code: number; killed: boolean; stdout: string; stderr: string }> => ({
		code: 128, killed: false, stdout: "", stderr: "fatal: not a git repository",
	});
	const h = addDirHarness(t, { agentDir, exec });
	h.state.cwd = outside;
	await h.emit("session_start");
	await h.command("dir-add", `--project ${directory}`);
	assert.match(h.notices.at(-1)?.message ?? "", /require a Git repository/);
	assert.equal(h.notices.at(-1)?.level, "error");
});

test("lists and removes a directory, leaving state untouched on cancel", async (t) => {
	const agentDir = await temporary(t);
	const skilled = await externalDirectory(t, "demo");
	const h = addDirHarness(t, { agentDir });
	await h.emit("session_start");
	await h.command("dir-add", `--global ${skilled}`);
	assert.match(h.notices.at(-1)?.message ?? "", /global scope/);
	const configPath = join(agentDir, "config/pi-add-dir/config.json");
	h.state.select = async () => undefined;
	const bytesBefore = await readFile(configPath, "utf8");
	const entriesBefore = h.appendedEntries.length;
	const noticesBefore = h.notices.length;
	await h.command("dir-ls", "");
	assert.equal(await readFile(configPath, "utf8"), bytesBefore, "cancelling rewrites nothing");
	assert.equal(h.appendedEntries.length, entriesBefore, "cancelling appends no session state");
	assert.equal(h.notices.length, noticesBefore, "cancelling reports nothing");
	h.state.select = async (_title, choices) => choices[0];
	await h.command("dir-ls", "");
	assert.match(h.notices.at(-1)?.message ?? "", /Removed/);
	assert.deepEqual(JSON.parse(await readFile(join(agentDir, "config/pi-add-dir/config.json"), "utf8")), { directories: [] });
});

test("tree navigation re-reads the branch without reloading or messaging", async (t) => {
	const agentDir = await temporary(t);
	const directory = await externalDirectory(t, "demo");
	const h = addDirHarness(t, { agentDir });
	await h.emit("session_start");
	h.state.branch = () => [stateEntry({ absolutePath: directory, label: "demo" })];
	await h.emit("session_tree");
	assert.deepEqual(await h.emit("resources_discover"), { skillPaths: [join(directory, ".pi/skills/demo/SKILL.md")] });
	assert.equal(h.state.reloadCount, 0);
	assert.deepEqual(h.sentMessages, []);
	assert.match(h.notices.at(-1)?.message ?? "", /\/reload/);
});

test("a reused instance re-arms per session instead of staying shut down", async (t) => {
	const agentDir = await temporary(t);
	const directory = await externalDirectory(t);
	const signals: Array<boolean | undefined> = [];
	const exec = async (
		_command: string,
		_args: string[],
		options?: { signal?: AbortSignal },
	): Promise<{ code: number; killed: boolean; stdout: string; stderr: string }> => {
		signals.push(options?.signal?.aborted);
		return { code: 128, killed: false, stdout: "", stderr: "fatal: not a git repository" };
	};
	const h = addDirHarness(t, { agentDir, exec });
	h.state.cwd = await temporary(t);
	await h.emit("session_start");
	await h.emit("session_shutdown");
	await h.emit("session_start");
	assert.deepEqual(signals, [false, false], "the replaced session uses a live lifetime");
	assert.equal(h.autocompleteFactories.length, 2, "each session registers its own completion wrapper");
	await h.command("dir-add", directory);
	assert.match(h.notices.at(-1)?.message ?? "", /Added/);
	assert.deepEqual(h.appendedEntries.map((entry) => entry.customType), ["add-dir:state"]);
});

test("an in-flight directory write never republishes into the replaced session", async (t) => {
	const agentDir = await temporary(t);
	const pending_ = await externalDirectory(t);
	const restored = await externalDirectory(t);
	let h: ReturnType<typeof addDirHarness>;
	let replaced = false;
	const signals: Array<boolean | undefined> = [];
	const exec = async (
		_command: string,
		args: string[],
		options?: { signal?: AbortSignal },
	): Promise<{ code: number; killed: boolean; stdout: string; stderr: string }> => {
		signals.push(options?.signal?.aborted);
		if (args[0] === "rev-parse") return { code: 0, killed: false, stdout: "true\n", stderr: "" };
		if (args.includes("--get-all")) return { code: 1, killed: false, stdout: "", stderr: "" };
		if (args.includes("--replace-all") && !replaced) {
			replaced = true;
			await h.emit("session_shutdown");
			h.state.branch = () => [stateEntry({ absolutePath: restored, label: "restored" })];
			await h.emit("session_start");
		}
		return { code: 0, killed: false, stdout: "", stderr: "" };
	};
	h = addDirHarness(t, { agentDir, exec });
	h.state.cwd = await temporary(t);
	await h.emit("session_start");
	await h.command("dir-add", `--project ${pending_}`);
	assert.equal(replaced, true, "the session was replaced while the write was in flight");
	assert.ok(signals.every((aborted) => aborted === false), "every replacement session uses a live lifetime");
	assert.deepEqual(h.appendedEntries, [], "the stale write publishes no session state");
	const widget = h.renderWidget().join(" ");
	assert.ok(widget.includes(restored.split("/").at(-1) ?? ""), "the replacement keeps its own directories");
	assert.ok(!widget.includes(pending_.split("/").at(-1) ?? ""), "the stale directory is never published");
	assert.deepEqual(h.notices, [], "the stale result is not announced to the replacement");
});

test("shutdown aborts an in-flight Git child and publishes nothing", async (t) => {
	const agentDir = await temporary(t);
	const directory = await externalDirectory(t);
	let h: ReturnType<typeof addDirHarness>;
	let release: (() => void) | undefined;
	let stalled = false;
	let abortObserved = false;
	const exec = async (
		_command: string,
		args: string[],
		options?: { signal?: AbortSignal },
	): Promise<{ code: number; killed: boolean; stdout: string; stderr: string }> => {
		if (args[0] === "rev-parse") return { code: 0, killed: false, stdout: "true\n", stderr: "" };
		if (args.includes("--get-all")) return { code: 1, killed: false, stdout: "", stderr: "" };
		stalled = true;
		await new Promise<void>((done) => {
			release = done;
			options?.signal?.addEventListener(
				"abort",
				() => {
					abortObserved = true;
					done();
				},
				{ once: true },
			);
		});
		return options?.signal?.aborted
			? { code: 0, killed: true, stdout: "", stderr: "" }
			: { code: 0, killed: false, stdout: "", stderr: "" };
	};
	h = addDirHarness(t, { agentDir, exec });
	h.state.cwd = await temporary(t);
	await h.emit("session_start");
	const pendingAdd = h.command("dir-add", `--project ${directory}`);
	while (!stalled) await new Promise((done) => setImmediate(done));
	await h.emit("session_shutdown");
	for (let attempt = 0; attempt < 100 && !abortObserved; attempt += 1) await new Promise((done) => setTimeout(done, 5));
	assert.equal(abortObserved, true, "the in-flight Git child observes the shutdown abort");
	release?.();
	await pendingAdd;
	assert.deepEqual(h.appendedEntries, [], "an aborted write publishes no session state");
	assert.deepEqual(h.notices, [], "an aborted write is not announced as a successful add");
});

test("a promotion in flight during branch navigation never writes into the selected branch", async (t) => {
	const agentDir = await temporary(t);
	const promoted = await externalDirectory(t);
	const other = await externalDirectory(t);
	let release: (() => void) | undefined;
	let stalled = false;
	const git = gitConfigExec({
		onWrite: () =>
			new Promise<void>((done) => {
				stalled = true;
				release = done;
			}),
	});
	const h = addDirHarness(t, { agentDir, exec: git.exec });
	h.state.cwd = await temporary(t);
	h.state.branch = () => h.state.branchEntries;
	await h.emit("session_start");
	await h.command("dir-add", promoted);
	assert.equal(h.appendedEntries.length, 1);
	const target = branchEntry(
		"promotion-target",
		{ absolutePath: promoted, label: promoted.split("/").at(-1) ?? "" },
		{ absolutePath: other, label: other.split("/").at(-1) ?? "" },
	);
	h.rememberEntry(target);
	const oldLeafId = h.state.leafId;
	const promoting = h.command("dir-add", `--project ${promoted}`);
	const successesBefore = h.notices.filter((notice) => notice.level === "info" && /^Added /.test(notice.message)).length;
	while (!stalled) await new Promise((done) => setImmediate(done));
	// The user navigates while the durable write is in flight, not before its admission.
	h.navigate([target]);
	await h.emit("session_tree", h.ctx, { oldLeafId, newLeafId: target.id });
	release?.();
	await promoting;
	assert.equal(h.appendedEntries.length, 1, "the stale promotion appends nothing to the selected branch");
	assert.equal(
		((h.state.branchEntries.at(-1) as { data: { dirs: unknown[] } }).data).dirs.length,
		2,
		"the selected branch keeps both directories",
	);
	const widget = h.renderWidget(300).join(" ");
	assert.ok(widget.includes(other.split("/").at(-1) ?? ""), "the selected branch's own directories stay active");
	assert.equal(
		h.notices.filter((notice) => notice.level === "info" && /^Added /.test(notice.message)).length,
		successesBefore,
		"no stale success is announced",
	);
});

for (const operation of ["promotion", "addition", "removal"] as const) {
	test(`an earlier-admitted persistent ${operation} uses the branch selected during I/O`, async (t) => {
		const agentDir = await temporary(t);
		const root = await temporary(t);
		const kept = join(root, "kept");
		const abandoned = join(root, "abandoned");
		const persistent = join(root, "persistent");
		for (const directory of [kept, abandoned, persistent]) await mkdir(directory);
		const started = deferred();
		const gate = deferred();
		t.after(() => gate.resolve());
		const git = gitConfigExec();
		if (operation === "removal") git.values.push(persistent);
		const h = addDirHarness(t, {
			agentDir,
			exec: async (command, args) => {
				if (args.includes("--replace-all") || args.includes("--unset-all")) {
					started.resolve();
					await gate.promise;
				}
				return git.exec(command, args);
			},
		});
		h.state.cwd = await temporary(t);
		h.state.branch = () => h.state.branchEntries;
		await h.emit("session_start");
		await h.command("dir-add", kept);
		const earlierBranch = [...h.state.branchEntries];
		h.state.select = async (_title, choices) => choices.find((choice) => choice.startsWith("[project]"));
		// Both commands are admitted at A. The addition commits B before the persistent command
		// runs, so its admission and the cache binding now describe different leaves.
		const adding = h.command("dir-add", abandoned);
		const changing = operation === "removal"
			? h.command("dir-ls", "")
			: h.command("dir-add", `--project ${operation === "promotion" ? kept : persistent}`);
		await started.promise;
		await adding;
		assert.equal(h.appendedEntries.length, 2, "the queued sibling appended B before Git stalled");
		const before = h.state.branchEntries.at(-1) as { data: { dirs: Array<{ absolutePath: string }> } };
		assert.deepEqual(before.data.dirs.map((dir) => dir.absolutePath), [kept, abandoned]);
		// Pi rolls back to A, but an earlier event handler has not yet delivered session_tree.
		h.navigate(earlierBranch);
		gate.resolve();
		await changing;
		assert.deepEqual(
			git.values,
			operation === "removal" ? [] : [operation === "promotion" ? kept : persistent],
			"the already-started durable change stands",
		);
		const selected = h.state.branchEntries.at(-1) as { data: { dirs: Array<{ absolutePath: string }> } };
		assert.deepEqual(
			selected.data.dirs.map((dir) => dir.absolutePath),
			operation === "promotion" ? [] : [kept],
			"no directory from the abandoned branch is appended onto A",
		);
		assert.equal(h.appendedEntries.length, operation === "promotion" ? 3 : 2);
		const widget = h.renderWidget(400).join(" ");
		assert.ok(widget.includes("kept"), "the selected branch's directory remains visible");
		assert.ok(!widget.includes("abandoned"), "post-I/O publication never shows B's abandoned directory");
		assert.equal(widget.includes("persistent"), operation === "addition");
	});
}

test("promotion uses a session match restored while the durable write is in flight", async (t) => {
	const agentDir = await temporary(t);
	const root = await temporary(t);
	const kept = join(root, "kept");
	const holding = join(root, "holding");
	for (const directory of [kept, holding]) await mkdir(directory);
	const holdingStarted = deferred();
	const releaseHolding = deferred();
	const promotionStarted = deferred();
	const releasePromotion = deferred();
	t.after(() => {
		releaseHolding.resolve();
		releasePromotion.resolve();
	});
	const git = gitConfigExec({
		onWrite: async (attempt) => {
			if (attempt === 1) {
				holdingStarted.resolve();
				await releaseHolding.promise;
			} else {
				promotionStarted.resolve();
				await releasePromotion.promise;
			}
		},
	});
	const h = addDirHarness(t, { agentDir, exec: git.exec });
	h.state.cwd = await temporary(t);
	h.state.branch = () => h.state.branchEntries;
	await h.emit("session_start");
	await h.command("dir-add", kept);
	const earlierBranch = [...h.state.branchEntries];
	const holdingCommand = h.command("dir-add", `--project ${holding}`);
	await holdingStarted.promise;
	h.state.select = async (_title, choices) => choices[0];
	const removing = h.command("dir-ls", "");
	// Let the resolved selector queue its removal behind the holding command.
	await Promise.resolve();
	const promoting = h.command("dir-add", `--project ${kept}`);
	releaseHolding.resolve();
	await holdingCommand;
	await removing;
	await promotionStarted.promise;
	const empty = h.state.branchEntries.at(-1) as { data: { dirs: unknown[] } };
	assert.deepEqual(empty.data.dirs, [], "the removal appended B before promotion reached Git");
	h.navigate(earlierBranch);
	releasePromotion.resolve();
	await promoting;
	assert.deepEqual(git.values, [holding, kept]);
	const selected = h.state.branchEntries.at(-1) as { data: { dirs: unknown[] } };
	assert.deepEqual(selected.data.dirs, [], "the restored session match is promoted out of A");
	assert.equal(h.appendedEntries.length, 3);
	let rows: string[] = [];
	h.state.select = async (_title, choices) => {
		rows = choices;
		return undefined;
	};
	await h.command("dir-ls", "");
	assert.equal(rows.length, 2, "both durable project directories remain");
	assert.ok(rows.every((row) => row.startsWith("[project]")), "no session copy shadows project scope");
});

test("serializes concurrent additions so nested directories cannot both commit", async (t) => {
	const agentDir = await temporary(t);
	const root = await temporary(t);
	const parent = join(root, "parent");
	const child = join(parent, "child");
	await mkdir(child, { recursive: true });
	let release: (() => void) | undefined;
	let stalled = false;
	const git = gitConfigExec({
		onWrite: () =>
			new Promise<void>((done) => {
				stalled = true;
				release = done;
			}),
	});
	const h = addDirHarness(t, { agentDir, exec: git.exec });
	h.state.cwd = await temporary(t);
	await h.emit("session_start");
	const first = h.command("dir-add", `--project ${parent}`);
	while (!stalled) await new Promise((done) => setImmediate(done));
	const second = h.command("dir-add", `--project ${child}`);
	release?.();
	await Promise.all([first, second]);
	const added = h.notices.filter((notice) => notice.level === "info" && /^Added /.test(notice.message));
	assert.equal(added.length, 1, "exactly one of two nested additions may commit");
	assert.deepEqual(git.values, [parent], "only the parent is persisted");
	assert.equal(h.notices.at(-1)?.level, "error");
	assert.match(h.notices.at(-1)?.message ?? "", /overlaps already-added directory/);
});

test("discards a queued session command when the branch changes while it waits", async (t) => {
	const agentDir = await temporary(t);
	const project = await externalDirectory(t);
	const kept = await externalDirectory(t);
	const queued = await externalDirectory(t);
	let release: (() => void) | undefined;
	let stalled = false;
	const git = gitConfigExec({
		onWrite: () =>
			new Promise<void>((done) => {
				stalled = true;
				release = done;
			}),
	});
	const h = addDirHarness(t, { agentDir, exec: git.exec });
	h.state.cwd = await temporary(t);
	h.state.branch = () => h.state.branchEntries;
	await h.emit("session_start");
	await h.command("dir-add", kept);
	const appendsBefore = h.appendedEntries.length;
	const noticesBefore = h.notices.length;
	const target = branchEntry("queued-target", { absolutePath: kept, label: kept.split("/").at(-1) ?? "" });
	h.rememberEntry(target);
	const oldLeafId = h.state.leafId;
	// A project add stalls inside Git while a session add waits behind it in the queue.
	const promoting = h.command("dir-add", `--project ${project}`);
	while (!stalled) await new Promise((done) => setImmediate(done));
	const queuedAdd = h.command("dir-add", queued);
	// The user navigates away before the queue drains.
	h.navigate([target]);
	await h.emit("session_tree", h.ctx, { oldLeafId, newLeafId: target.id });
	release?.();
	await Promise.all([promoting, queuedAdd]);
	assert.deepEqual(git.values, [project], "the durable write that had already started still stands");
	assert.equal(h.appendedEntries.length, appendsBefore, "the queued command appends nothing to the selected branch");
	assert.equal(h.notices.length, noticesBefore, "a discarded command announces nothing");
	const dirs = (h.state.branchEntries.at(-1) as { data: { dirs: Array<{ absolutePath: string }> } }).data.dirs;
	assert.deepEqual(
		dirs.map((dir) => dir.absolutePath),
		[kept],
		"the selected branch keeps exactly its own directory",
	);
});

test("a prompt or selector answered after navigation changes nothing", async (t) => {
	const agentDir = await temporary(t);
	const directory = await externalDirectory(t);
	const typed = await externalDirectory(t);
	const h = addDirHarness(t, { agentDir });
	h.state.cwd = await temporary(t);
	h.state.branch = () => h.state.branchEntries;
	await h.emit("session_start");
	await h.command("dir-add", directory);
	const appendsBefore = h.appendedEntries.length;
	const promptTarget = branchEntry("prompt-target", { absolutePath: directory, label: directory.split("/").at(-1) ?? "" });
	h.rememberEntry(promptTarget);
	const promptLeaf = h.state.leafId;
	// The path prompt is still open when the user switches branches.
	h.state.input = async () => {
		h.navigate([promptTarget]);
		await h.emit("session_tree", h.ctx, { oldLeafId: promptLeaf, newLeafId: promptTarget.id });
		return typed;
	};
	await h.command("dir-add", "");
	assert.equal(h.state.inputCalls, 1, "the prompt really happened");
	assert.equal(h.appendedEntries.length, appendsBefore, "an answer from a previous branch adds nothing");
	// The selector is still open when the user switches to a branch with a different directory.
	const other = join(await temporary(t), "other");
	await mkdir(other);
	const selectorTarget = branchEntry("selector-target", { absolutePath: other, label: "other" });
	h.rememberEntry(selectorTarget);
	const selectorLeaf = h.state.leafId;
	const noticesBefore = h.notices.length;
	let offered: string[] = [];
	h.state.select = async (_title, choices) => {
		offered = choices;
		h.navigate([selectorTarget]);
		await h.emit("session_tree", h.ctx, { oldLeafId: selectorLeaf, newLeafId: selectorTarget.id });
		return choices[0];
	};
	await h.command("dir-ls", "");
	assert.equal(h.state.selectCalls, 1, "the selector really opened");
	assert.equal(offered.length, 1, "the previous branch offered its own directory");
	assert.equal(h.notices.length, noticesBefore, "a choice from a previous branch is not even reported");
	assert.equal(h.appendedEntries.length, appendsBefore, "a selection from a previous branch removes nothing");
	const dirs = (h.state.branchEntries.at(-1) as { data: { dirs: Array<{ absolutePath: string }> } }).data.dirs;
	assert.deepEqual(dirs.map((entry) => entry.absolutePath), [other], "the selected branch keeps its own directory");
	assert.ok(h.renderWidget(300).join(" ").includes("other"), "the widget shows the selected branch");
});

test("a startup whose project read resolves after shutdown publishes nothing", async (t) => {
	const agentDir = await temporary(t);
	const restored = await externalDirectory(t, "demo");
	let release: (() => void) | undefined;
	let stalled = false;
	const exec = async (_command: string, args: string[]): Promise<ScriptedExecResult> => {
		if (args[0] === "rev-parse") {
			stalled = true;
			await new Promise<void>((done) => {
				release = done;
			});
			return { code: 0, killed: false, stdout: "true\n", stderr: "" };
		}
		return { code: 1, killed: false, stdout: "", stderr: "" };
	};
	const h = addDirHarness(t, { agentDir, exec });
	h.state.cwd = await temporary(t);
	h.state.branch = () => [stateEntry({ absolutePath: restored, label: restored.split("/").at(-1) ?? "" })];
	const startup = h.emit("session_start");
	while (!stalled) await new Promise((done) => setImmediate(done));
	await h.emit("session_shutdown");
	release?.();
	await startup;
	assert.deepEqual(h.renderWidget(), [], "a stale startup restores nothing into the widget");
	assert.deepEqual(h.autocompleteFactories, [], "a stale startup registers no completion");
	assert.equal(await h.emit("resources_discover"), undefined, "a stale startup offers no skills");
});

test("a branch switch Pi performs before emitting session_tree still stops a queued command", async (t) => {
	const agentDir = await temporary(t);
	const project = await externalDirectory(t);
	const queued = await externalDirectory(t);
	const kept = await externalDirectory(t);
	const other = join(await temporary(t), "other");
	await mkdir(other);
	let release: (() => void) | undefined;
	let stalled = false;
	const git = gitConfigExec({
		onWrite: () =>
			new Promise<void>((done) => {
				stalled = true;
				release = done;
			}),
	});
	const h = addDirHarness(t, { agentDir, exec: git.exec });
	h.state.cwd = await temporary(t);
	h.state.branch = () => h.state.branchEntries;
	await h.emit("session_start");
	await h.command("dir-add", kept);
	const appendsBefore = h.appendedEntries.length;
	const promoting = h.command("dir-add", `--project ${project}`);
	while (!stalled) await new Promise((done) => setImmediate(done));
	const queuedAdd = h.command("dir-add", queued);
	// Pi points its live leaf at the other branch first; an earlier session_tree handler is
	// still running, so this module has not received the event while the Git write finishes.
	h.navigate([
		{
			id: "branch-b",
			parentId: null,
			type: "custom",
			customType: "add-dir:state",
			data: { dirs: [{ absolutePath: other, label: "other" }] },
		},
	]);
	release?.();
	await Promise.all([promoting, queuedAdd]);
	assert.deepEqual(git.values, [project], "the durable write that had already started still stands");
	assert.equal(h.appendedEntries.length, appendsBefore, "the queued command appends nothing to the branch Pi now points at");
	assert.deepEqual(
		h.state.branchEntries.map((entry) => (entry as { id?: string }).id),
		["branch-b"],
		"the branch Pi switched to keeps exactly its own entries",
	);
});

test("navigation into an entry that already existed is not a fresh append", async (t) => {
	const agentDir = await temporary(t);
	const kept = await externalDirectory(t);
	const project = await externalDirectory(t);
	const queued = await externalDirectory(t);
	const other = join(await temporary(t), "other");
	await mkdir(other);
	let release: (() => void) | undefined;
	let stalled = false;
	const git = gitConfigExec({
		onWrite: () =>
			new Promise<void>((done) => {
				stalled = true;
				release = done;
			}),
	});
	const h = addDirHarness(t, { agentDir, exec: git.exec });
	h.state.cwd = await temporary(t);
	h.state.branch = () => h.state.branchEntries;
	await h.emit("session_start");
	await h.command("dir-add", kept);
	const keptEntry = h.state.branchEntries.at(-1) as { id: string };
	const appendsBefore = h.appendedEntries.length;
	// A descendant of the admitted leaf already exists and holds a different state.
	const descendant = {
		id: "existing-descendant",
		parentId: keptEntry.id,
		type: "custom",
		customType: "add-dir:state",
		data: { dirs: [{ absolutePath: other, label: "other" }] },
	};
	h.navigate([keptEntry], keptEntry.id);
	h.rememberEntry(descendant);
	const promoting = h.command("dir-add", `--project ${project}`);
	while (!stalled) await new Promise((done) => setImmediate(done));
	const queuedAdd = h.command("dir-add", queued);
	// Pi navigates down into the entry that already existed, before announcing session_tree.
	h.navigate([keptEntry, descendant], descendant.id);
	release?.();
	await Promise.all([promoting, queuedAdd]);
	assert.equal(h.appendedEntries.length, appendsBefore, "the cached list never replaces the descendant's own state");
	assert.deepEqual(
		(h.state.branchEntries.at(-1) as { data: { dirs: Array<{ absolutePath: string }> } }).data.dirs.map((dir) => dir.absolutePath),
		[other],
		"the descendant keeps the state it already had",
	);
});

test("a command admitted without a leaf does not follow navigation into an existing branch", async (t) => {
	const agentDir = await temporary(t);
	const kept = await externalDirectory(t);
	const project = await externalDirectory(t);
	const queued = await externalDirectory(t);
	let release: (() => void) | undefined;
	let stalled = false;
	const git = gitConfigExec({
		onWrite: () =>
			new Promise<void>((done) => {
				stalled = true;
				release = done;
			}),
	});
	const h = addDirHarness(t, { agentDir, exec: git.exec });
	h.state.cwd = await temporary(t);
	h.state.branch = () => h.state.branchEntries;
	await h.emit("session_start");
	await h.command("dir-add", kept);
	const keptEntry = h.state.branchEntries.at(-1) as { id: string };
	const appendsBefore = h.appendedEntries.length;
	// Pi resets the live leaf to the root before the commands are admitted.
	h.navigate([], null);
	const promoting = h.command("dir-add", `--project ${project}`);
	while (!stalled) await new Promise((done) => setImmediate(done));
	const queuedAdd = h.command("dir-add", queued);
	// Pi then navigates to the entry that existed before admission.
	h.navigate([keptEntry], keptEntry.id);
	release?.();
	await Promise.all([promoting, queuedAdd]);
	assert.equal(h.appendedEntries.length, appendsBefore, "no cached state is appended onto the existing branch");
	assert.deepEqual(
		(h.state.branchEntries.at(-1) as { data: { dirs: Array<{ absolutePath: string }> } }).data.dirs.map((dir) => dir.absolutePath),
		[kept],
		"the existing branch keeps its own directory",
	);
});

test("a project command that went stale during its read never starts the write", async (t) => {
	const agentDir = await temporary(t);
	const directory = await externalDirectory(t);
	let release: (() => void) | undefined;
	let stalled = false;
	// The second probe is the preparatory read inside the command.
	const git = gitConfigExec({
		onProbe: (count) =>
			count === 2
				? new Promise<void>((done) => {
						stalled = true;
						release = done;
					})
				: undefined,
	});
	const h = addDirHarness(t, { agentDir, exec: git.exec });
	h.state.cwd = await temporary(t);
	h.state.branch = () => h.state.branchEntries;
	await h.emit("session_start");
	const navigation = branchEntry("stale-read-target");
	h.rememberEntry(navigation);
	const pending = h.command("dir-add", `--project ${directory}`);
	while (!stalled) await new Promise((done) => setImmediate(done));
	h.navigate([navigation]);
	await h.emit("session_tree", h.ctx, { oldLeafId: null, newLeafId: navigation.id });
	release?.();
	await pending;
	assert.deepEqual(git.values, [], "a stale command launches no mutation");
	assert.equal(git.writes, 0, "no write attempt reaches Git");
	assert.deepEqual(h.notices, [], "a stale command reports nothing");
});

test("a project read that lands after navigation never reaches the cache", async (t) => {
	const agentDir = await temporary(t);
	const target = await externalDirectory(t);
	const sneakyRoot = await temporary(t);
	const sneaky = join(sneakyRoot, "sneaky");
	await mkdir(sneaky);
	let release: (() => void) | undefined;
	let stalled = false;
	// The second probe is the preparatory read inside the command.
	const git = gitConfigExec({
		onProbe: (count) =>
			count === 2
				? new Promise<void>((done) => {
						stalled = true;
						release = done;
					})
				: undefined,
	});
	const h = addDirHarness(t, { agentDir, exec: git.exec });
	h.state.cwd = await temporary(t);
	h.state.branch = () => h.state.branchEntries;
	await h.emit("session_start");
	const navigation = branchEntry("stale-cache-target");
	h.rememberEntry(navigation);
	const pending = h.command("dir-add", `--project ${target}`);
	while (!stalled) await new Promise((done) => setImmediate(done));
	// Another process writes a directory while the read is in flight, then the session changes.
	git.values.push(sneaky);
	h.navigate([navigation]);
	await h.emit("session_tree", h.ctx, { oldLeafId: null, newLeafId: navigation.id });
	release?.();
	await pending;
	// A later command with a current admission republishes whatever the module cached.
	await h.command("dir-add", await externalDirectory(t));
	assert.ok(!h.renderWidget(300).join(" ").includes("sneaky"), "the stale read never becomes the module's cache");
	assert.deepEqual(git.values, [sneaky], "the stale command writes nothing");
});

test("a stale command does not launch a retry after lock contention", async (t) => {
	const agentDir = await temporary(t);
	const directory = await externalDirectory(t);
	let release: (() => void) | undefined;
	let stalled = false;
	const git = gitConfigExec({
		lockOnce: true,
		onWrite: () =>
			new Promise<void>((done) => {
				stalled = true;
				release = done;
			}),
	});
	const h = addDirHarness(t, { agentDir, exec: git.exec });
	h.state.cwd = await temporary(t);
	h.state.branch = () => h.state.branchEntries;
	await h.emit("session_start");
	const navigation = branchEntry("stale-retry-target");
	h.rememberEntry(navigation);
	const pending = h.command("dir-add", `--project ${directory}`);
	while (!stalled) await new Promise((done) => setImmediate(done));
	// Navigation lands while the command waits for the config lock to clear.
	h.navigate([navigation]);
	await h.emit("session_tree", h.ctx, { oldLeafId: null, newLeafId: navigation.id });
	release?.();
	await pending;
	assert.equal(git.writes, 1, "only the attempt that had already started was launched");
	assert.deepEqual(git.values, [], "the retry never writes after the command went stale");
});

for (const target of ["existing leaf", "empty leaf"] as const) {
	test(`a delayed tree event preserves project admission on the ${target}`, async (t) => {
		const started = deferred();
		const gate = deferred();
		t.after(() => gate.resolve());
		const git = gitConfigExec({
			onProbe: async (count) => {
				if (count === 2) {
					started.resolve();
					await gate.promise;
				}
			},
		});
		const { h, root, branchA, branchB } = await navigationHarness(t, git.exec);
		const added = join(root, "added");
		await mkdir(added);
		if (target === "empty leaf") h.navigate([]);
		const changing = h.command("dir-add", `--project ${added}`);
		await started.promise;
		await h.emit("session_tree", h.ctx, {
			oldLeafId: branchA.id,
			newLeafId: target === "existing leaf" ? branchB.id : null,
		});
		gate.resolve();
		await changing;
		assert.deepEqual(git.values, [added], "delivery of an already-selected branch's event does not cancel its write");
		assert.equal(h.appendedEntries.length, 0, "a project addition needs no session append");
		assert.ok(h.notices.some((notice) => notice.level === "info" && notice.message.startsWith("Added ")));
		assert.ok(h.renderWidget(300).join(" ").includes("added"), "the successful addition is published");
	});
}

test("a delayed tree event preserves prompted admission on its selected branch", async (t) => {
	const { h, root, selected, branchA, branchB } = await navigationHarness(t);
	const added = join(root, "added");
	await mkdir(added);
	const asked = deferred();
	let answer!: (path: string) => void;
	const response = new Promise<string>((done) => {
		answer = done;
	});
	h.state.input = async () => {
		asked.resolve();
		return response;
	};
	const changing = h.command("dir-add", "");
	await asked.promise;
	await h.emit("session_tree", h.ctx, { oldLeafId: branchA.id, newLeafId: branchB.id });
	answer(added);
	await changing;
	assert.equal(h.appendedEntries.length, 1);
	const entry = h.state.branchEntries.at(-1) as { data: { dirs: Array<{ absolutePath: string }> } };
	assert.deepEqual(entry.data.dirs.map((dir) => dir.absolutePath), [selected, added]);
	assert.ok(h.notices.some((notice) => notice.level === "info" && notice.message.startsWith("Added ")));
});

test("a delayed tree event preserves selector admission on its selected branch", async (t) => {
	const { h, branchA, branchB } = await navigationHarness(t);
	const asked = deferred();
	let answer!: (choice: string) => void;
	let selected = "";
	const response = new Promise<string>((done) => {
		answer = done;
	});
	h.state.select = async (_title, choices) => {
		selected = choices[0] ?? "";
		asked.resolve();
		return response;
	};
	const removing = h.command("dir-ls", "");
	await asked.promise;
	await h.emit("session_tree", h.ctx, { oldLeafId: branchA.id, newLeafId: branchB.id });
	answer(selected);
	await removing;
	assert.equal(h.appendedEntries.length, 1);
	const entry = h.state.branchEntries.at(-1) as { data: { dirs: unknown[] } };
	assert.deepEqual(entry.data.dirs, [], "the valid selection removes B's session directory");
	assert.ok(h.notices.some((notice) => notice.level === "info" && notice.message.startsWith("Removed ")));
});

test("a delayed tree event preserves in-flight and queued project commands on its selected branch", async (t) => {
	const started = deferred();
	const gate = deferred();
	t.after(() => gate.resolve());
	const git = gitConfigExec({
		onWrite: async (attempt) => {
			if (attempt === 1) {
				started.resolve();
				await gate.promise;
			}
		},
	});
	const { h, root, selected, branchA, branchB } = await navigationHarness(t, git.exec);
	const holding = join(root, "holding");
	await mkdir(holding);
	const inFlight = h.command("dir-add", `--project ${holding}`);
	await started.promise;
	const queued = h.command("dir-add", `--project ${selected}`);
	await h.emit("session_tree", h.ctx, { oldLeafId: branchA.id, newLeafId: branchB.id });
	gate.resolve();
	await Promise.all([inFlight, queued]);
	assert.deepEqual(git.values, [holding, selected], "both admissions remain valid on B");
	assert.equal(h.appendedEntries.length, 1, "the queued promotion removes B's session copy");
	const entry = h.state.branchEntries.at(-1) as { data: { dirs: unknown[] } };
	assert.deepEqual(entry.data.dirs, []);
	assert.equal(h.notices.filter((notice) => notice.level === "info" && notice.message.startsWith("Added ")).length, 2);
});

test("an unverifiable admission remains invalidated by a tree event", async (t) => {
	const { h, root, branchA } = await navigationHarness(t);
	const added = join(root, "added");
	await mkdir(added);
	h.state.leafId = "unresolvable-leaf";
	const asked = deferred();
	let answer!: (path: string) => void;
	const response = new Promise<string>((done) => {
		answer = done;
	});
	h.state.input = async () => {
		asked.resolve();
		return response;
	};
	const changing = h.command("dir-add", "");
	await asked.promise;
	await h.emit("session_tree", h.ctx, { oldLeafId: branchA.id, newLeafId: "unresolvable-leaf" });
	answer(added);
	await changing;
	assert.equal(h.appendedEntries.length, 0, "without a resolvable leaf, the conservative event epoch still applies");
	assert.equal(h.notices.length, 0);
});

test("a same-session lifecycle replacement still invalidates a prompted command", async (t) => {
	const { h, root } = await navigationHarness(t);
	const added = join(root, "added");
	await mkdir(added);
	const asked = deferred();
	let answer!: (path: string) => void;
	const response = new Promise<string>((done) => {
		answer = done;
	});
	h.state.input = async () => {
		asked.resolve();
		return response;
	};
	const changing = h.command("dir-add", "");
	await asked.promise;
	await h.emit("session_start");
	answer(added);
	await changing;
	assert.equal(h.appendedEntries.length, 0, "a changed lifecycle rejects old input even with the same session and leaf IDs");
	assert.equal(h.notices.length, 0);
});

test("a command admitted after a host-side branch switch extends that branch", async (t) => {
	const agentDir = await temporary(t);
	const branchA = join(await temporary(t), "branch-a");
	const branchB = join(await temporary(t), "branch-b");
	const added = join(await temporary(t), "added");
	for (const dir of [branchA, branchB, added]) await mkdir(dir);
	const h = addDirHarness(t, { agentDir });
	h.state.cwd = await temporary(t);
	h.state.branch = () => h.state.branchEntries;
	await h.emit("session_start");
	await h.command("dir-add", branchA);
	// Another branch already carries its own directory state.
	const otherBranch = {
		id: "branch-b",
		parentId: null,
		type: "custom",
		customType: "add-dir:state",
		data: { dirs: [{ absolutePath: branchB, label: "branch-b" }] },
	};
	h.rememberEntry(otherBranch);
	// Pi switches the live leaf before this module receives session_tree, and the user then
	// issues a command on the branch that is now current.
	h.navigate([otherBranch], otherBranch.id);
	await h.command("dir-add", added);
	const appended = h.appendedEntries.at(-1) as { data: { dirs: Array<{ absolutePath: string }> } };
	assert.deepEqual(
		appended.data.dirs.map((dir) => dir.absolutePath),
		[branchB, added],
		"the command extends the branch it runs on, not the branch it left",
	);
});

test("navigating back to an earlier entry does not resurrect the abandoned directory", async (t) => {
	const agentDir = await temporary(t);
	const first = join(await temporary(t), "first");
	const second = join(await temporary(t), "second");
	const third = join(await temporary(t), "third");
	for (const dir of [first, second, third]) await mkdir(dir);
	const h = addDirHarness(t, { agentDir });
	h.state.cwd = await temporary(t);
	h.state.branch = () => h.state.branchEntries;
	await h.emit("session_start");
	await h.command("dir-add", first);
	const earlier = h.state.branchEntries.at(-1) as { id: string };
	await h.command("dir-add", second);
	// Pi moves the leaf back to the earlier entry, without announcing the change yet.
	h.navigate([earlier], earlier.id);
	await h.command("dir-add", third);
	const appended = h.appendedEntries.at(-1) as { data: { dirs: Array<{ absolutePath: string }> } };
	assert.deepEqual(
		appended.data.dirs.map((dir) => dir.absolutePath),
		[first, third],
		"the directory added after the earlier entry stays on its own branch",
	);
});

test("removes the row the user selected when two choices render identically", async (t) => {
	const agentDir = await temporary(t);
	const root = await temporary(t);
	const bidi = join(root, "repo-\u202ename");
	const literal = join(root, "repo-\\u202ename");
	await mkdir(bidi);
	await mkdir(literal);
	const h = addDirHarness(t, { agentDir });
	h.state.cwd = await temporary(t);
	h.state.branch = () => h.state.branchEntries;
	await h.emit("session_start");
	await h.command("dir-add", bidi);
	await h.command("dir-add", literal);
	let offered: string[] = [];
	h.state.select = async (_title, choices) => {
		offered = choices;
		return choices[1];
	};
	await h.command("dir-ls", "");
	assert.equal(offered.length, 2, "both directories are offered");
	assert.notEqual(offered[0], offered[1], "escaped text alone cannot tell the rows apart");
	const dirs = (h.state.branchEntries.at(-1) as { data: { dirs: Array<{ absolutePath: string }> } }).data.dirs;
	assert.deepEqual(dirs.map((dir) => dir.absolutePath), [bidi], "the selected row is the one that was removed");
});

test("removes the selected project row when a path collides with an escaped row's ordinal", async (t) => {
	const agentDir = await temporary(t);
	const root = await temporary(t);
	const bidi = join(root, "p\u202e", "x");
	const literal = join(root, "p\\u202e", "x");
	const third = join(root, "third", "x");
	const ordinalPath = join(root, "p\\u202e", "x [1]");
	for (const directory of [bidi, literal, third]) await mkdir(directory, { recursive: true });
	await symlink(third, ordinalPath, "dir");
	const git = gitConfigExec();
	git.values.push(bidi, literal, ordinalPath);
	const h = addDirHarness(t, { agentDir, exec: git.exec });
	h.state.cwd = await temporary(t);
	await h.emit("session_start");
	let offered: string[] = [];
	h.state.select = async (_title, choices) => {
		offered = choices;
		return choices[2];
	};
	await h.command("dir-ls", "");
	assert.deepEqual(git.values, [bidi, literal], "only the selected symlink spelling is removed from project config");
	assert.equal(offered.length, 3);
	assert.equal(new Set(offered).size, 3, "all final choice identities are unique");
});

test("reconciles the /reload hint against the host's loaded skill inventory", async (t) => {
	const agentDir = await temporary(t);
	const skilled = await externalDirectory(t, "demo");
	const plain = await externalDirectory(t);
	const skillPath = join(skilled, ".pi/skills/demo/SKILL.md");
	const h = addDirHarness(t, { agentDir });
	h.state.branch = () => h.state.branchEntries;
	await h.emit("session_start");
	await h.command("dir-add", skilled);
	assert.match(h.notices.at(-1)?.message ?? "", /Run \/reload to update external skills\./);
	await h.command("dir-add", plain);
	assert.match(h.notices.at(-1)?.message ?? "", /Run \/reload/, "an unrelated addition keeps the pending hint");

	// Pi's /reload replaces the binding: discovery hands over the path and the host loads it.
	await h.emit("session_shutdown");
	h.state.slashCommands = [{
		name: "skill:demo",
		source: "skill",
		sourceInfo: { path: skillPath, source: "skill", scope: "user", origin: "top-level" },
	} as never];
	await h.emit("session_start");
	assert.deepEqual(await h.emit("resources_discover"), { skillPaths: [skillPath] });
	await h.command("dir-add", await externalDirectory(t));
	assert.ok(!/\/reload/.test(h.notices.at(-1)?.message ?? ""), "a settled set needs no reload hint");

	// Removing a loaded skill is a host-visible change again.
	h.state.select = async (_title, choices) => choices.find((choice) => choice.includes(skilled));
	await h.command("dir-ls", "");
	assert.match(h.notices.at(-1)?.message ?? "", /Run \/reload to update external skills\./);
});

test("tree navigation reflects branch state and warns only on a new pending change", async (t) => {
	const agentDir = await temporary(t);
	const directory = await externalDirectory(t, "demo");
	const skillPath = join(directory, ".pi/skills/demo/SKILL.md");
	const h = addDirHarness(t, { agentDir });
	h.state.branch = () => [stateEntry({ absolutePath: directory, label: "demo" })];
	await h.emit("session_start");
	await h.emit("resources_discover");
	h.state.slashCommands = [{
		name: "skill:demo",
		source: "skill",
		sourceInfo: { path: skillPath, source: "skill", scope: "user", origin: "top-level" },
	} as never];
	await h.emit("session_tree");
	assert.equal(h.notices.length, 0, "a loaded set warns about nothing");

	// Branch B has no directories while the host still holds the loaded skill.
	h.state.branch = () => [];
	await h.emit("session_tree");
	assert.equal(h.notices.at(-1)?.level, "warning");
	assert.match(h.notices.at(-1)?.message ?? "", /Run \/reload/);
	const warned = h.notices.length;
	await h.emit("session_tree");
	assert.equal(h.notices.length, warned, "repeated navigation does not repeat the warning");

	// Back to branch A: the loaded set matches again and no warning is due.
	h.state.branch = () => [stateEntry({ absolutePath: directory, label: "demo" })];
	await h.emit("session_tree");
	assert.equal(h.notices.length, warned, "returning to the loaded branch needs no reload");
	assert.ok(!h.renderWidget(300).join(" ").includes("/reload pending"), "the pending marker is cleared");

	// Leaving again is a new pending transition, not a repeat of the first one.
	h.state.branch = () => [];
	await h.emit("session_tree");
	assert.equal(h.notices.length, warned + 1, "a new pending transition warns exactly once");
});

test("a failed session append adopts the branch Pi actually advanced", async (t) => {
	const agentDir = await temporary(t);
	const directory = await externalDirectory(t);
	const label = directory.split("/").at(-1) ?? "";
	const h = addDirHarness(t, { agentDir });
	h.state.branch = () => h.state.branchEntries;
	await h.emit("session_start");
	h.state.appendError = new Error("disk full");
	await h.command("dir-add", directory);
	assert.equal(h.notices.at(-1)?.level, "error");
	assert.match(h.notices.at(-1)?.message ?? "", /Cannot save session directories: disk full/);
	assert.deepEqual(h.renderWidget(), [], "an append that never reached the branch publishes nothing");

	// Pi's SessionManager attaches the entry in memory before persisting it, so a failed
	// append may still be the branch truth; the module must not contradict the session.
	h.state.appendCommits = true;
	await h.command("dir-add", directory);
	assert.equal(h.notices.at(-1)?.level, "error", "the append still reports the persistence failure");
	assert.ok(h.renderWidget().join(" ").includes(label), "the state Pi recorded is the state shown");
});

test("rejects control characters in every scope and drops restored ones independently", async (t) => {
	const agentDir = await temporary(t);
	const root = await temporary(t);
	const weird = join(root, "evil\tdir");
	const clean = join(root, "clean");
	await mkdir(weird, { recursive: true });
	await mkdir(clean, { recursive: true });
	for (const scope of ["", "--global", "--project"]) {
		const h = addDirHarness(t, { agentDir });
		await h.emit("session_start");
		await h.command("dir-add", `${scope} ${weird}`.trim());
		assert.equal(h.notices.at(-1)?.level, "error", scope || "session scope");
		assert.match(h.notices.at(-1)?.message ?? "", /control characters/);
		assert.deepEqual(h.appendedEntries, []);
	}
	const h = addDirHarness(t, { agentDir });
	h.state.branch = () => [stateEntry({ absolutePath: weird, label: "clean-label" })];
	await h.emit("session_start");
	assert.deepEqual(h.renderWidget(), [], "a restored unsafe path is never rendered");
	h.state.branch = () => [stateEntry({ absolutePath: clean, label: "dirty\tlabel" })];
	await h.emit("session_tree");
	assert.deepEqual(h.renderWidget(), [], "a restored unsafe label is never rendered");
});

test("supports shaped and private-use names while still refusing terminal controls", async (t) => {
	const agentDir = await temporary(t);
	const root = await temporary(t);
	const joined = join(root, "repo-\u{1f469}\u200d\u{1f4bb}");
	const privateUse = join(root, "glyph-\ue000");
	const separator = join(root, "line\u2028break");
	await mkdir(joined, { recursive: true });
	await mkdir(privateUse, { recursive: true });
	await mkdir(separator, { recursive: true });
	const h = addDirHarness(t, { agentDir });
	h.state.cwd = await temporary(t);
	await h.emit("session_start");
	for (const path of [joined, privateUse]) {
		await h.command("dir-add", path);
		assert.equal(h.notices.at(-1)?.level, "info", path);
		assert.match(h.notices.at(-1)?.message ?? "", /Added/);
	}
	const widget = h.renderWidget(300).join(" ");
	assert.ok(widget.includes("repo-\u{1f469}\u200d\u{1f4bb}"), "a joined-emoji name survives unescaped");
	assert.ok(widget.includes("glyph-\ue000"), "a private-use glyph survives unescaped");
	assert.ok(!widget.includes("\\u"), "no supported name is escaped into text");
	// The line-separator category is refused like a control character.
	await h.command("dir-add", separator);
	assert.equal(h.notices.at(-1)?.level, "error");
	assert.match(h.notices.at(-1)?.message ?? "", /control characters/);
});

for (const operation of ["addition", "promotion"] as const) {
	test(`an unreadable stored project path does not block a healthy ${operation}`, async (t) => {
		const agentDir = await temporary(t);
		const root = await temporary(t);
		const broken = join(root, "broken");
		const healthy = join(root, "healthy");
		await symlink("broken", broken, "dir");
		await mkdir(healthy);
		await writeFile(join(healthy, "AGENTS.md"), "healthy-only rules");
		const git = gitConfigExec();
		git.values.push(broken);
		const h = addDirHarness(t, { agentDir, exec: git.exec });
		h.state.cwd = await temporary(t);
		h.state.branch = () => h.state.branchEntries;
		await h.emit("session_start");
		assert.ok(h.notices.some((notice) => notice.level === "warning" && notice.message.includes(broken)));
		if (operation === "promotion") await h.command("dir-add", healthy);
		await h.command("dir-add", `--project ${healthy}`);
		assert.deepEqual(git.values, [broken, healthy], "the inactive value is preserved and the healthy value is committed");
		assert.equal(git.writes, 1);
		assert.equal(h.appendedEntries.length, operation === "promotion" ? 2 : 0);
		if (operation === "promotion") {
			const entry = h.state.branchEntries.at(-1) as { data: { dirs: unknown[] } };
			assert.deepEqual(entry.data.dirs, [], "promotion removes the healthy session copy");
		}
		assert.match(h.notices.at(-1)?.message ?? "", /^Added healthy .*project scope/);
		const widget = h.renderWidget(300).join(" ");
		assert.ok(widget.includes("healthy") && !widget.includes("broken"), "only the healthy project directory is active");
		const sections: Record<string, string> = {};
		await h.emit("before_agent_start", h.ctx, { systemPromptOptions: { sections } });
		assert.ok(sections.pi_add_dir?.includes("healthy-only rules"));
		assert.ok(!sections.pi_add_dir?.includes(broken));
	});
}

test("an unreadable stored project path does not hide a newly discovered canonical alias", async (t) => {
	const agentDir = await temporary(t);
	const root = await temporary(t);
	const broken = join(root, "broken");
	const healthy = join(root, "healthy");
	const alias = join(root, "alias");
	await symlink("broken", broken, "dir");
	await mkdir(healthy);
	await symlink(healthy, alias, "dir");
	const git = gitConfigExec({
		onProbe: (count) => {
			if (count === 2) git.values.push(alias);
		},
	});
	git.values.push(broken);
	const h = addDirHarness(t, { agentDir, exec: git.exec });
	h.state.cwd = await temporary(t);
	await h.emit("session_start");
	await h.command("dir-add", `--project ${healthy}`);
	assert.deepEqual(git.values, [broken, alias], "the existing alias is retained without appending a canonical duplicate");
	assert.equal(git.writes, 0);
	assert.equal(h.appendedEntries.length, 0);
	assert.match(h.notices.at(-1)?.message ?? "", /^Added healthy .*project scope/);
	assert.ok(h.renderWidget(300).join(" ").includes("healthy"));
});

test("a newly requested looping root is still rejected before any project write", async (t) => {
	const agentDir = await temporary(t);
	const root = await temporary(t);
	const broken = join(root, "broken");
	await symlink("broken", broken, "dir");
	const git = gitConfigExec();
	const h = addDirHarness(t, { agentDir, exec: git.exec });
	h.state.cwd = await temporary(t);
	await h.emit("session_start");
	await h.command("dir-add", `--project ${broken}`);
	assert.equal(git.writes, 0);
	assert.deepEqual(git.values, []);
	assert.equal(h.appendedEntries.length, 0);
	assert.equal(h.notices.at(-1)?.level, "error");
	assert.match(h.notices.at(-1)?.message ?? "", /Cannot access directory:.*ELOOP/);
});

test("session removal keeps the selected stored identity when its directory is retargeted", async (t) => {
	const agentDir = await temporary(t);
	const root = await temporary(t);
	const selected = join(root, "selected");
	const other = join(root, "other");
	await mkdir(selected);
	await mkdir(other);
	const h = addDirHarness(t, { agentDir });
	h.state.cwd = await temporary(t);
	h.state.branch = () => h.state.branchEntries;
	await h.emit("session_start");
	await h.command("dir-add", selected);
	h.state.select = async (_title, choices) => {
		await rm(selected, { recursive: true });
		await symlink(other, selected, "dir");
		return choices[0];
	};
	await h.command("dir-ls", "");
	const entry = h.state.branchEntries.at(-1) as { data: { dirs: unknown[] } };
	assert.deepEqual(entry.data.dirs, [], "the stored entry the user selected is actually removed");
	assert.equal(h.appendedEntries.length, 2);
	assert.equal(h.widgets.get("add-dir"), undefined, "the retargeted location is not activated after reporting removal");
	assert.match(h.notices.at(-1)?.message ?? "", /^Removed selected/);
});

test("a looping session root remains independently manageable after restoring healthy resources", async (t) => {
	const { h, broken, healthy, skillPath } = await loopingSession(t);
	await assert.doesNotReject(h.emit("session_start"), "one changed directory must not abort the valid session's restore");
	assert.ok(h.notices.some((notice) => notice.level === "warning" && notice.message.includes(broken)));
	const widget = h.renderWidget(300).join(" ");
	assert.ok(widget.includes("healthy") && !widget.includes("broken"));
	assert.deepEqual(await h.emit("resources_discover"), { skillPaths: [skillPath] });
	const sections: Record<string, string> = {};
	await h.emit("before_agent_start", h.ctx, { systemPromptOptions: { sections } });
	assert.ok(sections.pi_add_dir?.includes("healthy-only rules"));
	assert.ok(!sections.pi_add_dir?.includes(broken));
	let offered: string[] = [];
	h.state.select = async (_title, choices) => {
		offered = choices;
		return choices.find((choice) => choice.includes(broken));
	};
	await h.command("dir-ls", "");
	assert.equal(offered.length, 2, "the bad entry is retained as a manageable row");
	assert.ok(offered.some((choice) => choice.includes(broken) && /ELOOP/.test(choice)));
	const entry = h.state.branchEntries.at(-1) as { data: { dirs: Array<{ absolutePath: string }> } };
	assert.deepEqual(entry.data.dirs.map((dir) => dir.absolutePath), [healthy]);
	assert.equal(h.appendedEntries.length, 3);
	assert.match(h.notices.at(-1)?.message ?? "", /^Removed broken/);
});

test("a looping session root does not block promotion of the healthy directory", async (t) => {
	const { h, git, broken, healthy } = await loopingSession(t);
	await assert.doesNotReject(h.emit("session_start"));
	await h.command("dir-add", `--project ${healthy}`);
	assert.deepEqual(git.values, [healthy]);
	const entry = h.state.branchEntries.at(-1) as { data: { dirs: Array<{ absolutePath: string }> } };
	assert.deepEqual(entry.data.dirs.map((dir) => dir.absolutePath), [broken], "only the healthy session copy is promoted");
	assert.equal(h.appendedEntries.length, 3);
	assert.match(h.notices.at(-1)?.message ?? "", /^Added healthy .*project scope/);
	assert.ok(h.renderWidget(300).join(" ").includes("healthy"));
});

test("a failed promotion leaves the session copy and never appends a rollback", async (t) => {
	const agentDir = await temporary(t);
	const directory = await externalDirectory(t);
	const label = directory.split("/").at(-1) ?? "";
	const exec = async (_command: string, args: string[]): Promise<{ code: number; killed: boolean; stdout: string; stderr: string }> => {
		if (args[0] === "rev-parse") return { code: 0, killed: false, stdout: "true\n", stderr: "" };
		if (args.includes("--get-all")) return { code: 1, killed: false, stdout: "", stderr: "" };
		return { code: 1, killed: false, stdout: "", stderr: "fatal: bad config" };
	};
	const h = addDirHarness(t, { agentDir, exec });
	h.state.cwd = await temporary(t);
	await h.emit("session_start");
	await h.command("dir-add", directory);
	assert.equal(h.appendedEntries.length, 1);
	await h.command("dir-add", `--project ${directory}`);
	assert.equal(h.appendedEntries.length, 1, "a failed promotion writes no compensating session state");
	assert.equal(h.notices.at(-1)?.level, "error");
	assert.match(h.notices.at(-1)?.message ?? "", /Cannot save project directory/);
	assert.ok(h.renderWidget().join(" ").includes(label), "the session copy stays active");
});

test("a committed project write survives a failed reconciliation read", async (t) => {
	const agentDir = await temporary(t);
	const directory = await externalDirectory(t);
	const label = directory.split("/").at(-1) ?? "";
	// The third probe is the reconciliation read that follows the committed mutation.
	const git = gitConfigExec({ failProbe: (count) => count >= 3 });
	const h = addDirHarness(t, { agentDir, exec: git.exec });
	h.state.cwd = await temporary(t);
	await h.emit("session_start");
	await h.command("dir-add", `--project ${directory}`);
	assert.deepEqual(git.values, [directory], "the committed value is never compensated away");
	assert.equal(h.appendedEntries.length, 0);
	const notices = h.notices.map((notice) => `${notice.level}:${notice.message}`);
	assert.ok(notices.some((notice) => notice.startsWith("info:Added ")), notices.join(" | "));
	assert.ok(
		notices.some((notice) => notice.startsWith("warning:") && notice.includes("re-reading the project configuration failed")),
		notices.join(" | "),
	);
	assert.ok(h.renderWidget(300).join(" ").includes(label), "the committed directory is active");
});

test("a selector that returns a stale choice never removes a different directory", async (t) => {
	const agentDir = await temporary(t);
	const globalDir = await externalDirectory(t);
	const sessionDir = await externalDirectory(t);
	const h = addDirHarness(t, { agentDir });
	await h.emit("session_start");
	await h.command("dir-add", `--global ${globalDir}`);
	// The selector is still open when a session directory takes the first list slot.
	h.state.select = async (_title, choices) => {
		const choice = choices[0];
		await h.command("dir-add", sessionDir);
		return choice;
	};
	await h.command("dir-ls", "");
	assert.deepEqual(
		JSON.parse(await readFile(join(agentDir, "config/pi-add-dir/config.json"), "utf8")),
		{ directories: [] },
		"the stale choice removes the directory it named, not whatever now holds that index",
	);
	assert.match(h.notices.at(-1)?.message ?? "", /Removed/);
	assert.ok(
		h.renderWidget().join(" ").includes(sessionDir.split("/").at(-1) ?? ""),
		"the concurrently added directory survives",
	);
});

test("startup, discovery, prompt and session-scope commands schedule no timers", async (t) => {
	const agentDir = await temporary(t);
	const directory = await externalDirectory(t);
	const h = addDirHarness(t, { agentDir });
	const scheduled: string[] = [];
	const originals = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval };
	// Attribute by our own source path so the runner's bookkeeping timers are never counted.
	const record = (name: "setTimeout" | "setInterval") =>
		((...args: unknown[]) => {
			const stack = new Error().stack ?? "";
			if (stack.includes("modules/add-dir/src/")) scheduled.push(`${name}\n${stack}`);
			return (originals[name] as (...inner: unknown[]) => unknown)(...args);
		}) as typeof globalThis.setTimeout;
	globalThis.setTimeout = record("setTimeout");
	globalThis.setInterval = record("setInterval");
	try {
		await h.emit("session_start");
		await h.emit("resources_discover");
		await h.emit("before_agent_start", h.ctx, { systemPromptOptions: { sections: {} } });
		await h.command("dir-add", directory);
		await h.command("dir-ls", "");
	} finally {
		globalThis.setTimeout = originals.setTimeout;
		globalThis.setInterval = originals.setInterval;
	}
	assert.deepEqual(scheduled, [], "no watcher or background timer is created outside a lock wait");
});

test("rejects duplicates, missing paths and nested directories at the command boundary", async (t) => {
	const agentDir = await temporary(t);
	const root = await temporary(t);
	const cwd = join(root, "work");
	const inside = join(root, "inside");
	const nested = join(inside, "nested");
	await mkdir(cwd);
	await mkdir(nested, { recursive: true });
	const h = addDirHarness(t, { agentDir });
	h.state.cwd = cwd;
	await h.emit("session_start");
	await h.command("dir-add", inside);
	assert.equal(h.appendedEntries.length, 1);
	await h.command("dir-add", inside);
	assert.equal(h.notices.at(-1)?.level, "error");
	assert.match(h.notices.at(-1)?.message ?? "", /Already added in session scope/);
	assert.equal(h.appendedEntries.length, 1, "a rejected duplicate appends nothing");
	await h.command("dir-add", root);
	assert.equal(h.notices.at(-1)?.level, "error");
	assert.match(h.notices.at(-1)?.message ?? "", /overlaps current working directory scope/);
	assert.equal(h.appendedEntries.length, 1);
	// An existing descendant proves the overlap rule independently of the existence rule.
	await h.command("dir-add", nested);
	assert.equal(h.notices.at(-1)?.level, "error");
	assert.match(h.notices.at(-1)?.message ?? "", /overlaps already-added directory/);
	assert.equal(h.appendedEntries.length, 1);
	// A missing sibling proves the existence rule independently of the overlap rule.
	await h.command("dir-add", join(root, "missing"));
	assert.equal(h.notices.at(-1)?.level, "error");
	assert.match(h.notices.at(-1)?.message ?? "", /Directory does not exist/);
	assert.equal(h.appendedEntries.length, 1);
});

test("malformed global configuration fails startup without rewriting the file", async (t) => {
	const agentDir = await temporary(t);
	await mkdir(join(agentDir, "config/pi-add-dir"), { recursive: true });
	const path = join(agentDir, "config/pi-add-dir/config.json");
	await writeFile(path, '{"directories":["relative"]}\n');
	const h = addDirHarness(t, { agentDir });
	await assert.rejects(h.emit("session_start"), /Cannot load pi-add-dir global config/);
	assert.equal(await readFile(path, "utf8"), '{"directories":["relative"]}\n');
});

test("writes only its own prompt section and clears it when empty", async (t) => {
	const agentDir = await temporary(t);
	const directory = await externalDirectory(t);
	await writeFile(join(directory, "AGENTS.md"), "external rules\n");
	const h = addDirHarness(t, { agentDir });
	await h.emit("session_start");
	const sections: Record<string, string> = { preamble: "host preamble" };
	await h.emit("before_agent_start", h.ctx, { systemPromptOptions: { sections } });
	assert.deepEqual(Object.keys(sections), ["preamble"], "no section without directories");
	await h.command("dir-add", directory);
	await h.emit("before_agent_start", h.ctx, { systemPromptOptions: { sections } });
	assert.deepEqual(Object.keys(sections).sort(), ["pi_add_dir", "preamble"]);
	assert.match(sections.pi_add_dir ?? "", /external rules/);
	assert.equal(sections.preamble, "host preamble");
	h.state.select = async (_title, choices) => choices[0];
	await h.command("dir-ls", "");
	await h.emit("before_agent_start", h.ctx, { systemPromptOptions: { sections } });
	assert.deepEqual(Object.keys(sections), ["preamble"]);
});
