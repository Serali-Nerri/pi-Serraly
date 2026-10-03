import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type DirSource = "session" | "project" | "global";

export interface AddedDir {
	absolutePath: string;
	label: string;
}

export interface ScopedDir extends AddedDir {
	source: DirSource;
	storedPath: string;
	inactiveReason?: string;
}

export interface ParsedAddArgs {
	source: DirSource;
	path: string;
}

export const DIR_ADD_USAGE = "Usage: /dir-add [--project | --global] <path>";

const CONTROL_CHARACTERS = /[\p{Cc}\u2028\u2029]/u;

function isMissingPathError(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) return false;
	return error.code === "ENOENT" || error.code === "ENOTDIR";
}

/**
 * Terminals act on control characters (including ESC and the C1 range) and on the Unicode
 * line and paragraph separators, so those may never reach a stored path or a rendered label.
 * Every other category stays supported: joined-emoji names (ZWJ), private-use glyphs and
 * combining marks are ordinary file names.
 */
export function hasUnsafeCharacters(value: string): boolean {
	return CONTROL_CHARACTERS.test(value);
}

export function expandUserPath(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/") || input.startsWith(`~${sep}`)) return join(homedir(), input.slice(2));
	return input;
}

/** Resolve a user path to a canonical absolute path; missing paths stay resolvable for diagnostics. */
export function resolveDir(input: string, cwd: string): string {
	const expanded = expandUserPath(input);
	const resolved = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
	try {
		return realpathSync(resolved);
	} catch (error) {
		if (isMissingPathError(error)) return resolve(resolved);
		throw error;
	}
}

/** Compare a previously stored reference without letting an unrelated unreadable path abort the operation. */
export function matchesStoredPath(storedPath: string, absolutePath: string, cwd: string): boolean {
	if (storedPath === absolutePath) return true;
	try {
		return resolveDir(storedPath, cwd) === absolutePath;
	} catch {
		return false;
	}
}

export function dirExists(dir: string): boolean {
	try {
		return statSync(dir).isDirectory();
	} catch (error) {
		if (isMissingPathError(error)) return false;
		throw error;
	}
}

export function isWithinDir(dir: string, candidate: string): boolean {
	const relativePath = relative(dir, candidate);
	return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}

export function parseAddArgs(args: string | undefined): ParsedAddArgs {
	const input = args?.trim() ?? "";
	if (!input) return { source: "session", path: "" };
	for (const source of ["project", "global"] as const) {
		const flag = `--${source}`;
		if (input === flag) return { source, path: "" };
		if (input.startsWith(`${flag} `)) return { source, path: input.slice(flag.length).trim() };
	}
	if (input.startsWith("--")) throw new Error(DIR_ADD_USAGE);
	return { source: "session", path: input };
}

export function validateStoredPaths(paths: readonly string[], source: DirSource): void {
	if (paths.some((path) => typeof path !== "string" || !isAbsolute(path) || hasUnsafeCharacters(path))) {
		throw new Error(`Invalid ${source} pi-add-dir configuration: expected absolute paths.`);
	}
}

/**
 * A directory named `.git` is only a repository marker when it is a git directory
 * (contains `HEAD`) or a gitfile; stray directories must not be mistaken for repos.
 */
function isGitMarker(marker: string): boolean {
	const stat = statSync(marker, { throwIfNoEntry: false });
	if (stat?.isDirectory()) return statSync(join(marker, "HEAD"), { throwIfNoEntry: false })?.isFile() ?? false;
	if (!stat?.isFile()) return false;
	try {
		return readFileSync(marker, "utf8").startsWith("gitdir:");
	} catch {
		return false;
	}
}

/** Distinguishes an absent repository from an unreadable one without spawning Git twice. */
export function hasGitMarker(cwd: string): boolean {
	let directory = resolveDir(cwd, cwd);
	while (true) {
		if (isGitMarker(join(directory, ".git"))) return true;
		const parent = dirname(directory);
		if (parent === directory) return false;
		directory = parent;
	}
}

