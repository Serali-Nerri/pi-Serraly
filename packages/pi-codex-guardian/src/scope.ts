import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./review.js";

const BASENAME = "pi-codex-guardian.json";
type Rule = {
	tool: string;
	args: Record<string, string>;
	action: "review" | "block";
};
type ScopeConfig = {
	defaultAction: "review" | "pass" | undefined;
	rules: Rule[];
};
export type ScopePolicy =
	| {
			valid: true;
			defaultAction: "review" | "pass";
			rules: Rule[];
			source: "none" | "global" | "repo" | "global + repo";
			repoLoaded: boolean;
			cwd: string;
	  }
	| { valid: false; error: string };

function readConfig(path: string): ScopeConfig | undefined {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (isRecord(error) && error["code"] === "ENOENT") return;
		throw new Error(`Cannot read ${path}`);
	}
	if (Buffer.byteLength(text, "utf8") > 64 * 1024)
		throw new Error(`${path} exceeds 64 KiB`);
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error(`Invalid JSON in ${path}`);
	}
	if (
		!isRecord(value) ||
		Object.keys(value).some(
			(key) => !["defaultAction", "rules"].includes(key),
		) ||
		(Object.hasOwn(value, "defaultAction") &&
			value["defaultAction"] !== "review" &&
			value["defaultAction"] !== "pass")
	)
		throw new Error(
			`${path} must contain optional defaultAction (review or pass) and rules`,
		);
	const rules = Object.hasOwn(value, "rules") ? value["rules"] : [];
	if (!Array.isArray(rules) || rules.length > 256)
		throw new Error(`${path} rules must be an array of at most 256 tool rules`);
	return {
		defaultAction: value["defaultAction"] as ScopeConfig["defaultAction"],
		rules: rules.map((rule, index) => {
			const invalid = () =>
				new Error(
					`${path} rule ${index + 1}: expected exact tool, optional args regex strings, and action review or block`,
				);
			if (
				!isRecord(rule) ||
				Object.keys(rule).some(
					(key) => !["tool", "args", "action"].includes(key),
				) ||
				typeof rule["tool"] !== "string" ||
				!rule["tool"].length ||
				(rule["action"] !== "review" && rule["action"] !== "block") ||
				(Object.hasOwn(rule, "args") && !isRecord(rule["args"]))
			)
				throw invalid();
			const args: Record<string, string> = {};
			for (const [key, pattern] of Object.entries(
				isRecord(rule["args"]) ? rule["args"] : {},
			)) {
				if (typeof pattern !== "string" || pattern.length > 4096)
					throw invalid();
				try {
					new RegExp(pattern);
				} catch {
					throw new Error(`${path} rule ${index + 1}: invalid argument regex`);
				}
				Object.defineProperty(args, key, { value: pattern, enumerable: true });
			}
			return { tool: rule["tool"], args, action: rule["action"] };
		}),
	};
}

/** Snapshot only at session start or explicit user reload, never from a tool call. */
export function loadScope(cwd: string, projectTrusted: boolean): ScopePolicy {
	try {
		const global = readConfig(join(getAgentDir(), BASENAME));
		const repo = projectTrusted
			? readConfig(join(cwd, ".pi", BASENAME))
			: undefined;
		return {
			valid: true,
			defaultAction:
				global?.defaultAction === "review" || repo?.defaultAction === "review"
					? "review"
					: (global?.defaultAction ?? repo?.defaultAction ?? "review"),
			rules: [...(global?.rules ?? []), ...(repo?.rules ?? [])],
			source:
				global !== undefined
					? repo !== undefined
						? "global + repo"
						: "global"
					: repo !== undefined
						? "repo"
						: "none",
			repoLoaded: repo !== undefined,
			cwd,
		};
	} catch (error) {
		return {
			valid: false,
			error: error instanceof Error ? error.message : "Rule policy unavailable",
		};
	}
}

// Configured regexes can backtrack catastrophically on model-controlled strings.
// Node owns regex evaluation even when Pi runs on Bun, whose workers lack heap limits.
// A disposable process bounds CPU and isolates memory from the host.
const MATCH_PROCESS = `
const policy = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
let decision = policy.defaultAction;
for (const rule of policy.rules) {
	if (!rule.args.every(([pattern, value]) => new RegExp(pattern).test(value))) continue;
	decision = rule.action;
	break;
}
process.stdout.write(decision);
`;

export type Decision = "pass" | "review" | "block";
type MatchCandidate = { action: Rule["action"]; args: [string, string][] };
type MatchJob = {
	candidates: MatchCandidate[];
	defaultAction: "review" | "pass";
	signal: AbortSignal;
	resolve: (decision: Decision) => void;
	reject: (error: unknown) => void;
	abort: () => void;
};

