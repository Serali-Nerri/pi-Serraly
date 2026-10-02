import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
let lockfile;
try {
	lockfile = require("proper-lockfile");
} catch {
	lockfile = createRequire(require.resolve("@earendil-works/pi-coding-agent"))("proper-lockfile");
}
const names = ["claude-style-tools", "pi-session-ui", "pi-ask-user-question", "pi-loop", "pi-apply-patch", "pi-background-shell", "pi-docparser"];
const entries = ["pi-ui", "pi-ask-user-question", "pi-loop", "pi-apply-patch", "pi-background-shell", "pi-docparser"].map((name) => `./dist/${name}/index.js`);
const script = fileURLToPath(new URL("../../scripts/migrate.mjs", import.meta.url));

async function api() {
	const mod = await import("../../scripts/lib/migration.mjs").catch(() => null);
	assert.equal(typeof mod?.migrate, "function", "controlled migration API is missing");
	assert.equal(typeof mod?.rollback, "function", "conditional rollback API is missing");
	return mod;
}

// Independent fixture fingerprint: sorted relative entries, kind, mode, bytes hash.
function fingerprint(directory) {
	const records = [];
	function walk(relative) {
		const full = path.join(directory, relative);
		const stat = fs.lstatSync(full);
		const kind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file";
		records.push([relative || ".", kind, stat.mode & 0o7777, kind === "file" ? createHash("sha256").update(fs.readFileSync(full)).digest("hex") : kind === "symlink" ? fs.readlinkSync(full) : null]);
		if (kind === "directory") for (const name of fs.readdirSync(full).sort()) walk(relative ? `${relative}/${name}` : name);
	}
	walk("");
	return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

function setup(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "serraly-migration-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const agentDir = path.join(root, "agent");
	const release = path.join(root, "release");
	const backupDir = path.join(root, "backups", "first");
	const home = path.join(root, "home");
	const cwd = path.join(root, "cwd");
	for (const directory of [agentDir, release, home, cwd, path.dirname(backupDir), path.join(agentDir, "extensions")]) fs.mkdirSync(directory, { recursive: true });
	for (const name of names) {
		const directory = path.join(agentDir, "extensions", name);
		fs.mkdirSync(directory);
		fs.writeFileSync(path.join(directory, "index.js"), `export default function ${name.replaceAll("-", "_")}() {}\n`);
		fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
	}
	for (const entry of entries) {
		fs.mkdirSync(path.dirname(path.join(release, entry)), { recursive: true });
		fs.writeFileSync(path.join(release, entry), "export default function () {}\n");
	}
	fs.writeFileSync(path.join(release, "package.json"), JSON.stringify({ name: "pi-serraly", private: true, type: "module", pi: { extensions: entries }, dependencies: {}, peerDependencies: { "@earendil-works/pi-coding-agent": "*" } }));
	fs.writeFileSync(path.join(release, "package-lock.json"), "{\"lockfileVersion\":3}\n");
	const oldBg = `-${path.join(agentDir, "extensions/pi-background-shell/index.js")}`;
	const oldUi = "+extensions/claude-style-tools/index.js";
	const oldPackage = { source: path.join(agentDir, "extensions/pi-docparser"), extensions: ["+index.js"] };
	const initial = {
		packages: ["npm:unrelated", oldPackage],
		extensions: ["-builtin:mcp", oldUi, "orca-agent-status.ts", oldBg],
		skills: ["some-skill"], prompts: [], themes: ["custom"], defaultTools: ["+tool_search"],
		defaultModel: "synthetic-only", theme: "dark", mystery: { array: ["leave", "alone"] },
	};
	const settingsPath = path.join(agentDir, "settings.json");
	fs.writeFileSync(settingsPath, `${JSON.stringify(initial, null, 2)}\n`);
	const approval = {
		version: 1,
		directories: names.map((name) => ({ name, sha256: fingerprint(path.join(agentDir, "extensions", name)), packageName: name, source: { repository: `synthetic:${name}`, revision: "fixture", worktree: "approved full fixture" } })),
		removals: [{ array: "extensions", value: oldUi }, { array: "extensions", value: oldBg }, { array: "packages", value: oldPackage }],
	};
	const approvalPath = path.join(root, "approval.json");
	fs.writeFileSync(approvalPath, JSON.stringify(approval));
	fs.writeFileSync(path.join(agentDir, "extensions/orca-agent-status.ts"), "orca untouched\n");
	fs.mkdirSync(path.join(agentDir, "sessions"));
	fs.writeFileSync(path.join(agentDir, "sessions/synthetic.jsonl"), "synthetic session\n");
	fs.writeFileSync(path.join(agentDir, "claude-style-tools.json"), "{\"unknown\":true}\n");
	fs.mkdirSync(path.join(cwd, ".pi/tasks"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".pi/tasks/synthetic.log"), "task state\n");
	const options = { agentDir, release, backupDir, approvalPath, allInstancesStopped: true };
	// The parent's closure/license validator is separately tested. Migration's own
	// manifest/entries/physical-host checks still run on these real synthetic files.
	const dependencies = { validateRelease: async () => {} };
	return { root, home, cwd, settingsPath, initial, approval, approvalPath, options, dependencies,
		read: () => JSON.parse(fs.readFileSync(settingsPath, "utf8")),
		write: (value) => fs.writeFileSync(settingsPath, JSON.stringify(value)),
		approve: () => fs.writeFileSync(approvalPath, JSON.stringify(approval)),
		journal: path.join(backupDir, "journal.json") };
}

function assertOriginalDirectories(f) {
	for (const name of names) assert.ok(fs.existsSync(path.join(f.options.agentDir, "extensions", name)), name);
}
function rollbackOptions(f) {
	return { ...f.options, journalPath: f.journal };
}

// Break caught: omitting the stop acknowledgement permits unsafe live mutation.
test("requires explicit paths and shutdown acknowledgment, including dry-run", async (t) => {
	const { migrate } = await api();
	const f = setup(t);
	for (const key of ["agentDir", "release", "backupDir", "allInstancesStopped"]) {
		const options = { ...f.options, dryRun: true };
		delete options[key];
		await assert.rejects(migrate(options, f.dependencies));
	}
	assert.deepEqual(f.read(), f.initial);
	assertOriginalDirectories(f);
	assert.equal(fs.existsSync(f.options.backupDir), false);
});

test("dry-run validates without creating journal, backups, or a settings lock", async (t) => {
	const { migrate } = await api();
	const f = setup(t);
	const result = await migrate({ ...f.options, dryRun: true }, f.dependencies);
	assert.equal(result.state, "dry-run");
	assert.equal(result.directories.length, 7);
	assert.deepEqual(f.read(), f.initial);
	assertOriginalDirectories(f);
	assert.equal(fs.existsSync(f.options.backupDir), false);
	assert.equal(fs.existsSync(`${f.settingsPath}.lock`), false);
});

test("first switch archives only seven approved identities and preserves all unrelated state", async (t) => {
	const { migrate } = await api();
	const f = setup(t);
	const result = await migrate(f.options, f.dependencies);
	assert.equal(result.state, "migrated");
	const after = f.read();
	assert.deepEqual(after, { ...f.initial, packages: ["npm:unrelated", f.options.release], extensions: ["-builtin:mcp", "orca-agent-status.ts"] });
	for (const name of names) {
		assert.equal(fs.existsSync(path.join(f.options.agentDir, "extensions", name)), false);
		assert.equal(fingerprint(path.join(f.options.backupDir, "directories", name)), f.approval.directories.find((item) => item.name === name).sha256);
	}
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.options.backupDir, "settings.before.json"))), f.initial);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.options.backupDir, "approved-evidence.json"))), f.approval);
	assert.equal(fs.readFileSync(path.join(f.options.agentDir, "extensions/orca-agent-status.ts"), "utf8"), "orca untouched\n");
	assert.equal(fs.readFileSync(path.join(f.cwd, ".pi/tasks/synthetic.log"), "utf8"), "task state\n");
	assert.equal(fs.readFileSync(path.join(f.options.agentDir, "sessions/synthetic.jsonl"), "utf8"), "synthetic session\n");
	assert.equal(fs.readFileSync(path.join(f.options.agentDir, "claude-style-tools.json"), "utf8"), "{\"unknown\":true}\n");
	assert.equal(fs.existsSync(`${f.settingsPath}.lock`), false);
});