export interface ScopedDirectorySnapshot {
	managedDirs: ScopedDir[];
	addedDirs: ScopedDir[];
	/** Stored directories that were deactivated, reported once for diagnostics. */
	skipped: ScopedDir[];
}

export interface ScopeInput {
	cwd: string;
	sessionDirs: readonly AddedDir[];
	projectPaths: readonly string[];
	globalPaths: readonly string[];
}

/**
 * Single owner of scope precedence: session copies win, persistent duplicates and
 * nested entries are preserved but marked inactive rather than corrected.
 */
export function mergeScopedDirs(input: ScopeInput): ScopedDirectorySnapshot {
	const cwdPath = resolveDir(input.cwd, input.cwd);
	const managedDirs: ScopedDir[] = [];
	const addedDirs: ScopedDir[] = [];
	const skipped: ScopedDir[] = [];

	for (const dir of input.sessionDirs) {
		let absolutePath = dir.absolutePath;
		let inactiveReason: string | undefined;
		try {
			absolutePath = resolveDir(dir.absolutePath, input.cwd);
		} catch (error) {
			inactiveReason = error instanceof Error ? error.message : String(error);
		}
		if (addedDirs.some((existing) => existing.absolutePath === absolutePath)) continue;
		if (!inactiveReason && hasUnsafeCharacters(absolutePath)) inactiveReason = "path contains unsafe characters";
		const scoped = {
			absolutePath,
			label: basename(absolutePath) || absolutePath,
			source: "session",
			storedPath: dir.absolutePath,
			...(inactiveReason ? { inactiveReason } : {}),
		} satisfies ScopedDir;
		managedDirs.push(scoped);
		if (scoped.inactiveReason) skipped.push(scoped);
		else addedDirs.push(scoped);
	}

	for (const [source, paths] of [
		["project", input.projectPaths],
		["global", input.globalPaths],
	] as const) {
		for (const storedPath of paths) {
			let absolutePath = storedPath;
			let inactiveReason: string | undefined;
			try {
				absolutePath = resolveDir(storedPath, input.cwd);
				if (!dirExists(absolutePath)) inactiveReason = "directory does not exist";
			} catch (error) {
				inactiveReason = error instanceof Error ? error.message : String(error);
			}
			const duplicate = addedDirs.find((dir) => dir.absolutePath === absolutePath);
			// A clean stored spelling can still canonicalize through a link into an unsafe name;
			// such a directory is never activated, injected, or rendered unescaped.
			if (!inactiveReason && hasUnsafeCharacters(absolutePath)) inactiveReason = "path contains unsafe characters";
			if (!inactiveReason && duplicate) inactiveReason = `shadowed by ${duplicate.source} scope`;
			if (!inactiveReason && (isWithinDir(cwdPath, absolutePath) || isWithinDir(absolutePath, cwdPath))) {
				inactiveReason = "overlaps current working directory scope";
			}
			const overlap = !inactiveReason
				? addedDirs.find(
						(dir) => isWithinDir(dir.absolutePath, absolutePath) || isWithinDir(absolutePath, dir.absolutePath),
					)
				: undefined;
			if (overlap) inactiveReason = `overlaps ${overlap.source} directory ${overlap.absolutePath}`;
			const scoped = {
				absolutePath,
				label: basename(absolutePath) || absolutePath,
				source,
				storedPath,
				...(inactiveReason ? { inactiveReason } : {}),
			} satisfies ScopedDir;
			managedDirs.push(scoped);
			if (inactiveReason) skipped.push(scoped);
			else addedDirs.push(scoped);
		}
	}

	return { managedDirs, addedDirs, skipped };
}

export function directoryKey(dir: { source: DirSource; absolutePath: string }): string {
	return `${dir.source}\0${dir.absolutePath}`;
}
