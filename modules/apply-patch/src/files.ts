import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { applyUpdate, parsePatch } from "./patch.ts";

export const MAX_PATCH_BYTES = 1024 * 1024;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_PATHS = 128;

export type FileLock = <T>(path: string, action: () => Promise<T>) => Promise<T>;
export interface Change {
	kind: "add" | "update" | "delete";
	path: string;
	moveFrom?: string;
}
/** Immutable text captured by the commit, never re-read for presentation. */
export interface ChangeSnapshot extends Change {
	before: string | null;
	after: string | null;
	sourceBefore?: string;
}
export interface PatchOutcome {
	changes: Change[];
	snapshots: ChangeSnapshot[];
}
interface FileState {
	original: string | null;
	next: string | null;
	mode?: number;
}
interface ApplyOptions {
	signal?: AbortSignal;
	withFileLock?: FileLock;
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function canonicalDirectory(path: string): Promise<string> {
	try {
		const actual = await realpath(path);
		if (!(await lstat(actual)).isDirectory()) throw new Error(`Not a directory: ${path}`);
		return actual;
	} catch (error) {
		if (!isMissing(error) || dirname(path) === path) throw error;
		return join(await canonicalDirectory(dirname(path)), basename(path));
	}
}

// Resolve directory aliases before locking, but don't replace a file-level
// symlink with a regular file or accidentally unlink its target.
async function canonicalTarget(path: string): Promise<string> {
	const actual = join(await canonicalDirectory(dirname(path)), basename(path));
	const existing = await checkFile(actual);
	// realpath also canonicalizes the file's case on case-insensitive volumes.
	return existing ? realpath(actual) : actual;
}

async function checkFile(path: string) {
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink()) throw new Error(`File symlinks are not supported: ${path}`);
		if (!info.isFile()) throw new Error(`Not a regular file: ${path}`);
		if (info.nlink > 1) throw new Error(`Hard-linked files are not supported: ${path}`);
		if (info.size > MAX_FILE_BYTES) throw new Error(`File exceeds the 10 MiB limit: ${path}`);
		return info;
	} catch (error) {
		if (isMissing(error)) return null;
		throw error;
	}
}

async function loadFile(path: string): Promise<FileState> {
	const info = await checkFile(path);
	if (!info) return { original: null, next: null };
	const bytes = await readFile(path);
	if (bytes.length > MAX_FILE_BYTES) throw new Error(`File exceeds the 10 MiB limit: ${path}`);
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		throw new Error(`File is not valid UTF-8: ${path}`);
	}
	if (text.includes("\0")) throw new Error(`Binary files are not supported: ${path}`);
	return { original: text, next: text, mode: info.mode & 0o777 };
}