test("repeating a completed migration is idempotent, not a second package append", async (t) => {
	const { migrate } = await api();
	const f = setup(t);
	await migrate(f.options, f.dependencies);
	const settings = fs.readFileSync(f.settingsPath, "utf8");
	await migrate(f.options, f.dependencies);
	assert.equal(fs.readFileSync(f.settingsPath, "utf8"), settings);
	assert.equal(f.read().packages.filter((entry) => entry === f.options.release).length, 1);
});

test("wrong full-tree identity refuses mutation even if package name matches", async (t) => {
	const { migrate } = await api();
	const f = setup(t);
	fs.writeFileSync(path.join(f.options.agentDir, "extensions/pi-loop/unknown.txt"), "unapproved");
	await assert.rejects(migrate(f.options, f.dependencies), /identity|fingerprint/i);
	assertOriginalDirectories(f);
	assert.equal(fs.existsSync(f.options.backupDir), false);
});

test("missing approvals, wrong manifest name, and unknown directory approvals are refused", async (t) => {
	const { migrate } = await api();
	for (const mutation of [
		(f) => f.approval.directories.pop(),
		(f) => { f.approval.directories[0].packageName = "other"; },
		(f) => { f.approval.directories[0].name = "orca-agent-status"; },
	]) {
		const f = setup(t);
		mutation(f);
		f.approve();
		await assert.rejects(migrate(f.options, f.dependencies));
		assertOriginalDirectories(f);
		assert.equal(fs.existsSync(f.options.backupDir), false);
	}
});

test("external symlink roots or descendants are never traversed or archived", async (t) => {
	const { migrate } = await api();
	for (const nested of [false, true]) {
		const f = setup(t);
		const directory = path.join(f.options.agentDir, "extensions/pi-loop");
		const outside = path.join(f.root, "unrelated");
		fs.mkdirSync(outside);
		fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
		if (nested) fs.symlinkSync(outside, path.join(directory, "unexpected"));
		else {
			fs.rmSync(directory, { recursive: true });
			fs.symlinkSync(outside, directory);
		}
		await assert.rejects(migrate(f.options, f.dependencies), /symlink/i);
		assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "keep");
		assert.equal(fs.existsSync(f.options.backupDir), false);
	}
});

test("release preflight refuses missing entries, development manifests, or physical nested host copies", async (t) => {
	const { migrate } = await api();
	for (const mutation of [
		(f) => fs.rmSync(path.join(f.options.release, entries[0])),
		(f) => { const p = path.join(f.options.release, "package.json"); const m = JSON.parse(fs.readFileSync(p)); m.devDependencies = { typescript: "*" }; fs.writeFileSync(p, JSON.stringify(m)); },
		(f) => fs.mkdirSync(path.join(f.options.release, "node_modules/nested/node_modules/@earendil-works/pi-tui"), { recursive: true }),
	]) {
		const f = setup(t);
		mutation(f);
		await assert.rejects(migrate(f.options, f.dependencies));
		assertOriginalDirectories(f);
		assert.equal(fs.existsSync(f.options.backupDir), false);
	}
});

test("backup and runtime release cannot be inside automatic discovery", async (t) => {
	const { migrate } = await api();
	const f = setup(t);
	await assert.rejects(migrate({ ...f.options, backupDir: path.join(f.options.agentDir, "extensions/backup") }, f.dependencies));
	await assert.rejects(migrate({ ...f.options, release: path.join(f.options.agentDir, "extensions/runtime") }, f.dependencies));
	assertOriginalDirectories(f);
});

test("only approved exact related overrides may be removed", async (t) => {
	const { migrate } = await api();
	for (const mutation of [
		(f) => f.approval.removals.push({ array: "extensions", value: "orca-agent-status.ts" }),
		(f) => { f.approval.removals[0].value = "!extensions/claude-style-tools/**"; },
		(f) => { const s = f.read(); s.extensions.push("+extensions/pi-loop/index.js"); f.write(s); },
		(f) => { const s = f.read(); s.extensions.push(s.extensions[1]); f.write(s); },
	]) {
		const f = setup(t);
		mutation(f); f.approve();
		await assert.rejects(migrate(f.options, f.dependencies));
		assertOriginalDirectories(f);
		assert.equal(fs.existsSync(f.options.backupDir), false);
	}
});

