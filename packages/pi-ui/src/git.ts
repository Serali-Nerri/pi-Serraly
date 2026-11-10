import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 2_000;

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
	commit: { oid: string | null } | null;
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

async function gitExec(args: string[], cwd: string, signal: AbortSignal): Promise<string | null> {
	if (signal.aborted) return null;
	const result = await execFileAsync("git", ["--no-optional-locks", ...args], {
		cwd,
		signal,
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: 1024 * 1024,
		env: { ...process.env, LC_ALL: "C" },
	}).catch(() => undefined);
	return result?.stdout ?? null;
}

export async function readGitStatus(cwd: string, signal: AbortSignal): Promise<GitStatus> {
	const stdout = await gitExec(["status", "--porcelain=v1", "--branch"], cwd, signal);
	const status = emptyGitStatus();
	if (stdout === null) return status;

	for (const line of stdout.split("\n")) {
		if (line.startsWith("## ")) {
			const branchPart = line.slice(3);
			if (branchPart.startsWith("HEAD (no branch)")) {
				status.commit = { oid: null };
			} else {
				const branchMatch = branchPart.match(/^(\S+?)(?:\.\.\.(\S+))?(?:\s+\[(.*)\])?$/);
				if (branchMatch) {
					status.branch = stripTerminalSequences(branchMatch[1]!)
						.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
					const ahead = branchMatch[3]?.match(/\bahead (\d+)\b/);
					const behind = branchMatch[3]?.match(/\bbehind (\d+)\b/);
					if (ahead) status.ahead = Number.parseInt(ahead[1]!, 10);
					if (behind) status.behind = Number.parseInt(behind[1]!, 10);
				}
			}
			continue;
		}

		if (line.length < 3) continue;
		const x = line[0]!;
		const y = line[1]!;
		if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
			status.conflicted++;
		} else if (x === "?" && y === "?") {
			status.untracked++;
		} else if (x === "R") {
			status.renamed++;
			if (y === "M") status.modified++;
			else if (y === "D") status.deleted++;
		} else if (x === "D" || y === "D") {
			status.deleted++;
		} else {
			if (x !== " " && x !== "?") status.staged++;
			if (y === "M" || y === "D") status.modified++;
		}
	}

	const stashOut = await gitExec(["stash", "list", "--format=%H"], cwd, signal);
	if (stashOut !== null) {
		status.stashed = stashOut.split("\n").filter((line) => line.trim() !== "").length;
	}
	if (status.commit) {
		const oid = await gitExec(["rev-parse", "HEAD"], cwd, signal);
		if (oid) status.commit.oid = oid.trim();
	}
	return status;
}

function gitGlyphs() {
	const locale = [process.env["LC_ALL"], process.env["LC_CTYPE"], process.env["LANG"]].find(Boolean);
	if (process.env["TERM"] === "dumb" || process.stdout.isTTY !== true || (locale && !/utf-?8/i.test(locale))) {
		return { git: "*", ahead: "^", behind: "v", diverged: "^v", stashed: "S", staged: "A", renamed: "r", deleted: "x" };
	}
	if (process.env["SSH_TTY"] || process.env["SSH_CONNECTION"]) {
		return { git: "🌿", ahead: "↑", behind: "↓", diverged: "↕", stashed: "$", staged: "+", renamed: "→", deleted: "✗" };
	}
	return { git: "", ahead: "↑", behind: "↓", diverged: "⇕", stashed: "$", staged: "+", renamed: "»", deleted: "✘" };
}

export function renderGitStatus(theme: Theme, git: GitStatus): string {
	const glyphs = gitGlyphs();
	const parts: string[] = [];
	if (git.branch) {
		parts.push(theme.fg("mdLink", glyphs.git));
		parts.push(theme.fg("mdLink", truncateToWidth(git.branch, 20, "...")));
	} else if (git.commit) {
		parts.push(theme.fg("warning", glyphs.git), theme.fg("warning", "HEAD"));
		if (git.commit.oid) parts.push(theme.fg("dim", git.commit.oid.slice(0, 7)));
	}

	const icons: string[] = [];
	const addStatus = (count: number, glyph: string, color: ThemeColor): void => {
		if (count > 0) icons.push(theme.fg(color, `${glyph}${count}`));
	};
	addStatus(git.conflicted, "=", "error");
	addStatus(git.deleted, glyphs.deleted, "error");
	addStatus(git.modified, "!", "warning");
	addStatus(git.renamed, glyphs.renamed, "warning");
	addStatus(git.staged, glyphs.staged, "success");
	addStatus(git.untracked, "?", "muted");
	addStatus(git.stashed, glyphs.stashed, "muted");
	if (git.ahead > 0 && git.behind > 0) {
		icons.push(theme.fg("warning", `${glyphs.diverged}${git.ahead}/${git.behind}`));
	} else if (git.ahead > 0) {
		icons.push(theme.fg("success", `${glyphs.ahead}${git.ahead}`));
	} else if (git.behind > 0) {
		icons.push(theme.fg("warning", `${glyphs.behind}${git.behind}`));
	}
	if (icons.length > 0) parts.push(`${theme.fg("dim", "[")}${icons.join(" ")}${theme.fg("dim", "]")}`);
	return parts.join(" ");
}