export class RuleMatcher {
	private active = 0;
	private queue: MatchJob[] = [];

	decide(
		toolName: string,
		input: unknown,
		policy: { rules: Rule[]; defaultAction: "review" | "pass" },
		signal: AbortSignal,
	): Decision | Promise<Decision> {
		signal.throwIfAborted();
		const rules = policy.rules.filter((rule) => rule.tool === toolName);
		if (
			rules.some(
				(rule) => rule.action === "block" && !Object.keys(rule.args).length,
			)
		)
			return "block";
		const review =
			policy.defaultAction === "review" ||
			rules.some(
				(rule) => rule.action === "review" && !Object.keys(rule.args).length,
			);
		const args = isRecord(input) ? input : undefined;
		const candidates: MatchCandidate[] = [];
		let totalBytes = 0;
		for (const rule of rules) {
			if (review && rule.action === "review") continue;
			const predicates: [string, string][] = [];
			let matches = true;
			for (const [key, pattern] of Object.entries(rule.args)) {
				const value = args && Object.hasOwn(args, key) ? args[key] : undefined;
				if (typeof value !== "string") {
					matches = false;
					break;
				}
				predicates.push([pattern, value]);
			}
			if (!matches) continue;
			for (const [, value] of predicates)
				totalBytes += Buffer.byteLength(value, "utf8");
			candidates.push({ action: rule.action, args: predicates });
		}
		const defaultAction = review ? "review" : "pass";
		if (!candidates.length) return defaultAction;
		if (totalBytes > 1024 * 1024)
			throw new Error("Argument matching exceeds 1 MiB");
		candidates.sort(
			(a, b) => Number(b.action === "block") - Number(a.action === "block"),
		);
		return new Promise<Decision>((resolve, reject) => {
			const job: MatchJob = {
				candidates,
				defaultAction,
				signal,
				resolve,
				reject,
				abort: () => {
					const index = this.queue.indexOf(job);
					if (index < 0) return;
					this.queue.splice(index, 1);
					signal.removeEventListener("abort", job.abort);
					reject(new Error("Argument matching cancelled"));
				},
			};
			this.queue.push(job);
			signal.addEventListener("abort", job.abort, { once: true });
			if (signal.aborted) job.abort();
			this.drain();
		});
	}

	private drain(): void {
		while (this.active < 2 && this.queue.length) {
			const job = this.queue.shift();
			if (!job) break;
			job.signal.removeEventListener("abort", job.abort);
			this.active++;
			this.match(job).then(
				(decision) => {
					this.active--;
					job.resolve(decision);
					this.drain();
				},
				(error: unknown) => {
					this.active--;
					job.reject(error);
					this.drain();
				},
			);
		}
	}

	private match(job: MatchJob): Promise<Decision> {
		return new Promise<Decision>((resolve, reject) => {
			const child = spawn(
				process.versions["bun"] ? "node" : process.execPath,
				["--max-old-space-size=32", "--stack-size=1024", "-e", MATCH_PROCESS],
				{
					stdio: ["pipe", "pipe", "ignore"],
					env: { ...process.env, NODE_OPTIONS: "" },
				},
			);
			let failure: Error | undefined;
			let output = "";
			const stop = (error: Error) => {
				failure ??= error;
				child.kill("SIGKILL");
			};
			const abort = () => stop(new Error("Argument matching cancelled"));
			// Queue time does not consume a process's execution budget.
			const timer = setTimeout(
				() => stop(new Error("Argument matching timed out")),
				1000,
			);
			job.signal.addEventListener("abort", abort, { once: true });
			child.stdout.on("data", (chunk: Buffer) => {
				output += chunk.toString("utf8");
				if (output.length > 16) stop(new Error("Argument matching failed"));
			});
			child.once("error", () =>
				stop(new Error("Node argument matcher unavailable")),
			);
			child.stdin.once("error", () =>
				stop(new Error("Argument matching failed")),
			);
			child.stdout.once("error", () =>
				stop(new Error("Argument matching failed")),
			);
			child.once("close", (code) => {
				clearTimeout(timer);
				job.signal.removeEventListener("abort", abort);
				if (failure) reject(failure);
				else if (
					code === 0 &&
					(output === "pass" || output === "review" || output === "block")
				)
					resolve(output);
				else reject(new Error("Argument matching failed"));
			});
			child.stdin.end(
				JSON.stringify({
					rules: job.candidates,
					defaultAction: job.defaultAction,
				}),
			);
			if (job.signal.aborted) abort();
		});
	}
}