// Break caught: resolving raw strings lets Pi-equivalent local aliases escape preflight.
for (const [spelling, alias] of [
	["file URL", (directory) => pathToFileURL(directory).href],
	["whitespace", (directory) => ` \t${directory}\n `],
]) {
	test(`migration refuses a preexisting filtered ${spelling} release alias before mutation`, async (t) => {
		const { migrate } = await api();
		const f = setup(t);
		const encodedRelease = path.join(f.root, "runtime release # ü");
		fs.renameSync(f.options.release, encodedRelease); f.options.release = encodedRelease;
		const current = f.read();
		current.packages.push({ source: alias(f.options.release), extensions: [] }); f.write(current);
		await assert.rejects(migrate(f.options, f.dependencies), /reference|already/i);
		assert.deepEqual(f.read(), current); assertOriginalDirectories(f);
		assert.equal(fs.existsSync(f.options.backupDir), false);
	});

	test(`rollback refuses an added ${spelling} release alias before restoring any directory`, async (t) => {
		const { migrate, rollback } = await api();
		const f = setup(t);
		const encodedRelease = path.join(f.root, "runtime release # ü");
		fs.renameSync(f.options.release, encodedRelease); f.options.release = encodedRelease;
		await migrate(f.options, f.dependencies);
		const current = f.read();
		current.packages.push({ source: alias(f.options.release), extensions: [entries[0]] }); f.write(current);
		const beforeJournal = fs.readFileSync(f.journal, "utf8");
		await assert.rejects(rollback(rollbackOptions(f)), /conflict/i);
		assert.deepEqual(f.read(), current);
		assert.equal(fs.readFileSync(f.journal, "utf8"), beforeJournal);
		for (const name of names) assert.equal(fs.existsSync(path.join(f.options.agentDir, "extensions", name)), false);
	});

	test(`approved ${spelling} old package override round-trips its exact original value`, async (t) => {
		const { migrate, rollback } = await api();
		const f = setup(t);
		const original = f.read();
		original.packages[1].source = alias(path.join(f.options.agentDir, "extensions/pi-docparser"));
		f.write(original); f.approval.removals[2].value = original.packages[1]; f.approve();
		await migrate(f.options, f.dependencies);
		assert.deepEqual(f.read().packages, ["npm:unrelated", f.options.release]);
		const journal = JSON.parse(fs.readFileSync(f.journal));
		assert.deepEqual(journal.settings.delta.deletions.find((entry) => entry.array === "packages").value, original.packages[1]);
		await rollback(rollbackOptions(f)); assert.deepEqual(f.read(), original);
	});

	test(`migration refuses an unapproved ${spelling} old package alias before mutation`, async (t) => {
		const { migrate } = await api();
		const f = setup(t);
		const current = f.read();
		current.packages.push({ source: alias(path.join(f.options.agentDir, "extensions/pi-loop")), extensions: [] }); f.write(current);
		await assert.rejects(migrate(f.options, f.dependencies), /unapproved|related/i);
		assert.deepEqual(f.read(), current); assertOriginalDirectories(f);
		assert.equal(fs.existsSync(f.options.backupDir), false);
	});
}

// Break caught: ignoring unresolved HOME package sources can enable the new UI
// alongside restored old directories. Exercise the API in a dedicated HOME/cwd;
// do not expand HOME or read any actual agent files to decide identity.
function syntheticOperation(f, operation, options) {
	const source = `
		const api = await import(process.argv[1]);
		try {
			const result = await api[process.argv[2]](JSON.parse(process.argv[3]), { validateRelease: async () => {} });
			console.log(JSON.stringify(result));
		} catch (error) { console.error(error.message); process.exitCode = 1; }
	`;
	return spawnSync(process.execPath, ["--input-type=module", "-e", source,
		new URL("../../scripts/lib/migration.mjs", import.meta.url).href, operation, JSON.stringify(options)],
	{ cwd: f.cwd, env: syntheticEnvironment(f), encoding: "utf8", timeout: 10000 });
}

for (const [spelling, alias] of [
	["string", "~/runtime-release"],
	["filtered object", { source: " \t~/runtime-release\n ", extensions: ["./dist/pi-ui/index.js"] }],
	["bare tilde", { source: "~", extensions: ["./runtime-release/dist/pi-ui/index.js"] }],
]) {
	test(`migration conservatively refuses a preexisting ${spelling} HOME package source`, async (t) => {
		const f = setup(t);
		const release = path.join(f.home, "runtime-release");
		fs.renameSync(f.options.release, release); f.options.release = release;
		const current = f.read(); current.packages.push(alias); f.write(current);
		const before = fs.readFileSync(f.settingsPath, "utf8");
		for (const dryRun of [false, true]) {
			const result = syntheticOperation(f, "migrate", { ...f.options, dryRun });
			assert.equal(result.status, 1, result.stderr || result.stdout);
			assert.match(result.stderr, /HOME|unresolved/i);
			assert.equal(fs.readFileSync(f.settingsPath, "utf8"), before);
			assertOriginalDirectories(f);
			assert.equal(fs.existsSync(f.options.backupDir), false);
		}
	});

	test(`rollback conservatively refuses an additional ${spelling} HOME package source before restores`, async (t) => {
		const f = setup(t);
		const release = path.join(f.home, "runtime-release");
		fs.renameSync(f.options.release, release); f.options.release = release;
		const migrated = syntheticOperation(f, "migrate", f.options);
		assert.equal(migrated.status, 0, migrated.stderr);
		const current = f.read(); current.packages.push(alias); f.write(current);
		assert.ok(current.packages.includes(release), "the exact migration-owned reference must remain alongside the HOME alias");
		const before = fs.readFileSync(f.settingsPath, "utf8");
		const beforeJournal = fs.readFileSync(f.journal, "utf8");
		for (const dryRun of [false, true]) {
			const result = syntheticOperation(f, "rollback", { ...rollbackOptions(f), dryRun });
			assert.equal(result.status, 1, result.stderr || result.stdout);
			assert.match(result.stderr, /HOME|unresolved/i);
			assert.equal(fs.readFileSync(f.settingsPath, "utf8"), before);
			assert.equal(fs.readFileSync(f.journal, "utf8"), beforeJournal);
			for (const name of names) assert.equal(fs.existsSync(path.join(f.options.agentDir, "extensions", name)), false);
		}
	});
}

test("HOME-like values in unknown arrays and remote package versions survive migration and rollback", async (t) => {
	const f = setup(t);
	const current = f.read();
	current.unknownResources = ["~/runtime-release", { source: "~", extensions: [entries[0]] }];
	current.mystery.array.push("~/runtime-release");
	current.packages.unshift("npm:unrelated@~1.0.0"); f.write(current);
	const migrated = syntheticOperation(f, "migrate", f.options);
	assert.equal(migrated.status, 0, migrated.stderr);
	assert.deepEqual(f.read().unknownResources, current.unknownResources);
	assert.deepEqual(f.read().mystery, current.mystery);
	const rolled = syntheticOperation(f, "rollback", rollbackOptions(f));
	assert.equal(rolled.status, 0, rolled.stderr);
	assert.deepEqual(f.read(), current);
});

