import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createConfigStore } from "@henryqw/pi-config-store";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { hasUnsafeCharacters, hasGitMarker, validateStoredPaths, type AddedDir } from "./directories.ts";

export const STATE_TYPE = "add-dir:state";
export const PROJECT_CONFIG_KEY = "pi-add-dir.directory";
export const PROJECT_CONFIG_RETRIES = 3;
export const GIT_TIMEOUT_MS = 10_000;

export type ExecLike = (
	command: string,
	args: string[],
	options?: { cwd?: string; signal?: AbortSignal; timeout?: number },
) => Promise<ExecResult>;

export function isAddedDir(value: unknown): value is AddedDir {
	if (!value || typeof value !== "object") return false;
	const dir = value as Partial<AddedDir>;
	return (
		typeof dir.absolutePath === "string" &&
		isAbsolute(dir.absolutePath) &&
		!hasUnsafeCharacters(dir.absolutePath) &&
		typeof dir.label === "string" &&
		!hasUnsafeCharacters(dir.label)
	);
}

export function readSessionDirs(data: unknown): AddedDir[] {
	if (!data || typeof data !== "object") return [];
	const dirs = (data as { dirs?: unknown }).dirs;
	return Array.isArray(dirs) ? dirs.filter(isAddedDir) : [];
}

function isStateEntry(value: unknown): value is { customType: string; data: unknown } {
	if (!value || typeof value !== "object") return false;
	const entry = value as { type?: unknown; customType?: unknown };
	return entry.type === "custom" && typeof entry.customType === "string";
}

/**
 * Only the deepest state entry on the active branch describes this session; abandoned
 * branches must never contribute directories.
 */
export function latestSessionDirs(branch: readonly unknown[]): AddedDir[] {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (isStateEntry(entry) && entry.customType === STATE_TYPE) return readSessionDirs(entry.data);
	}
	return [];
}

export interface AddDirConfig {
	directories: string[];
}

export function parseAddDirConfig(value: unknown): AddDirConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid pi-add-dir config: expected an object.");
	}
	const config = value as Record<string, unknown>;
	if (Object.keys(config).length !== 1 || !Array.isArray(config.directories)) {
		throw new Error('Invalid pi-add-dir config: expected only a "directories" array.');
	}
	const directories = config.directories;
	if (directories.some((directory) => typeof directory !== "string" || !isAbsolute(directory) || hasUnsafeCharacters(directory))) {
		throw new Error("Invalid pi-add-dir config: directories must be absolute paths without control characters.");
	}
	if (new Set(directories).size !== directories.length) {
		throw new Error("Invalid pi-add-dir config: directories must be unique.");
	}
	return { directories: [...directories] };
}

export function createAddDirConfigStore(agentDir?: string) {
	return createConfigStore<AddDirConfig>({
		extensionId: "pi-add-dir",
		agentDir,
		defaults: () => ({ directories: [] }),
		parse: parseAddDirConfig,
	});
}

export async function readProjectPaths(
	exec: ExecLike,
	cwd: string,
	required: boolean,
	signal?: AbortSignal,
): Promise<string[]> {
	const probe = await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd, signal, timeout: GIT_TIMEOUT_MS });
	if (probe.killed) throw new Error("Git repository check was interrupted.");
	if (probe.code !== 0 || probe.stdout.trim() !== "true") {
		if (hasGitMarker(cwd)) {
			throw new Error(`Cannot inspect Git repository: ${probe.stderr.trim() || `git exited ${probe.code}`}`);
		}
		if (required) throw new Error("Project-persistent directories require a Git repository.");
		return [];
	}
	const result = await exec("git", ["config", "--local", "-z", "--get-all", PROJECT_CONFIG_KEY], {
		cwd,
		signal,
		timeout: GIT_TIMEOUT_MS,
	});
	if (result.killed) throw new Error("Reading project pi-add-dir configuration was interrupted.");
	if (result.code === 1 && result.stdout.length === 0) return [];
	if (result.code !== 0) {
		throw new Error(`Cannot read project pi-add-dir configuration: ${result.stderr.trim() || `git exited ${result.code}`}`);
	}
	const paths = result.stdout.split("\0").filter((path) => path.length > 0);
	validateStoredPaths(paths, "project");
	return [...new Set(paths)];
}

export async function mutateProjectConfig(
	exec: ExecLike,
	args: string[],
	cwd: string,
	action: string,
	signal?: AbortSignal,
	canStart?: () => boolean,
): Promise<void> {
	for (let attempt = 0; attempt < PROJECT_CONFIG_RETRIES; attempt += 1) {
		// A retry after lock contention is a new write attempt: a command that went stale while
		// waiting must not launch one.
		if (canStart && !canStart()) throw new Error(`Cannot ${action}: the session changed before the write started.`);
		const result = await exec("git", ["config", "--local", ...args], { cwd, signal, timeout: GIT_TIMEOUT_MS });
		if (!result.killed && result.code === 0) return;
		const lockContention = /could not lock config file|unable to create .*\.lock/i.test(result.stderr);
		if (result.killed || !lockContention || attempt === PROJECT_CONFIG_RETRIES - 1) {
			throw new Error(`Cannot ${action}: ${result.stderr.trim() || "git config was interrupted"}`);
		}
		await delay(25 * (attempt + 1));
	}
}
