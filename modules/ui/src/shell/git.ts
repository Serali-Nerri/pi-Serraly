import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitCommitInfo {
	oid: string | null;
	detached: boolean;
	tag: string | null;
}

export interface GitStatus {
	branch: string | undefined;
	ahead: number;
	behind: number;
	modified: number;
	untracked: number;
	staged: number;
	stashed: number;
	conflicted: number;
	renamed: number;
	deleted: number;
	commit: GitCommitInfo | null;
}

export function emptyGitStatus(): GitStatus {
	return {
		branch: undefined,
		ahead: 0,
		behind: 0,
		modified: 0,
		untracked: 0,
		staged: 0,
		stashed: 0,
		conflicted: 0,
		renamed: 0,
		deleted: 0,
		commit: null,
	};
}

async function gitExec(args: string[], cwd: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("git", args, {
			cwd,
			timeout: 2000,
			maxBuffer: 1024 * 1024,
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
		});
		return stdout;
	} catch {
		return null;
	}
}

export function parseGitStatus(output: string, readCounts = true): GitStatus {
	const status = emptyGitStatus();
	let oid: string | null = null;
	let detached = false;
	const records = output.split("\0");
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (record.startsWith("# branch.head ")) {
			const head = record.slice(14);
			detached = head === "(detached)";
			if (!detached) status.branch = head;
		} else if (record.startsWith("# branch.oid ")) {
			const value = record.slice(13);
			oid = value === "(initial)" ? null : value;
		} else if (record.startsWith("# branch.ab ")) {
			const match = record.match(/\+(\d+) -(\d+)/);
			if (match) {
				status.ahead = Number(match[1]);
				status.behind = Number(match[2]);
			}
		} else if (record.startsWith("# stash ")) {
			status.stashed = Number(record.slice(8)) || 0;
		} else if (record.startsWith("2 ") || record.startsWith("1 ")) {
			const xy = record.split(" ", 2)[1];
			if (record.startsWith("2 ")) index++; // The original rename path is a separate NUL record.
			if (!readCounts) continue;
			if (xy.includes("R")) status.renamed++;
			else if (xy.includes("D")) status.deleted++;
			else {
				if (xy[0] !== ".") status.staged++;
				if (xy[1] === "M" || xy[1] === "T") status.modified++;
			}
		} else if (readCounts && record.startsWith("u ")) {
			status.conflicted++;
		} else if (readCounts && record.startsWith("? ")) {
			status.untracked++;
		}
	}
	status.commit = { oid, detached, tag: null };
	return status;
}

export async function readGitStatus(
	cwd: string,
	options: { readCommit?: boolean; readTag?: boolean; readCounts?: boolean } = {},
): Promise<GitStatus> {
	const output = await gitExec(["status", "--porcelain=v2", "--branch", "--show-stash", "-z"], cwd);
	if (output === null) return emptyGitStatus();
	const status = parseGitStatus(output, options.readCounts !== false);
	if (options.readCommit && options.readTag && status.commit?.detached) {
		const tag = await gitExec(["describe", "--tags", "--exact-match", "HEAD"], cwd);
		status.commit.tag = tag?.trim() || null;
	}
	return status;
}