// Break caught: the first cleanup exception skips releasing the second lock,
// leaving a live transaction's heartbeat to exclude cooperative writers.
for (const operation of ["migration", "repeat migration", "rollback", "repeat rollback"]) {
	test(`${operation} attempts the second real lock cleanup after the first release fails`, async (t) => {
		const { migrate, rollback } = await api();
		const f = setup(t);
		if (operation !== "migration") await migrate(f.options, f.dependencies);
		if (operation === "repeat rollback") await rollback(rollbackOptions(f));
		const first = operation === "migration" ? f.journal : f.settingsPath;
		const second = operation === "migration" ? f.settingsPath : f.journal;
		const originalRmdir = fs.rmdirSync;
		try {
			fs.rmdirSync = (target, ...args) => {
				if (target === `${first}.lock`) throw Object.assign(new Error("synthetic first release permission fault"), { code: "EACCES" });
				return originalRmdir(target, ...args);
			};
			try {
				await assert.rejects(operation.includes("rollback") ? rollback(rollbackOptions(f)) : migrate(f.options, f.dependencies), (error) => error.code === "EACCES");
			} finally { fs.rmdirSync = originalRmdir; }
			// This process (and any skipped heartbeat) remains alive while an
			// independent real proper-lockfile writer tries the second lock.
			const writerSource = `
				const fs = require("node:fs"), lock = require(process.argv[2]);
				const unlock = lock.lockSync(process.argv[1], { realpath: false });
				try {
					if (process.argv[3] === "settings") {
						const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
						value.defaultModel = "writer-after-journal-cleanup-fault";
						fs.writeFileSync(process.argv[1], JSON.stringify(value));
					}
					console.log("acquired");
				} finally { unlock(); }
			`;
			const writer = spawnSync(process.execPath, ["-e", writerSource, second, require.resolve("proper-lockfile"), second === f.settingsPath ? "settings" : "journal"],
				{ cwd: f.cwd, env: syntheticEnvironment(f), encoding: "utf8", timeout: 3000 });
			assert.equal(writer.status, 0, `second lock must be available while the transaction process is alive: ${writer.stderr}`);
			assert.equal(writer.stdout.trim(), "acquired");
			assert.equal(fs.existsSync(`${second}.lock`), false);
			if (second === f.settingsPath) assert.equal(f.read().defaultModel, "writer-after-journal-cleanup-fault");
		} finally {
			fs.rmdirSync = originalRmdir;
			// Only synthetic fault debris: cancel a skipped release's real timer
			// even on RED, then remove the directory left by the denied rmdir.
			for (const file of [f.journal, f.settingsPath]) {
				try { lockfile.unlockSync(file, { realpath: false }); }
				catch (error) { if (error.code !== "ENOTACQUIRED") throw error; }
				fs.rmSync(`${file}.lock`, { recursive: true, force: true });
			}
		}
	});
}

test("Pi's real settings lock prevents all directory and settings mutations", async (t) => {
	const { migrate } = await api();
	const f = setup(t);
	const release = lockfile.lockSync(f.settingsPath, { realpath: false });
	try {
		await assert.rejects(migrate(f.options, f.dependencies), (error) => error.code === "ELOCKED");
		assertOriginalDirectories(f);
		assert.deepEqual(f.read(), f.initial);
		assert.equal(fs.existsSync(f.options.backupDir), false);
	} finally { release(); }
});

test("settings are reread after preflight, retaining intervening unrelated edits", async (t) => {
	const { migrate } = await api();
	const f = setup(t);
	await migrate(f.options, { ...f.dependencies, validateRelease: async () => {
		const s = f.read(); s.defaultModel = "concurrently-selected"; s.packages.unshift("npm:added-before-lock"); f.write(s);
	} });
	assert.equal(f.read().defaultModel, "concurrently-selected");
	assert.deepEqual(f.read().packages, ["npm:added-before-lock", "npm:unrelated", f.options.release]);
});

test("rollback performs only its inverse entries while retaining concurrent arrays and preferences", async (t) => {
	const { migrate, rollback } = await api();
	const f = setup(t);
	await migrate(f.options, f.dependencies);
	const current = f.read();
	current.packages.unshift("npm:concurrent"); current.extensions.push("+new-extension.js"); current.theme = "light"; current.mystery.array.push("new");
	f.write(current);
	await rollback(rollbackOptions(f));
	const after = f.read();
	assert.equal(after.theme, "light");
	assert.deepEqual(after.packages, ["npm:concurrent", f.initial.packages[1], "npm:unrelated"]);
	assert.deepEqual(after.extensions, ["-builtin:mcp", f.initial.extensions[1], "orca-agent-status.ts", f.initial.extensions[3], "+new-extension.js"]);
	assert.deepEqual(after.mystery.array, ["leave", "alone", "new"]);
	assertOriginalDirectories(f);
	await rollback(rollbackOptions(f));
	assert.deepEqual(f.read(), after);
});

test("rollback dry-run and missing acknowledgment make no changes", async (t) => {
	const { migrate, rollback } = await api();
	const f = setup(t);
	await migrate(f.options, f.dependencies);
	const before = fs.readFileSync(f.settingsPath, "utf8");
	await assert.rejects(rollback({ ...rollbackOptions(f), allInstancesStopped: false }));
	assert.equal((await rollback({ ...rollbackOptions(f), dryRun: true })).state, "dry-run");
	assert.equal(fs.readFileSync(f.settingsPath, "utf8"), before);
	assert.equal(fs.existsSync(path.join(f.options.agentDir, "extensions/pi-loop")), false);
});

test("rollback refuses changed own package reference or conflicting related override without partial restores", async (t) => {
	const { migrate, rollback } = await api();
	for (const mutation of [
		(f, s) => { s.packages[s.packages.length - 1] = { source: f.options.release, extensions: [] }; },
		(f, s) => s.extensions.push("-extensions/claude-style-tools/index.js"),
		(f, s) => s.packages.pop(),
	]) {
		const f = setup(t);
		await migrate(f.options, f.dependencies);
		const s = f.read(); mutation(f, s); f.write(s);
		await assert.rejects(rollback(rollbackOptions(f)), /conflict/i);
		assert.deepEqual(f.read(), s);
		for (const name of names) assert.equal(fs.existsSync(path.join(f.options.agentDir, "extensions", name)), false);
	}
});

test("rollback detects directory collisions and archive replacement identity before any settings mutation", async (t) => {
	const { migrate, rollback } = await api();
	for (const collision of [true, false]) {
		const f = setup(t);
		await migrate(f.options, f.dependencies);
		if (collision) fs.mkdirSync(path.join(f.options.agentDir, "extensions/pi-loop"));
		else fs.writeFileSync(path.join(f.options.backupDir, "directories/pi-loop/index.js"), "replaced");
		const before = f.read();
		await assert.rejects(rollback(rollbackOptions(f)), /identity|conflict|collision/i);
		assert.deepEqual(f.read(), before);
		assert.equal(fs.existsSync(path.join(f.options.agentDir, "extensions/claude-style-tools")), false);
	}
});

test("failure at each archive rename leaves a recoverable journal for explicit rollback", async (t) => {
	const { migrate, rollback } = await api();
	for (const failedName of names) {
		const f = setup(t);
		await assert.rejects(migrate(f.options, { ...f.dependencies, renameSync: (from, to) => {
			if (from === path.join(f.options.agentDir, "extensions", failedName)) throw new Error("injected archive rename failure");
			fs.renameSync(from, to);
		} }), /rename failure/);
		assert.equal(fs.existsSync(f.journal), true);
		for (const name of names) assert.equal(fs.existsSync(path.join(f.options.agentDir, "extensions", name)), names.indexOf(name) >= names.indexOf(failedName));
		assert.deepEqual(f.read(), f.initial);
		await rollback(rollbackOptions(f));
		assertOriginalDirectories(f);
		assert.deepEqual(f.read(), f.initial);
	}
});

test("failed atomic settings publish never tears settings, and rollback restores archived directories", async (t) => {
	const { migrate, rollback } = await api();
	const f = setup(t);
	const before = fs.readFileSync(f.settingsPath, "utf8");
	await assert.rejects(migrate(f.options, { ...f.dependencies, renameSync: (from, to) => {
		if (to === f.settingsPath) throw new Error("injected settings publish failure");
		fs.renameSync(from, to);
	} }), /publish failure/);
	assert.equal(fs.readFileSync(f.settingsPath, "utf8"), before);
	await rollback(rollbackOptions(f));
	assertOriginalDirectories(f);
	assert.deepEqual(f.read(), f.initial);
});