async function writeAtomically(path: string, state: FileState, signal?: AbortSignal): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	// Short basename also works for files whose own name is near NAME_MAX.
	const temporary = join(dirname(path), `.pi-patch-${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, state.next!, { encoding: "utf8", flag: "wx", mode: state.mode ?? 0o666 });
		if (state.mode !== undefined) await chmod(temporary, state.mode);
		signal?.throwIfAborted();
		await rename(temporary, path);
	} finally {
		await unlink(temporary).catch((error: unknown) => {
			if (!isMissing(error)) throw error;
		});
	}
}

/** Describe the final disk delta, not intermediate hunks that may cancel out. */
function summarizeChanges(files: Map<string, FileState>, paths: Map<string, string>, moves: Map<string, Change>): Change[] {
	const pending = new Set([...files].filter(([, state]) => state.original !== state.next).map(([path]) => path));
	const survivingMoves = new Map<string, Change>();
	// Preserve move notation only when its source is actually deleted and its
	// destination survives. Earlier/transient moves fall back to per-file deltas.
	for (const move of [...moves.values()].reverse()) {
		const source = paths.get(move.moveFrom!)!;
		const target = paths.get(move.path)!;
		if (pending.has(source) && files.get(source)!.next === null &&
				files.get(target)!.next !== null && !survivingMoves.has(target)) {
			survivingMoves.set(target, move);
			pending.delete(source);
			pending.delete(target);
		}
	}
	const changes: Change[] = [];
	// paths retains first-seen patch order and display names; canonical paths
	// deduplicate aliases without leaking them into the user-facing result.
	for (const [display, path] of paths) {
		const move = survivingMoves.get(path);
		if (move) {
			changes.push(move);
			survivingMoves.delete(path);
		} else if (pending.delete(path)) {
			const state = files.get(path)!;
			const kind = state.next === null ? "delete" : state.original === null ? "add" : "update";
			changes.push({ kind, path: display });
		}
	}
	return changes;
}

/** Compatibility API: return only the final file-operation summary. */
export async function applyPatch(input: string, cwd: string, options: ApplyOptions = {}): Promise<Change[]> {
	return (await applyPatchWithSnapshots(input, cwd, options)).changes;
}

/**
 * Validate before writing, and capture successful commits under the same locks.
 * Disk failures remain non-transactional and throw with completed-path diagnostics.
 */
export async function applyPatchWithSnapshots(input: string, cwd: string, options: ApplyOptions = {}): Promise<PatchOutcome> {
	const { signal } = options;
	signal?.throwIfAborted();
	if (Buffer.byteLength(input, "utf8") > MAX_PATCH_BYTES) throw new Error("Patch exceeds the 1 MiB limit");
	if (input.includes("\0")) throw new Error("Patch must not contain NUL bytes");
	const hunks = parsePatch(input);
	if (hunks.length === 0) throw new Error("No files were modified: the patch contains no file operations");
	const rawPaths = [...new Set(hunks.flatMap((hunk) =>
		hunk.type === "update" && hunk.moveTo ? [hunk.path, hunk.moveTo] : [hunk.path],
	))];
	if (rawPaths.length > MAX_PATHS) throw new Error(`Patch exceeds the ${MAX_PATHS}-path limit`);
	const paths = new Map<string, string>();
	for (const path of rawPaths) {
		signal?.throwIfAborted();
		paths.set(path, await canonicalTarget(resolve(cwd, path)));
	}
	const lockPaths = [...new Set(paths.values())].sort();
	const lock: FileLock = options.withFileLock ?? (async (_path, action) => action());

	async function withLocks(index: number): Promise<PatchOutcome> {
		signal?.throwIfAborted();
		if (index < lockPaths.length) return lock(lockPaths[index], () => withLocks(index + 1));
		const files = new Map<string, FileState>();
		let totalBytes = 0;
		for (const path of lockPaths) {
			signal?.throwIfAborted();
			const state = await loadFile(path);
			totalBytes += Buffer.byteLength(state.original ?? "", "utf8");
			if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Patch targets exceed the 32 MiB combined input limit");
			files.set(path, state);
		}

		// Track the last surviving move into each canonical destination. Updates
		// keep its provenance; replacement by Add/Delete/another Move invalidates it.
		const moves = new Map<string, Change>();
		for (const hunk of hunks) {
			const path = paths.get(hunk.path)!;
			const state = files.get(path)!;
			if (hunk.type === "add") {
				state.next = hunk.content;
				moves.delete(path);
			} else {
				if (state.next === null) throw new Error(`File does not exist: ${hunk.path}`);
				if (hunk.type === "delete") {
					state.next = null;
					moves.delete(path);
				} else {
					const next = applyUpdate(state.next, hunk.chunks, hunk.path);
					const target = paths.get(hunk.moveTo ?? hunk.path)!;
					if (target !== path) {
						const destination = files.get(target)!;
						destination.next = next;
						destination.mode ??= state.mode;
						state.next = null;
						moves.delete(path);
						moves.delete(target);
						moves.set(target, { kind: "update", path: hunk.moveTo!, moveFrom: hunk.path });
					} else {
						state.next = next;
					}
				}
			}
		}
		// File/descendant combinations require directory mutations and cannot be
		// safely represented by this text-only patch plan.
		for (let i = 0; i < lockPaths.length; i++) {
			const path = lockPaths[i];
			for (const other of lockPaths.slice(i + 1)) {
				if (other.startsWith(path + sep)) {
					throw new Error(`Conflicting file and descendant paths: ${path}, ${other}`);
				}
			}
		}
		for (const [path, state] of files) {
			if (state.next !== null && Buffer.byteLength(state.next, "utf8") > MAX_FILE_BYTES) {
				throw new Error(`Patched file exceeds the 10 MiB limit: ${path}`);
			}
			// Atomic rename must not silently bypass an existing file's write protection.
			if (state.original !== null && state.next !== null && state.next !== state.original) {
				await access(path, constants.W_OK);
			}
		}

		const completed: string[] = [];
		let current = "";
		try {
			// Write move destinations before deleting sources. Each replacement is
			// atomic, but a multi-file patch deliberately has no rollback machinery.
			for (const [path, state] of files) {
				if (state.next === null || state.next === state.original) continue;
				current = path;
				signal?.throwIfAborted();
				await writeAtomically(path, state, signal);
				completed.push(path);
			}
			for (const [path, state] of files) {
				if (state.next !== null || state.original === null) continue;
				current = path;
				signal?.throwIfAborted();
				await unlink(path);
				completed.push(path);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = signal?.aborted && error === signal.reason;
			if (aborted && completed.length === 0) {
				throw new Error(`Patch aborted before any file replacements or deletions were committed: ${message}`, { cause: error });
			}
			throw new Error(`Patch ${aborted ? "aborted" : "failed"} at ${JSON.stringify(current)}: ${message}\n` +
				`Completed file operations: ${JSON.stringify(completed)}. No automatic rollback was performed.`, { cause: error });
		}
		const changes = summarizeChanges(files, paths, moves);
		const snapshots: ChangeSnapshot[] = changes.map((change) => {
			const state = files.get(paths.get(change.path)!)!;
			return {
				...change,
				before: state.original,
				after: state.next,
				...(change.moveFrom === undefined ? {} : {
					sourceBefore: files.get(paths.get(change.moveFrom)!)!.original!,
				}),
			};
		});
		return { changes, snapshots };
	}
	return withLocks(0);
}
