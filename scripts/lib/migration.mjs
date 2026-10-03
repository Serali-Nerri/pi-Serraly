import fs from "node:fs";
import fsp from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";

const OLD_DIRECTORIES = ["claude-style-tools", "pi-session-ui", "pi-ask-user-question", "pi-loop", "pi-apply-patch", "pi-background-shell", "pi-docparser"];
const ENTRIES = ["pi-ui", "pi-ask-user-question", "pi-loop", "pi-tools", "pi-background-shell", "pi-docparser", "pi-add-dir"].map((name) => `./dist/${name}/index.js`);
const ARRAYS = ["packages", "extensions", "skills", "prompts", "themes"];
const HOSTS = ["@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"];
const WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function fail(message) {
	throw new Error(message);
}
function exists(file) {
	try { fs.lstatSync(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
function inside(file, directory) {
	const relative = path.relative(directory, file);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function absolute(value, label) {
	if (typeof value !== "string" || !path.isAbsolute(value)) fail(`${label} is required and must be an explicit absolute path`);
	return path.resolve(value);
}
// lstat every existing ancestor: never follow an operator-supplied symlink.
function noSymlinkAncestors(file) {
	let current = path.parse(file).root;
	for (const part of file.slice(current.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		if (exists(current) && fs.lstatSync(current).isSymbolicLink()) fail(`Symlink path is not allowed: ${current}`);
	}
}
function regularFile(file) {
	noSymlinkAncestors(file);
	if (!fs.lstatSync(file).isFile()) fail(`Expected regular file: ${file}`);
}
async function readObject(file) {
	regularFile(file);
	const value = JSON.parse(await fsp.readFile(file, "utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(`Expected JSON object: ${file}`);
	return value;
}
function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
	return JSON.stringify(value);
}
function equal(left, right) { return canonical(left) === canonical(right); }
function count(array, value) { return array.filter((entry) => equal(entry, value)).length; }
function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function settingsArrays(settings) {
	for (const key of ARRAYS) if (settings[key] !== undefined && !Array.isArray(settings[key])) fail(`Settings ${key} must be an array`);
}
function resolveOptions(options) {
	if (options?.allInstancesStopped !== true) fail("Explicit all-instances-stopped acknowledgment is required: session_shutdown and all in-flight work must have ended");
	const agentDir = absolute(options.agentDir, "agentDir / --agent-dir");
	const release = absolute(options.release, "release / --release");
	const backupDir = absolute(options.backupDir, "backupDir / --backup-dir");
	const discovery = path.join(agentDir, "extensions");
	for (const file of [agentDir, release, backupDir, discovery]) noSymlinkAncestors(file);
	if (inside(backupDir, discovery) || inside(release, discovery)) fail("Backup and release must be outside automatic extension discovery");
	if (inside(release, WORKSPACE) || release.split(path.sep).includes("node_modules")) fail("Runtime release must be outside development dependency trees");
	if (release.split(path.sep).includes("extensions")) fail("Runtime release must be outside automatic extension discovery trees");
	if (inside(backupDir, release) || inside(release, backupDir) || inside(agentDir, backupDir)) fail("Backup, runtime release, and agent paths must not overlap");
	if (!fs.lstatSync(agentDir).isDirectory() || !fs.lstatSync(discovery).isDirectory()) fail("Agent directory and extensions discovery directory must exist");
	return { agentDir, release, backupDir, discovery, settingsPath: path.join(agentDir, "settings.json"), journalPath: path.join(backupDir, "journal.json") };
}

/** Operator review aid only; a freshly computed hash is not approval. No links are followed. */
export function fingerprintDirectory(directory) {
	directory = absolute(directory, "directory");
	noSymlinkAncestors(directory);
	const records = [];
	function walk(relative) {
		const full = path.join(directory, relative);
		const stat = fs.lstatSync(full);
		const link = stat.isSymbolicLink() ? fs.readlinkSync(full) : null;
		if (link !== null && (path.isAbsolute(link) || !inside(path.resolve(path.dirname(full), link), directory))) fail(`External/absolute symlink in approved directory: ${full}`);
		if (!stat.isDirectory() && !stat.isFile() && link === null) fail(`Unsupported entry in approved directory: ${full}`);
		const kind = link !== null ? "symlink" : stat.isDirectory() ? "directory" : "file";
		records.push([relative || ".", kind, stat.mode & 0o7777, kind === "file" ? digest(fs.readFileSync(full)) : link]);
		if (kind === "directory") for (const name of fs.readdirSync(full).sort()) walk(relative ? `${relative}/${name}` : name);
	}
	if (!fs.lstatSync(directory).isDirectory()) fail(`Expected directory: ${directory}`);
	walk("");
	return digest(JSON.stringify(records));
}
// Transaction fingerprints stream file bytes and yield on every directory entry.
// The public synchronous review aid above is never used while holding a lock.
async function identity(directory) {
	noSymlinkAncestors(directory);
	const rootStat = await fsp.lstat(directory);
	if (!rootStat.isDirectory()) fail(`Expected directory: ${directory}`);
	const hash = createHash("sha256");
	hash.update("[");
	let first = true;
	async function walk(relative) {
		const full = path.join(directory, relative);
		const stat = await fsp.lstat(full);
		const link = stat.isSymbolicLink() ? await fsp.readlink(full) : null;
		if (link !== null && (path.isAbsolute(link) || !inside(path.resolve(path.dirname(full), link), directory))) fail(`External/absolute symlink in approved directory: ${full}`);
		if (!stat.isDirectory() && !stat.isFile() && link === null) fail(`Unsupported entry in approved directory: ${full}`);
		const kind = link !== null ? "symlink" : stat.isDirectory() ? "directory" : "file";
		let bytesHash = null;
		if (kind === "file") {
			const bytes = createHash("sha256");
			for await (const chunk of fs.createReadStream(full)) bytes.update(chunk);
			bytesHash = bytes.digest("hex");
		}
		hash.update(`${first ? "" : ","}${JSON.stringify([relative || ".", kind, stat.mode & 0o7777, kind === "file" ? bytesHash : link])}`);
		first = false;
		if (kind === "directory") for (const name of (await fsp.readdir(full)).sort()) await walk(relative ? `${relative}/${name}` : name);
	}
	await walk("");
	hash.update("]");
	return { sha256: hash.digest("hex"), dev: rootStat.dev, ino: rootStat.ino };
}
async function verifyIdentity(directory, expected) {
	const actual = await identity(directory);
	if (actual.sha256 !== expected.sha256 || actual.dev !== expected.dev || actual.ino !== expected.ino) fail(`Directory identity conflict: ${directory}`);
}

async function validateRuntime(release, dependencies) {
	// Compiled ESM must not inherit a second Pi host from a parent node_modules.
	for (let ancestor = path.dirname(release); ; ancestor = path.dirname(ancestor)) {
		for (const host of HOSTS) if (exists(path.join(ancestor, "node_modules", host))) fail(`Inherited physical host dependency above runtime release: ${host} in ${ancestor}`);
		if (ancestor === path.dirname(ancestor)) break;
	}
	const manifest = await readObject(path.join(release, "package.json"));
	if (manifest.private !== true || manifest.type !== "module" || !equal(manifest.pi?.extensions, ENTRIES)) fail("Release requires a private ESM runtime manifest with exactly seven dist entries");
	if (Object.keys(manifest.devDependencies ?? {}).length) fail("Release must not contain development dependencies");
	for (const host of HOSTS) if (manifest.dependencies?.[host] || manifest.optionalDependencies?.[host]) fail(`Host dependency in runtime manifest: ${host}`);
	for (const resource of ["skills", "prompts", "themes"]) if (manifest.pi?.[resource]?.length) fail(`Runtime must not automatically enable ${resource}`);
	regularFile(path.join(release, "package-lock.json"));
	for (const entry of ENTRIES) regularFile(path.join(release, entry));
	async function scan(directory) {
		const stat = await fsp.lstat(directory);
		if (stat.isSymbolicLink()) {
			// npm .bin links can be internal; never traverse them or external links.
			if (!inside(path.resolve(path.dirname(directory), (await fsp.readlink(directory))), release)) fail(`External symlink in runtime release: ${directory}`);
			return;
		}
		if (!stat.isDirectory()) return;
		if (path.basename(directory) === "node_modules") {
			for (const host of HOSTS) if (exists(path.join(directory, host))) fail(`Physical host dependency in runtime release: ${path.join(directory, host)}`);
		}
		for (const child of await fsp.readdir(directory)) await scan(path.join(directory, child));
	}
	await scan(release);
	// Parent owns closure, platform dependencies, license and runtime loader checks.
	const validator = dependencies.validateRelease ?? (await import("./package.mjs")).validateRelease;
	if (typeof validator !== "function") fail("Release validator validateRelease(path) is unavailable");
	await validator(release);
}

async function approvalFor(options, paths) {
	const approvalPath = absolute(options.approvalPath, "approvalPath / --approval");
	const approval = await readObject(approvalPath);
	if (approval.version !== 1 || !Array.isArray(approval.directories) || approval.directories.length !== OLD_DIRECTORIES.length || !Array.isArray(approval.removals)) fail("Approval manifest requires version 1, exactly seven directories, and explicit removals");
	const seen = new Set();
	const directories = [];
	for (const approved of approval.directories) {
		if (!OLD_DIRECTORIES.includes(approved.name) || seen.has(approved.name)) fail(`Unknown or duplicate directory approval: ${approved.name}`);
		seen.add(approved.name);
		if (!/^[a-f0-9]{64}$/.test(approved.sha256 ?? "") || !["repository", "revision", "worktree"].every((key) => typeof approved.source?.[key] === "string" && approved.source[key].trim())) fail(`Exact fingerprint and source evidence required: ${approved.name}`);
		const source = path.join(paths.discovery, approved.name);
		const actual = await identity(source);
		if (actual.sha256 !== approved.sha256) fail(`Approved fingerprint identity mismatch: ${source}`);
		if (approved.packageName !== undefined && approved.packageName !== null) {
			if (typeof approved.packageName !== "string" || (await readObject(path.join(source, "package.json"))).name !== approved.packageName) fail(`Approved package manifest identity mismatch: ${source}`);
		}
		directories.push({ name: approved.name, source, archive: path.join(paths.backupDir, "directories", approved.name), identity: actual, phase: "pending" });
	}
	for (const removal of approval.removals) validateRemoval(removal, paths, directories);
	if (new Set(approval.removals.map((entry) => canonical([entry.array, entry.value]))).size !== approval.removals.length) fail("Duplicate approved resource removal");
	return { approval, directories };
}
// Pi 1.0.0 package-manager.resolvePathFromBase / utils/paths.normalizePath:
// trim local sources and decode file:// before resolving from the agent. Identity
// normalization never changes the original value recorded in the settings delta.
function resourcePath(value, array, paths) {
	let source = array === "packages" && value && typeof value === "object" ? value.source : value;
	if (typeof source !== "string") return null;
	source = source.trim();
	if (array !== "packages" && /^[+!-]/.test(source)) source = source.slice(1).trim();
	if (/^(npm:|git:|https?:|builtin:)/.test(source)) return null;
	if (source.startsWith("~")) {
		// Without expanding HOME we cannot rule out an old-install or release
		// alias, even in a filtered object. Refuse rather than treat it as unrelated.
		if (array === "packages") fail(`Unresolved HOME local package source: ${canonical(value)}; review and use an explicit absolute source before migration or rollback`);
		return null;
	}
	if (source.startsWith("file://")) source = fileURLToPath(source);
	return path.resolve(paths.agentDir, source);
}
function related(value, array, paths, directories) {
	const resolved = resourcePath(value, array, paths);
	if (resolved) return directories.some((directory) => inside(resolved, directory.source));
	// Refuse unresolvable HOME spellings that could duplicate these installations.
	const source = (typeof value === "string" ? value : value?.source)?.trim();
	return typeof source === "string" && /^[+!-]?\s*~\//.test(source) && directories.some((directory) => source.includes(`/extensions/${directory.name}`));
}
function validateRemoval(removal, paths, directories) {
	if (!removal || !ARRAYS.includes(removal.array)) fail("Approved removal must name a resource array");
	const source = (removal.array === "packages" && typeof removal.value === "object" ? removal.value?.source : removal.value)?.trim();
	const resolved = resourcePath(removal.value, removal.array, paths);
	if (typeof source !== "string" || /[*?\[\]{}()]/.test(source) || /[*?\[\]{}()]/.test(resolved ?? "") || source.startsWith("~") || /^[+!-]\s*~/.test(source) || !related(removal.value, removal.array, paths, directories)) fail("Only exact local overrides associated with approved archived directories may be removed; no globs, HOME aliases or unrelated resources");
	if (removal.array !== "packages" && typeof removal.value !== "string") fail("Resource override must be an exact string");
}
function makeDelta(settings, removals, paths, directories) {
	settingsArrays(settings);
	for (const array of ARRAYS) {
		for (const value of settings[array] ?? []) if (related(value, array, paths, directories) && !removals.some((entry) => entry.array === array && equal(entry.value, value))) fail(`Unapproved related resource override in ${array}: ${canonical(value)}`);
	}
	if ((settings.packages ?? []).some((value) => resourcePath(value, "packages", paths) === paths.release)) fail("Runtime package reference already exists without this migration journal");
	const deletions = removals.map((entry) => {
		const values = settings[entry.array] ?? [];
		if (count(values, entry.value) !== 1) fail(`Approved removal must occur exactly once in settings ${entry.array}: ${canonical(entry.value)}`);
		return { array: entry.array, value: structuredClone(entry.value), index: values.findIndex((value) => equal(value, entry.value)) };
	});
	return { additions: [{ array: "packages", value: paths.release }], deletions, packagesWasAbsent: settings.packages === undefined };
}
function forward(settings, delta) {
	const result = structuredClone(settings);
	for (const deletion of delta.deletions) {
		const values = result[deletion.array];
		const index = values.findIndex((value) => equal(value, deletion.value));
		values.splice(index, 1);
	}
	for (const addition of delta.additions) (result[addition.array] ??= []).push(addition.value);
	return result;
}
function inverse(settings, delta) {
	const result = structuredClone(settings);
	for (const addition of delta.additions) {
		const values = result[addition.array];
		values.splice(values.findIndex((value) => equal(value, addition.value)), 1);
	}
	// Insertion at the original index retains every concurrent unrelated entry and
	// its relative order. Never restore a snapshot of an entire resource array.
	for (const deletion of [...delta.deletions].sort((a, b) => a.index - b.index)) (result[deletion.array] ??= []).splice(deletion.index, 0, structuredClone(deletion.value));
	if (delta.packagesWasAbsent && result.packages.length === 0) delete result.packages;
	return result;
}
function classifySettings(settings, journal, paths) {
	settingsArrays(settings);
	const delta = journal.settings.delta;
	if (!delta) return "original";
	for (const array of ARRAYS) {
		for (const value of settings[array] ?? []) {
			if (related(value, array, paths, journal.directories) && !delta.deletions.some((entry) => entry.array === array && equal(entry.value, value))) fail(`Settings conflict: new or changed related override in ${array}: ${canonical(value)}`);
			if (array === "packages" && resourcePath(value, array, paths) === paths.release && !delta.additions.some((entry) => equal(entry.value, value))) fail("Settings conflict: runtime package reference changed");
		}
	}
	const isForward = delta.additions.every((entry) => count(settings[entry.array] ?? [], entry.value) === 1) && delta.deletions.every((entry) => count(settings[entry.array] ?? [], entry.value) === 0);
	const isOriginal = delta.additions.every((entry) => count(settings[entry.array] ?? [], entry.value) === 0) && delta.deletions.every((entry) => count(settings[entry.array] ?? [], entry.value) === 1);
	if (isForward && journal.settings.phase !== "pending") return "forward";
	if (isOriginal && (journal.settings.phase !== "applied" || journal.rollback?.settingsPhase === "planned" || journal.rollback?.settingsPhase === "applied")) return "original";
	fail("Settings conflict: migration entries are missing, duplicated, replaced, or only partially restored");
}

// Pi 1.0.0 uses proper-lockfile's default 10s stale / 5s heartbeat protocol.
// Keep that protocol, but yield during expensive work and independently verify
// ownership before mutations. The guarded fs adapter also prevents heartbeat,
// finally, and proper-lockfile's exit handler from touching a replacement lock.
async function transactionLock(file, retries = false) {
	const lockPath = `${file}.lock`;
	let owned, compromised;
	function lost(cause) {
		compromised ??= Object.assign(new Error(`Lock ownership lost/compromised: ${lockPath}`, { cause }), { code: "ECOMPROMISED" });
		return compromised;
	}
	function assertOwned() {
		if (compromised) throw compromised;
		let stat;
		try { stat = fs.lstatSync(lockPath); } catch (error) { throw lost(error); }
		if (!stat.isDirectory() || stat.dev !== owned.dev || stat.ino !== owned.ino || stat.mtimeMs !== owned.mtimeMs) throw lost();
		return stat;
	}
	const guardedFs = { ...fs,
		statSync(target) { return owned && target === lockPath ? assertOwned() : fs.statSync(target); },
		utimesSync(target, atime, mtime) {
			if (owned && target === lockPath) assertOwned();
			fs.utimesSync(target, atime, mtime);
			if (owned && target === lockPath) owned = fs.lstatSync(target);
		},
		rmdirSync(target) {
			if (owned && target === lockPath) {
				try { assertOwned(); } catch { return; } // Never delete a newer owner's lock.
			}
			fs.rmdirSync(target);
		},
	};
	let unlock;
	for (let attempt = 1; ; attempt++) {
		try {
			unlock = lockfile.lockSync(file, { realpath: false, fs: guardedFs, onCompromised: (error) => { lost(error); } });
			break;
		} catch (error) {
			if (!retries || error.code !== "ELOCKED" || attempt === 10) throw error;
			await delay(20);
		}
	}
	owned = fs.lstatSync(lockPath);
	return { assertOwned, release() {
		try { unlock(); } catch (error) { if (error.code !== "ERELEASED") throw error; }
	} };
}
function assertLocks(...locks) { for (const lock of locks) lock?.assertOwned(); }
async function syncDirectory(directory) {
	const descriptor = await fsp.open(directory, "r");
	try { await descriptor.sync(); } finally { await descriptor.close(); }
}
// Async byte writes/fsync are transaction seams; the final atomic metadata
// rename stays synchronous so no event-loop gap separates the ownership check
// and publication. Legacy sync operation adapters remain supported.
async function atomicWrite(file, bytes, operations, guard, preserveMode = false) {
	const temporary = `${file}.tmp-${randomUUID()}`;
	const mode = preserveMode ? (await fsp.lstat(file)).mode & 0o7777 : 0o600;
	try {
		guard();
		await (operations.writeFile ?? operations.writeFileSync ?? fsp.writeFile)(temporary, bytes, { flag: "wx", mode: 0o600 });
		if (preserveMode) await fsp.chmod(temporary, mode);
		const descriptor = await fsp.open(temporary, "r");
		try { await descriptor.sync(); } finally { await descriptor.close(); }
		guard();
		(operations.renameSync ?? fs.renameSync)(temporary, file);
		await syncDirectory(path.dirname(file));
		guard();
	} finally {
		await fsp.unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
	}
}
async function saveJournal(journal, paths, operations, guard) {
	await atomicWrite(paths.journalPath, `${JSON.stringify(journal, null, 2)}\n`, operations, guard);
}
async function move(from, to, operations, guard) {
	if (exists(to)) fail(`Directory collision: ${to}`);
	noSymlinkAncestors(from); noSymlinkAncestors(to);
	guard();
	(operations.renameSync ?? fs.renameSync)(from, to);
	await syncDirectory(path.dirname(from)); await syncDirectory(path.dirname(to));
	guard();
}
async function markFailure(journal, paths, operations, guard, error) {
	journal.lastError = { message: error.message, time: new Date().toISOString() };
	try { await saveJournal(journal, paths, operations, guard); } catch { /* earlier intent is already durable; never hide the original failure */ }
	error.message += `; recover with explicit rollback journal ${paths.journalPath}`;
}

function result(journal, state = journal.state) {
	return { state, journalPath: journal.paths.journalPath, directories: journal.directories.map(({ name, source, archive }) => ({ name, source, archive })), settingsDelta: journal.settings.delta };
}
async function readJournal(paths) {
	const journal = await readObject(paths.journalPath);
	if (journal.version !== 1 || !journal.paths || !equal(journal.paths, paths) || !["prepared", "migrating", "migrated", "rolling-back", "rolled-back"].includes(journal.state)) fail("Journal identity/path conflict; use the exact original --agent-dir, --release, and --backup-dir");
	if (!Array.isArray(journal.directories) || journal.directories.length !== OLD_DIRECTORIES.length || new Set(journal.directories.map((entry) => entry.name)).size !== OLD_DIRECTORIES.length) fail("Invalid journal directory identities");
	for (const entry of journal.directories) {
		if (!OLD_DIRECTORIES.includes(entry.name) || entry.source !== path.join(paths.discovery, entry.name) || entry.archive !== path.join(paths.backupDir, "directories", entry.name) || !/^[a-f0-9]{64}$/.test(entry.identity?.sha256 ?? "") || !Number.isSafeInteger(entry.identity.dev) || !Number.isSafeInteger(entry.identity.ino)) fail("Invalid journal directory identity or recovery path");
	}
	if (!journal.settings || !["pending", "planned", "applied"].includes(journal.settings.phase)) fail("Invalid journal settings state");
	if (!journal.settings.delta || journal.settings.deltaHash !== digest(canonical(journal.settings.delta))) fail("Journal settings inverse integrity conflict");
	{
		const delta = journal.settings.delta;
		if (!equal(delta.additions, [{ array: "packages", value: paths.release }]) || !Array.isArray(delta.deletions)) fail("Invalid journal settings inverse");
		for (const entry of delta.deletions) {
			validateRemoval(entry, paths, journal.directories);
			if (!Number.isSafeInteger(entry.index) || entry.index < 0) fail("Invalid journal settings insertion index");
		}
		if (new Set(delta.deletions.map((entry) => canonical([entry.array, entry.value]))).size !== delta.deletions.length) fail("Duplicate journal inverse");
	}
	return journal;
}
async function directoryStates(journal) {
	const states = [];
	for (const entry of journal.directories) {
		const atSource = exists(entry.source);
		const atArchive = exists(entry.archive);
		if (atSource === atArchive) fail(`Directory collision/identity conflict: exactly one original or archived directory must exist: ${entry.name}`);
		await verifyIdentity(atSource ? entry.source : entry.archive, entry.identity);
		states.push({ entry, archived: atArchive });
	}
	return states;
}

/** First migration. Never kills workers, scans sessions, or infers other instances' state. */
export async function migrate(options, dependencies = {}) {
	const paths = resolveOptions(options);
	if (exists(paths.backupDir)) {
		if (!exists(paths.journalPath)) fail(`Backup directory already exists (collision): ${paths.backupDir}`);
		const journalLock = await transactionLock(paths.journalPath);
		let settingsLock;
		try {
			const journal = await readJournal(paths);
			if (journal.state !== "migrated") fail(`Existing incomplete/rolled-back migration: use explicit rollback or a new backup directory: ${paths.journalPath}`);
			await validateRuntime(paths.release, dependencies);
			settingsLock = await transactionLock(paths.settingsPath, true);
			if (classifySettings(await readObject(paths.settingsPath), journal, paths) !== "forward" || (await directoryStates(journal)).some(({ archived }) => !archived)) fail("Completed migration identity conflict");
			assertLocks(settingsLock, journalLock);
			return result(journal, options.dryRun ? "dry-run" : "migrated");
		} finally {
			try { settingsLock?.release(); } finally { journalLock.release(); }
		}
	}
	// All validation and collision checks precede creating a backup or moving data.
	await readObject(paths.settingsPath);
	const approved = await approvalFor(options, paths);
	await validateRuntime(paths.release, dependencies);
	if (!fs.lstatSync(path.dirname(paths.backupDir)).isDirectory()) fail("Backup parent must already exist");
	const backupDevice = fs.lstatSync(path.dirname(paths.backupDir)).dev;
	if (approved.directories.some(({ identity: value }) => value.dev !== backupDevice)) fail("Backup must be on the same filesystem for atomic directory renames");
	const previewDelta = makeDelta(await readObject(paths.settingsPath), approved.approval.removals, paths, approved.directories);
	const preview = { version: 1, state: "prepared", paths, directories: approved.directories, settings: { phase: "pending", delta: previewDelta, deltaHash: digest(canonical(previewDelta)) } };
	if (options.dryRun) return result(preview, "dry-run");
	const settingsLock = await transactionLock(paths.settingsPath, true);
	let journalLock;
	let journal;
	const guard = () => assertLocks(settingsLock, journalLock);
	try {
		const current = await readObject(paths.settingsPath); // authoritative reread inside Pi's lock
		const delta = makeDelta(current, approved.approval.removals, paths, approved.directories);
		for (const directory of approved.directories) await verifyIdentity(directory.source, directory.identity);
		guard();
		fs.mkdirSync(paths.backupDir, { mode: 0o700 });
		await syncDirectory(path.dirname(paths.backupDir));
		guard();
		journalLock = await transactionLock(paths.journalPath);
		journal = { ...preview, id: randomUUID(), startedAt: new Date().toISOString(), settings: { phase: "pending", delta, deltaHash: digest(canonical(delta)) } };
		await saveJournal(journal, paths, dependencies, guard);
		guard();
		fs.mkdirSync(path.join(paths.backupDir, "directories"), { mode: 0o700 });
		await atomicWrite(path.join(paths.backupDir, "settings.before.json"), await fsp.readFile(paths.settingsPath), dependencies, guard);
		await atomicWrite(path.join(paths.backupDir, "approved-evidence.json"), `${JSON.stringify(approved.approval, null, 2)}\n`, dependencies, guard);
		journal.state = "migrating";
		await saveJournal(journal, paths, dependencies, guard);
		for (const directory of journal.directories) {
			await verifyIdentity(directory.source, directory.identity);
			directory.phase = "moving";
			await saveJournal(journal, paths, dependencies, guard);
			await move(directory.source, directory.archive, dependencies, guard);
			directory.phase = "archived";
			await saveJournal(journal, paths, dependencies, guard);
		}
		journal.settings.phase = "planned";
		await saveJournal(journal, paths, dependencies, guard);
		await atomicWrite(paths.settingsPath, `${JSON.stringify(forward(current, delta), null, 2)}\n`, dependencies, guard, true);
		journal.settings.phase = "applied";
		journal.state = "migrated";
		journal.completedAt = new Date().toISOString();
		await saveJournal(journal, paths, dependencies, guard);
		return result(journal);
	} catch (error) {
		if (journal) await markFailure(journal, paths, dependencies, guard, error);
		throw error;
	} finally {
		try { journalLock?.release(); } finally { settingsLock.release(); }
	}
}

/** Conditional inverse, including recovery of interrupted intent/completion writes. */
export async function rollback(options, dependencies = {}) {
	const paths = resolveOptions(options);
	const journalPath = absolute(options.journalPath, "journalPath / --journal");
	if (journalPath !== paths.journalPath) fail("Explicit journal must be backupDir/journal.json");
	regularFile(paths.journalPath);
	const journalLock = await transactionLock(paths.journalPath);
	let settingsLock;
	let journal;
	const guard = () => assertLocks(settingsLock, journalLock);
	try {
		journal = await readJournal(paths);
		// Validate every directory and settings inverse before a single restore.
		const states = await directoryStates(journal);
		settingsLock = await transactionLock(paths.settingsPath, true);
		const current = await readObject(paths.settingsPath);
		const classification = classifySettings(current, journal, paths);
		guard();
		if (journal.state === "rolled-back") {
			if (classification !== "original" || states.some(({ archived }) => archived)) fail("Rolled-back journal identity conflict");
			return result(journal, options.dryRun ? "dry-run" : "rolled-back");
		}
		if (options.dryRun) return result(journal, "dry-run");
		journal.state = "rolling-back";
		journal.rollback ??= { settingsPhase: "pending" };
		await saveJournal(journal, paths, dependencies, guard);
		for (const { entry, archived } of states) {
			if (!archived) continue;
			await verifyIdentity(entry.archive, entry.identity);
			entry.phase = "restoring";
			await saveJournal(journal, paths, dependencies, guard);
			await move(entry.archive, entry.source, dependencies, guard);
			entry.phase = "restored";
			await saveJournal(journal, paths, dependencies, guard);
		}
		journal.rollback.settingsPhase = "planned";
		await saveJournal(journal, paths, dependencies, guard);
		if (classification === "forward") await atomicWrite(paths.settingsPath, `${JSON.stringify(inverse(current, journal.settings.delta), null, 2)}\n`, dependencies, guard, true);
		journal.rollback.settingsPhase = "applied";
		journal.state = "rolled-back";
		journal.rolledBackAt = new Date().toISOString();
		await saveJournal(journal, paths, dependencies, guard);
		return result(journal);
	} catch (error) {
		// Conflicts in preflight are read-only: don't change the journal on refusal.
		if (journal?.state === "rolling-back" && !options.dryRun) await markFailure(journal, paths, dependencies, guard, error);
		throw error;
	} finally {
		try { settingsLock?.release(); } finally { journalLock.release(); }
	}
}