test("failed settings/evidence backup writes leave discoverable resources unchanged", async (t) => {
	const { migrate, rollback } = await api();
	for (const failedFile of ["settings.before.json", "approved-evidence.json"]) {
		const f = setup(t);
		await assert.rejects(migrate(f.options, { ...f.dependencies, writeFileSync: (file, bytes, options) => {
			if (String(file).includes(failedFile)) throw new Error("injected backup write failure");
			fs.writeFileSync(file, bytes, options);
		} }), /backup write failure/);
		assertOriginalDirectories(f);
		assert.deepEqual(f.read(), f.initial);
		assert.equal(fs.existsSync(f.journal), true);
		await rollback(rollbackOptions(f));
		assertOriginalDirectories(f);
		assert.deepEqual(f.read(), f.initial);
	}
});

test("journal failure immediately after archive rename is recovered by identity, not completion flags", async (t) => {
	const { migrate, rollback } = await api();
	const f = setup(t);
	let moved = false;
	await assert.rejects(migrate(f.options, { ...f.dependencies, renameSync: (from, to) => {
		if (moved && to === f.journal) throw new Error("injected journal publish failure");
		fs.renameSync(from, to);
		if (from === path.join(f.options.agentDir, "extensions/claude-style-tools")) moved = true;
	} }), /journal publish failure/);
	await rollback(rollbackOptions(f));
	assertOriginalDirectories(f);
	assert.deepEqual(f.read(), f.initial);
});

test("journal failure immediately after settings publish still permits a conditional inverse", async (t) => {
	const { migrate, rollback } = await api();
	const f = setup(t);
	let published = false;
	await assert.rejects(migrate(f.options, { ...f.dependencies, renameSync: (from, to) => {
		if (published && to === f.journal) throw new Error("injected journal publish failure");
		fs.renameSync(from, to);
		if (to === f.settingsPath) published = true;
	} }), /journal publish failure/);
	assert.equal(f.read().packages.at(-1), f.options.release);
	await rollback(rollbackOptions(f));
	assertOriginalDirectories(f);
	assert.deepEqual(f.read(), f.initial);
});

test("failure at each rollback rename can resume while retaining unrelated concurrent changes", async (t) => {
	const { migrate, rollback } = await api();
	for (const failedName of names) {
		const f = setup(t);
		await migrate(f.options, f.dependencies);
		await assert.rejects(rollback(rollbackOptions(f), { renameSync: (from, to) => {
			if (to === path.join(f.options.agentDir, "extensions", failedName)) throw new Error("injected restore failure");
			fs.renameSync(from, to);
		} }), /restore failure/);
		for (const name of names) assert.equal(fs.existsSync(path.join(f.options.agentDir, "extensions", name)), names.indexOf(name) < names.indexOf(failedName));
		const s = f.read(); s.packages.push("npm:during-recovery"); f.write(s);
		await rollback(rollbackOptions(f));
		assertOriginalDirectories(f);
		assert.deepEqual(f.read().packages, ["npm:unrelated", f.initial.packages[1], "npm:during-recovery"]);
	}
});

test("existing backup collision is refused without replacing evidence", async (t) => {
	const { migrate } = await api();
	const f = setup(t);
	fs.mkdirSync(f.options.backupDir);
	fs.writeFileSync(path.join(f.options.backupDir, "keep.txt"), "keep");
	await assert.rejects(migrate(f.options, f.dependencies), /exist|collision/i);
	assertOriginalDirectories(f);
	assert.equal(fs.readFileSync(path.join(f.options.backupDir, "keep.txt"), "utf8"), "keep");
});

test("CLI has no HOME defaults and refuses absent flags or acknowledgment in a synthetic environment", (t) => {
	const f = setup(t);
	const args = ["--agent-dir", f.options.agentDir, "--release", f.options.release, "--backup-dir", f.options.backupDir, "--approval", f.approvalPath];
	for (const flags of [[], args, ["--rollback", "--all-instances-stopped", ...args]]) {
		const result = spawnSync(process.execPath, [script, ...flags], { cwd: f.cwd, env: syntheticEnvironment(f), encoding: "utf8" });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /required|acknowledg|journal/i);
	}
	assertOriginalDirectories(f);
	assert.deepEqual(f.read(), f.initial);
	assert.equal(fs.existsSync(f.options.backupDir), false);
});

function syntheticEnvironment(f) {
	return { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: f.home,
		PI_CODING_AGENT_DIR: f.options.agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0",
		PI_SKIP_VERSION_CHECK: "1", XDG_CONFIG_HOME: path.join(f.home, ".config"),
		XDG_CACHE_HOME: path.join(f.home, ".cache"), TMPDIR: f.root };
}

test("approved internal symbolic links are archived opaquely and restored without following targets", async (t) => {
	const { migrate, rollback, fingerprintDirectory } = await api();
	const f = setup(t);
	const directory = path.join(f.options.agentDir, "extensions/pi-docparser");
	fs.mkdirSync(path.join(directory, "node_modules/.bin"), { recursive: true });
	fs.mkdirSync(path.join(directory, "node_modules/fixture"));
	fs.writeFileSync(path.join(directory, "node_modules/fixture/cli.js"), "synthetic executable\n");
	fs.symlinkSync("../fixture/cli.js", path.join(directory, "node_modules/.bin/fixture"));
	f.approval.directories.find((entry) => entry.name === "pi-docparser").sha256 = fingerprint(directory);
	f.approve();
	assert.equal(fingerprintDirectory(directory), fingerprint(directory));
	await migrate(f.options, f.dependencies);
	const archived = path.join(f.options.backupDir, "directories/pi-docparser/node_modules/.bin/fixture");
	assert.equal(fs.lstatSync(archived).isSymbolicLink(), true);
	assert.equal(fs.readlinkSync(archived), "../fixture/cli.js");
	await rollback(rollbackOptions(f));
	assert.equal(fs.readlinkSync(path.join(directory, "node_modules/.bin/fixture")), "../fixture/cli.js");
});

test("permission-only changes invalidate approved fingerprints, including special mode bits", async (t) => {
	const { migrate } = await api();
	const f = setup(t);
	fs.chmodSync(path.join(f.options.agentDir, "extensions/pi-loop/index.js"), 0o4644);
	await assert.rejects(migrate(f.options, f.dependencies), /identity|fingerprint/i);
	assertOriginalDirectories(f);
	assert.equal(fs.existsSync(f.options.backupDir), false);
});

