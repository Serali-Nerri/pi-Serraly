import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	arr,
	bool,
	compile,
	int,
	obj,
	type Static,
	str,
} from "@earendil-works/pi-schema";
import { threadSnapshot } from "./feedback.js";

export interface Thread {
	repo: string;
	number: number;
	kind: "issue" | "pr";
	url: string;
}

export interface WorkflowRun {
	repo: string;
	number: number;
	kind: "run";
	url: string;
}

export interface Repository {
	repo: string;
	kind: "repo";
	url: string;
}

export type WatchTarget = Thread | WorkflowRun | Repository;

const newThread = obj({
	number: int({ minimum: 1 }),
	title: str(),
	url: str(),
	author: str(),
	pr: bool(),
	draft: bool(),
});
export type NewThread = Static<typeof newThread>;
const newThreadPage = compile(arr(newThread));

export type RunSnapshot =
	| { completed: false }
	| { completed: true; conclusion: string; attempt: number };

export function githubClient(
	pi: ExtensionAPI,
	cwd: string,
	signal?: AbortSignal,
) {
	const gh = async (args: string[]) => {
		const result = await pi.exec("gh", args, {
			cwd,
			...(signal ? { signal } : {}),
			timeout: 30_000,
		});
		if (result.code !== 0)
			throw new Error(
				"GitHub request failed. Check gh auth status and access to the watched URL, then watch again.",
			);
		return result.stdout.trim();
	};
	return {
		async resolve(input: string): Promise<WatchTarget> {
			const value = input.trim();
			const run =
				/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)\/?(?:[?#].*)?$/.exec(
					value,
				);
			if (run) {
				const number = Number(run[2]);
				if (!Number.isSafeInteger(number) || number < 1)
					throw new Error("Run ID must be a positive safe integer.");
				const repo = run[1]!.toLowerCase();
				return {
					repo,
					number,
					kind: "run",
					url: `https://github.com/${repo}/actions/runs/${number}`,
				};
			}
			const repository =
				/^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(
					value,
				);
			if (repository) {
				const repo = repository[1]!.toLowerCase();
				return { repo, kind: "repo", url: `https://github.com/${repo}` };
			}
			const url =
				/^https:\/\/github\.com\/([^/]+\/[^/]+)\/(issues|pull)\/(\d+)(?:[/?#].*)?$/.exec(
					value,
				);
			const qualified = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(value);
			const numberText =
				url?.[3] ??
				qualified?.[2] ??
				(/^#?\d+$/.test(value) ? value.replace(/^#/, "") : undefined);
			if (!numberText)
				throw new Error(
					"Use a GitHub issue/PR or Actions run URL, owner/repo#123, or an issue/PR number against this repository's GitHub origin.",
				);
			const number = Number(numberText);
			if (!Number.isSafeInteger(number) || number < 1)
				throw new Error("Thread number must be a positive safe integer.");
			const repo = (
				url?.[1] ??
				qualified?.[1] ??
				(await gh([
					"repo",
					"view",
					"--json",
					"nameWithOwner",
					"--jq",
					".nameWithOwner",
				]))
			).toLowerCase();
			if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
				throw new Error(
					"No GitHub origin found. Supply owner/repo#123 instead.",
				);
			const kindText = await gh([
				"api",
				`repos/${repo}/issues/${number}`,
				"--jq",
				'if has("pull_request") then "pr" else "issue" end',
			]);
			if (kindText !== "pr" && kindText !== "issue")
				throw new Error(
					"GitHub returned an invalid thread type. Retry the watch.",
				);
			return {
				repo,
				number,
				kind: kindText,
				url: `https://github.com/${repo}/${kindText === "pr" ? "pull" : "issues"}/${number}`,
			};
		},
		snapshot(thread: Thread, scope: "conversation" | "all" = "all") {
			return threadSnapshot(gh, thread, scope);
		},
		/** Without `after`, returns only the latest number as a baseline. */
		async newThreads(
			repo: string,
			after?: number,
		): Promise<{ latest: number; items: NewThread[] }> {
			const items: NewThread[] = [];
			const perPage = after === undefined ? 1 : 100;
			let latest = after ?? 0;
			for (let page = 1; ; page++) {
				const value: unknown = JSON.parse(
					await gh([
						"api",
						`repos/${repo}/issues?state=all&sort=created&direction=desc&per_page=${perPage}&page=${page}`,
						"--jq",
						'[.[] | {number, title, url: .html_url, author: (.user.login // "ghost"), pr: has("pull_request"), draft: (.draft == true)}]',
					]),
				);
				if (!newThreadPage.check(value))
					throw new Error(
						"GitHub returned invalid issue metadata. Retry the watch.",
					);
				if (page === 1) latest = Math.max(latest, value[0]?.number ?? 0);
				if (after === undefined) return { latest, items };
				const fresh = value.filter((item) => item.number > after);
				items.push(...fresh);
				if (fresh.length < value.length || value.length < perPage)
					return { latest, items: items.reverse() };
			}
		},
		async prSnapshot(thread: Thread): Promise<{
			state: "open" | "closed" | "merged";
			headSha: string;
		}> {
			const value: unknown = JSON.parse(
				await gh([
					"api",
					`repos/${thread.repo}/pulls/${thread.number}`,
					"--jq",
					"{state, merged, headSha: .head.sha}",
				]),
			);
			if (
				value &&
				typeof value === "object" &&
				"state" in value &&
				"merged" in value &&
				typeof value.merged === "boolean" &&
				"headSha" in value &&
				typeof value.headSha === "string" &&
				/^[0-9a-f]{40}$/.test(value.headSha)
			) {
				if (value.state === "closed")
					return {
						state: value.merged ? "merged" : "closed",
						headSha: value.headSha,
					};
				if (value.state === "open" && !value.merged)
					return { state: "open", headSha: value.headSha };
			}
			throw new Error("GitHub returned invalid PR state. Retry the watch.");
		},
		async runSnapshot(run: WorkflowRun): Promise<RunSnapshot> {
			const snapshot: unknown = JSON.parse(
				await gh([
					"api",
					`repos/${run.repo}/actions/runs/${run.number}`,
					"--jq",
					"{status, conclusion, run_attempt}",
				]),
			);
			if (snapshot && typeof snapshot === "object" && "status" in snapshot) {
				if (
					["queued", "in_progress", "waiting", "pending", "requested"].includes(
						String(snapshot.status),
					)
				)
					return { completed: false };
				if (
					snapshot.status === "completed" &&
					"conclusion" in snapshot &&
					typeof snapshot.conclusion === "string" &&
					/^[a-z_]+$/.test(snapshot.conclusion) &&
					"run_attempt" in snapshot &&
					typeof snapshot.run_attempt === "number" &&
					Number.isSafeInteger(snapshot.run_attempt) &&
					snapshot.run_attempt > 0
				)
					return {
						completed: true,
						conclusion: snapshot.conclusion,
						attempt: snapshot.run_attempt,
					};
			}
			throw new Error("GitHub returned invalid run metadata. Retry the watch.");
		},
	};
}