test("rollback cannot claim identically shaped foreign settings edits before any publish intent", async (t) => {
	const { migrate, rollback } = await api();
	const f = setup(t);
	await assert.rejects(migrate(f.options, { ...f.dependencies, writeFileSync: (file, bytes, options) => {
		if (String(file).includes("settings.before.json")) throw new Error("backup failure");
		fs.writeFileSync(file, bytes, options);
	} }));
	const foreign = { ...f.initial, packages: ["npm:unrelated", f.options.release], extensions: ["-builtin:mcp", "orca-agent-status.ts"] };
	f.write(foreign);
	await assert.rejects(rollback(rollbackOptions(f)), /conflict/i);
	assert.deepEqual(f.read(), foreign);
	assertOriginalDirectories(f);
});

test("settings mode is preserved through atomic migration and rollback writes", async (t) => {
	const { migrate, rollback } = await api();
	const f = setup(t);
	fs.chmodSync(f.settingsPath, 0o640);
	await migrate(f.options, f.dependencies);
	assert.equal(fs.statSync(f.settingsPath).mode & 0o777, 0o640);
	await rollback(rollbackOptions(f));
	assert.equal(fs.statSync(f.settingsPath).mode & 0o777, 0o640);
	assert.equal(fs.statSync(path.join(f.options.backupDir, "settings.before.json")).mode & 0o777, 0o600);
});

test("rollback recovers a journal publish failure after its atomic settings inverse", async (t) => {
	const { migrate, rollback } = await api();
	const f = setup(t);
	await migrate(f.options, f.dependencies);
	let settingsRestored = false;
	await assert.rejects(rollback(rollbackOptions(f), { renameSync: (from, to) => {
		if (settingsRestored && to === f.journal) throw new Error("inverse journal publish failed");
		fs.renameSync(from, to);
		if (to === f.settingsPath) settingsRestored = true;
	} }), /journal publish failed/);
	const s = f.read(); s.extensions.push("concurrent-after-inverse.js"); f.write(s);
	await rollback(rollbackOptions(f));
	assert.deepEqual(f.read().extensions, [...f.initial.extensions, "concurrent-after-inverse.js"]);
	assertOriginalDirectories(f);
});

test("failed rollback settings write is recoverable after directories were restored", async (t) => {
	const { migrate, rollback } = await api();
	const f = setup(t);
	await migrate(f.options, f.dependencies);
	await assert.rejects(rollback(rollbackOptions(f), { writeFileSync: (file, bytes, options) => {
		if (String(file).startsWith(`${f.settingsPath}.tmp-`)) throw new Error("settings write failed");
		fs.writeFileSync(file, bytes, options);
	} }), /settings write failed/);
	assertOriginalDirectories(f);
	assert.equal(f.read().packages.at(-1), f.options.release);
	const s = f.read(); s.defaultModel = "concurrent-before-retry"; f.write(s);
	await rollback(rollbackOptions(f));
	assert.deepEqual(f.read().packages, f.initial.packages);
	assert.equal(f.read().defaultModel, "concurrent-before-retry");
});

test("identical archive replacement with a different directory inode is a rollback conflict", async (t) => {
	const { migrate, rollback } = await api();
	const f = setup(t);
	await migrate(f.options, f.dependencies);
	const archived = path.join(f.options.backupDir, "directories/pi-loop");
	const copy = path.join(f.root, "copy");
	fs.cpSync(archived, copy, { recursive: true, preserveTimestamps: true });
	fs.rmSync(archived, { recursive: true });
	fs.renameSync(copy, archived);
	await assert.rejects(rollback(rollbackOptions(f)), /identity|conflict/i);
	assert.equal(fs.existsSync(path.join(f.options.agentDir, "extensions/claude-style-tools")), false);
});

test("rollback requires matching explicit journal identity and honors Pi's settings lock", async (t) => {
	const { migrate, rollback } = await api();
	const f = setup(t);
	await migrate(f.options, f.dependencies);
	await assert.rejects(rollback({ ...rollbackOptions(f), journalPath: path.join(f.root, "other.json") }));
	await assert.rejects(rollback({ ...rollbackOptions(f), release: path.join(f.root, "another-release") }), /journal|conflict/i);
	const release = lockfile.lockSync(f.settingsPath, { realpath: false });
	try {
		await assert.rejects(rollback(rollbackOptions(f)), (error) => error.code === "ELOCKED");
		assert.equal(fs.existsSync(path.join(f.options.agentDir, "extensions/claude-style-tools")), false);
	} finally { release(); }
});

async function completeRuntimeFixture(f) {
	// Exercise the actual release validator against a physical, locked native
	// runtime without npm/network or any physical Pi host copies. Dist retains
	// its real closure, licenses and artifact seal, not manifest-only stand-ins.
	const workspace = fileURLToPath(new URL("../../", import.meta.url));
	const { runtimeManifest, runtimeLock, sealRelease } = await import("../../scripts/lib/package.mjs");
	assert.equal(typeof sealRelease, "function", "parent release sealing interface must be available");
	const manifest = await runtimeManifest();
	const lock = runtimeLock(JSON.parse(await fsp.readFile(path.join(workspace, "package-lock.json"), "utf8")), manifest);
	await fsp.writeFile(path.join(f.options.release, "package.json"), JSON.stringify(manifest));
	await fsp.writeFile(path.join(f.options.release, "package-lock.json"), JSON.stringify(lock));
	await fsp.rm(path.join(f.options.release, "dist"), { recursive: true });
	await fsp.cp(path.join(workspace, "dist"), path.join(f.options.release, "dist"), { recursive: true });
	for (const [relative, record] of Object.entries(lock.packages)) {
		if (!relative) continue;
		const source = path.join(workspace, relative);
		if (!fs.existsSync(source)) {
			assert.equal(record.optional, true, `required locked dependency must be installed: ${relative}`);
			continue;
		}
		await fsp.cp(source, path.join(f.options.release, relative), { recursive: true });
	}
	await sealRelease(f.options.release, { buildId: "synthetic-offline-migration" });
}

test("CLI dry-run, switch, and explicit journal rollback use the parent's real release validator", async (t) => {
	const f = setup(t);
	await completeRuntimeFixture(f);
	const shared = ["--agent-dir", f.options.agentDir, "--release", f.options.release, "--backup-dir", f.options.backupDir, "--all-instances-stopped"];
	function run(flags) {
		return spawnSync(process.execPath, [script, ...shared, ...flags], { cwd: f.cwd, env: syntheticEnvironment(f), encoding: "utf8", timeout: 30000 });
	}
	const dry = run(["--approval", f.approvalPath, "--dry-run"]);
	assert.equal(dry.status, 0, dry.stderr);
	assert.equal(JSON.parse(dry.stdout).state, "dry-run");
	assert.equal(fs.existsSync(f.options.backupDir), false);
	const switched = run(["--approval", f.approvalPath]);
	assert.equal(switched.status, 0, switched.stderr);
	assert.equal(JSON.parse(switched.stdout).state, "migrated");
	assert.equal(f.read().packages.at(-1), f.options.release);
	const rolled = run(["--rollback", "--journal", f.journal]);
	assert.equal(rolled.status, 0, rolled.stderr);
	assert.equal(JSON.parse(rolled.stdout).state, "rolled-back");
	assertOriginalDirectories(f);
	assert.deepEqual(f.read(), f.initial);
});

test("a closure-invalid runtime fails default validation without touching settings or directories", async (t) => {
	const { migrate } = await api();
	const f = setup(t);
	await completeRuntimeFixture(f);
	fs.writeFileSync(path.join(f.options.release, entries[0]), "import './missing.js'; export default function () {}\n");
	await assert.rejects(migrate(f.options), /integrity|missing|resolve/i);
	assertOriginalDirectories(f);
	assert.deepEqual(f.read(), f.initial);
	assert.equal(fs.existsSync(f.options.backupDir), false);
});

test("a release in another dependency or project discovery tree is refused", async (t) => {
	const { migrate } = await api();
	for (const component of ["node_modules", "extensions"]) {
		const f = setup(t);
		const destination = path.join(f.root, "project/.pi", component, "release");
		fs.mkdirSync(path.dirname(destination), { recursive: true });
		fs.renameSync(f.options.release, destination);
		f.options.release = destination;
		await assert.rejects(migrate(f.options, f.dependencies), /dependency|discovery/i);
		assertOriginalDirectories(f);
		assert.equal(fs.existsSync(f.options.backupDir), false);
	}
});

test("a runtime inheriting a physical host dependency from an ancestor is refused", async (t) => {
	const { migrate } = await api();
	const f = setup(t);
	fs.mkdirSync(path.join(f.root, "node_modules/@earendil-works/pi-tui"), { recursive: true });
	await assert.rejects(migrate(f.options, f.dependencies), /host|dependency/i);
	assertOriginalDirectories(f);
	assert.equal(fs.existsSync(f.options.backupDir), false);
});

test("a damaged settings inverse in the journal is refused before directory restores", async (t) => {
	const { migrate, rollback } = await api();
	for (const mutation of [
		(j) => { j.settings.delta = null; },
		(j) => { j.settings.delta.deletions.pop(); },
	]) {
		const f = setup(t);
		await migrate(f.options, f.dependencies);
		const journal = JSON.parse(fs.readFileSync(f.journal));
		mutation(journal); fs.writeFileSync(f.journal, JSON.stringify(journal));
		const before = f.read();
		await assert.rejects(rollback(rollbackOptions(f)), /journal|inverse|integrity/i);
		assert.deepEqual(f.read(), before);
		assert.equal(fs.existsSync(path.join(f.options.agentDir, "extensions/claude-style-tools")), false);
	}
});

// Break caught: publishing preflight settings instead of rereading under the
// lock loses the other writer's edit. No race against the 10 x 20ms retry window:
// capture the final preflight read, then await a write + unlock ACK before the
// parent consumes that snapshot or attempts to acquire Pi's real lock.
test("lock-time reread retains edits from a real competing settings writer", async (t) => {
	const { migrate } = await api();
	const f = setup(t);
	const childSource = `
		const fs = require("node:fs");
		const lock = require(process.argv[2]);
		const settings = process.argv[1];
		const unlock = lock.lockSync(settings, { realpath: false });
		process.stdout.write("locked\\n");
		const deadline = setTimeout(() => { unlock(); process.exit(2); }, 3000);
		process.stdin.once("data", () => {
			const value = JSON.parse(fs.readFileSync(settings, "utf8"));
			value.defaultModel = "real-competing-writer";
			value.packages.push("npm:competing-writer");
			fs.writeFileSync(settings, JSON.stringify(value));
			unlock();
			process.stdout.write("written-and-unlocked\\n", () => { clearTimeout(deadline); process.exit(0); });
		});
	`;
	const child = spawn(process.execPath, ["-e", childSource, f.settingsPath, require.resolve("proper-lockfile")], { cwd: f.cwd, env: syntheticEnvironment(f), stdio: ["pipe", "pipe", "pipe"] });
	let stderr = "", stdout = "", readyResolve, acknowledgedResolve;
	child.stderr.on("data", (data) => { stderr += data; });
	const done = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
	const ready = new Promise((resolve) => { readyResolve = resolve; });
	const acknowledged = new Promise((resolve) => { acknowledgedResolve = resolve; });
	child.stdout.on("data", (data) => {
		stdout += data;
		if (stdout.includes("locked\n")) readyResolve();
		if (stdout.includes("written-and-unlocked\n")) acknowledgedResolve();
	});
	await Promise.race([ready, done.then(() => assert.fail(`Writer exited before locking: ${stderr}`))]);
	const originalReadFile = fsp.readFile;
	let releaseValidated = false, handedOff = false;
	try {
		fsp.readFile = async (file, ...args) => {
			const bytes = await originalReadFile(file, ...args);
			if (file === f.settingsPath && releaseValidated && !handedOff) {
				handedOff = true;
				assert.equal(JSON.parse(bytes).defaultModel, "synthetic-only", "capture pre-edit preflight bytes, not the writer's new settings");
				child.stdin.end("go\n");
				await Promise.race([acknowledged, done.then(() => assert.fail(`Writer exited without write/unlock acknowledgment: ${stderr}`))]);
			}
			return bytes;
		};
		await migrate(f.options, { ...f.dependencies, validateRelease: async () => { releaseValidated = true; } });
	} finally {
		fsp.readFile = originalReadFile;
		if (!handedOff && child.exitCode === null) child.stdin.end("go\n");
		assert.equal(await done, 0, stderr);
	}
	assert.equal(handedOff, true, "the controlled preflight handoff must run");
	assert.equal(f.read().defaultModel, "real-competing-writer");
	assert.deepEqual(f.read().packages, ["npm:unrelated", "npm:competing-writer", f.options.release]);
});

test("an approved literal exclusion override is removed and inversed exactly", async (t) => {
	const { migrate, rollback } = await api();
	const f = setup(t);
	const original = f.read();
	original.extensions[3] = `!${path.join(f.options.agentDir, "extensions/pi-background-shell/index.js")}`;
	f.write(original);
	f.approval.removals[1].value = original.extensions[3]; f.approve();
	await migrate(f.options, f.dependencies);
	assert.deepEqual(f.read().extensions, ["-builtin:mcp", "orca-agent-status.ts"]);
	await rollback(rollbackOptions(f));
	assert.deepEqual(f.read(), original);
});

test("duplicate deletion approvals with different annotations cannot consume an unrelated array entry", async (t) => {
	const { migrate } = await api();
	const f = setup(t);
	f.approval.removals.push({ ...f.approval.removals[0], note: "same deletion with a different annotation" });
	f.approve();
	await assert.rejects(migrate(f.options, f.dependencies), /duplicate/i);
	assert.deepEqual(f.read(), f.initial);
	assertOriginalDirectories(f);
	assert.equal(fs.existsSync(f.options.backupDir), false);
});

// Break caught: a stalled transaction publishes its captured settings after a
// real Pi-protocol writer steals the >10s stale lock, then deletes the new lock.
async function competingWriter(f, mode) {
	const trigger = path.join(f.root, "writer-trigger");
	const observed = path.join(f.root, "writer-observed.json");
	const finish = path.join(f.root, "writer-finish");
	const source = `
		const fs = require("node:fs"), lock = require(process.argv[2]);
		const [settings, , trigger, observed, finish, mode] = process.argv.slice(1);
		let unlock, compromised = false;
		const deadline = setTimeout(() => { try { unlock?.(); } catch {} process.exit(4); }, 25000);
		process.stdout.write("ready\\n");
		const poll = setInterval(() => {
			if (!fs.existsSync(trigger)) return;
			if (!unlock) {
				if (mode === "steal" && fs.statSync(settings + ".lock").mtimeMs >= Date.now() - 10000) return;
				try { unlock = lock.lockSync(settings, { realpath: false, onCompromised: () => { compromised = true; } }); }
				catch (error) {
					if (error.code !== "ELOCKED") throw error;
					if (mode === "protected") { fs.writeFileSync(observed, JSON.stringify({ locked: true })); clearInterval(poll); clearTimeout(deadline); process.exit(0); }
					return;
				}
				const current = JSON.parse(fs.readFileSync(settings));
				current.defaultModel = "writer-after-stale-steal";
				current.packages.push("npm:writer-after-stale-steal");
				fs.writeFileSync(settings, JSON.stringify(current));
				const stat = fs.statSync(settings + ".lock");
				fs.writeFileSync(observed, JSON.stringify({ dev: stat.dev, ino: stat.ino }));
			}
			if (fs.existsSync(finish)) {
				clearInterval(poll); clearTimeout(deadline);
				try { unlock(); } catch { compromised = true; }
				process.exit(compromised ? 3 : 0);
			}
		}, 15);
	`;
	const child = spawn(process.execPath, ["-e", source, f.settingsPath, require.resolve("proper-lockfile"), trigger, observed, finish, mode], { cwd: f.cwd, env: syntheticEnvironment(f), stdio: ["ignore", "pipe", "pipe"] });
	let stderr = "";
	child.stderr.on("data", (data) => { stderr += data; });
	const done = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve(code)); });
	const deadline = setTimeout(() => child.kill("SIGKILL"), 28000);
	try {
		await Promise.race([new Promise((resolve) => child.stdout.once("data", resolve)), done.then(() => assert.fail(`Writer did not start: ${stderr}`))]);
	} catch (error) { child.kill("SIGKILL"); clearTimeout(deadline); await done; throw error; }
	return { trigger, observed, async stop() {
		fs.writeFileSync(finish, "done");
		try { assert.equal(await done, 0, stderr); } finally { clearTimeout(deadline); if (child.exitCode === null) child.kill("SIGKILL"); }
	} };
}

function waitForWriterSynchronously(writer) {
	fs.writeFileSync(writer.trigger, "go");
	const deadline = Date.now() + 22000;
	const sleeper = new Int32Array(new SharedArrayBuffer(4));
	while (!fs.existsSync(writer.observed) && Date.now() < deadline) Atomics.wait(sleeper, 0, 0, 25);
	assert.ok(fs.existsSync(writer.observed), "real writer must acquire the stale lock within its bounded deadline");
}

for (const operation of ["migration", "rollback"]) for (const boundary of ["first directory mutation", "settings publication"]) {
	test(`${operation} refuses ${boundary} after a >10s stall loses the real settings lock`, { timeout: 35000 }, async (t) => {
		const { migrate, rollback } = await api();
		const f = setup(t);
		if (operation === "rollback") await migrate(f.options, f.dependencies);
		const writer = await competingWriter(f, "steal");
		let stalled = false, failure;
		try {
			const dependencies = { ...f.dependencies, writeFileSync(file, bytes, options) {
				const firstIntent = String(file).startsWith(`${f.journal}.tmp-`) && JSON.parse(bytes).state === (operation === "migration" ? "migrating" : "rolling-back");
				if (!stalled && (boundary === "first directory mutation" ? firstIntent : String(file).startsWith(`${f.settingsPath}.tmp-`))) {
					stalled = true; waitForWriterSynchronously(writer);
				}
				fs.writeFileSync(file, bytes, options);
			} };
			try { await (operation === "migration" ? migrate(f.options, dependencies) : rollback(rollbackOptions(f), dependencies)); }
			catch (error) { failure = error; }
			assert.equal(f.read().defaultModel, "writer-after-stale-steal", "must not overwrite the legitimate writer's unrelated preference");
			assert.ok(f.read().packages.includes("npm:writer-after-stale-steal"), "must retain the legitimate writer's added entry");
			assert.match(failure?.message ?? "", /lock.*(lost|compromis|ownership)|ECOMPROMISED/i);
			const held = JSON.parse(fs.readFileSync(writer.observed));
			const stat = fs.statSync(`${f.settingsPath}.lock`);
			assert.deepEqual({ dev: stat.dev, ino: stat.ino }, held, "finally must not delete the other writer's newer lock");
			if (boundary === "first directory mutation") for (const name of names) assert.equal(fs.existsSync(path.join(f.options.agentDir, "extensions", name)), operation === "migration");
		} finally { await writer.stop(); }
		// Once the competing writer releases its own lock, journal-based recovery
		// must retain that edit too, regardless of whether any directories moved.
		await rollback(rollbackOptions(f));
		assertOriginalDirectories(f);
		assert.equal(f.read().defaultModel, "writer-after-stale-steal");
		assert.deepEqual(f.read().packages, [...f.initial.packages, "npm:writer-after-stale-steal"]);
	});
}

// Characterize the installed Pi protocol at our async transaction I/O boundary:
// a >10s write must leave the lock fresh and a real default-threshold writer out.
for (const operation of ["migration", "rollback"]) {
	test(`${operation} keeps real Pi writers excluded during a >10s asynchronous journal write`, { timeout: 35000 }, async (t) => {
		const { migrate, rollback } = await api();
		const f = setup(t);
		if (operation === "rollback") await migrate(f.options, f.dependencies);
		const writer = await competingWriter(f, "protected");
		let delayed = false;
		try {
			const dependencies = { ...f.dependencies, async writeFile(file, bytes, options) {
				if (!delayed && String(file).startsWith(`${f.journal}.tmp-`) && JSON.parse(bytes).state === (operation === "migration" ? "migrating" : "rolling-back")) {
					delayed = true;
					await new Promise((resolve) => setTimeout(resolve, 11500));
					fs.writeFileSync(writer.trigger, "go");
					const deadline = Date.now() + 3000;
					while (!fs.existsSync(writer.observed) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
					assert.deepEqual(JSON.parse(fs.readFileSync(writer.observed)), { locked: true }, "the competing writer must not be able to edit settings while the async transaction owns the lock");
				}
				await fsp.writeFile(file, bytes, options);
			} };
			await (operation === "migration" ? migrate(f.options, dependencies) : rollback(rollbackOptions(f), dependencies));
		} finally { await writer.stop(); }
		assert.equal(f.read().defaultModel, "synthetic-only");
		assert.equal(f.read().packages.includes("npm:writer-after-stale-steal"), false);
		if (operation === "migration") await rollback(rollbackOptions(f));
		assertOriginalDirectories(f); assert.deepEqual(f.read(), f.initial);
	});
}
