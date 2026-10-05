// Adapted from pi-session-ui (MIT); see licenses/pi-session-ui-UPSTREAM.md.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UiScheduler } from "../scheduler.ts";
import { createInitialState, getModelMeta, invalidateUsageCache } from "../state/usage.ts";
import { invalidateContextSnapshot } from "../state/context-snapshot.ts";
import { FOOTER_SEGMENTS } from "./display.ts";
import { installFooter } from "./footer.ts";
import { emptyGitStatus, readGitStatus } from "./git.ts";
import { captureShellHost } from "./host.ts";
import { readRuntimeInfo } from "./runtime.ts";

export interface ShellController {
	start(ctx: ExtensionContext): void;
	dispose(): void;
	agentStart(): void;
	agentEnd(ctx: ExtensionContext): void;
	messageEnd(): void;
	toolEnd(ctx: ExtensionContext): void;
	modelChanged(): void;
	rebuild(ctx: ExtensionContext): void;
}

/** Optional query injection keeps generation/coalescing tests independent of processes. */
export interface ShellQueries {
	git: typeof readGitStatus;
	runtime: typeof readRuntimeInfo;
}

let nextControllerId = 0;

/** Event routing and the single TUI render bridge belong to lifecycle.ts. */
export function createShellController(
	pi: ExtensionAPI,
	scheduler: UiScheduler,
	queries: ShellQueries = { git: readGitStatus, runtime: readRuntimeInfo },
): ShellController {
	const key = `shell:${++nextControllerId}`;
	let state = createInitialState();
	let generation = 0;
	let current: (ReturnType<typeof captureShellHost> & { ctx: ExtensionContext; cwd: string }) | undefined;
	let cleanupFooter: ((clearHost?: boolean) => void) | undefined;
	let gitJob: { generation: number; pending: boolean } | undefined;
	const contextSessions = new WeakMap<ExtensionContext, string | undefined>();

	const matches = (ctx: ExtensionContext): boolean => {
		if (!current || !current.isCurrentSession()
			|| (contextSessions.has(ctx) && contextSessions.get(ctx) !== current.sessionId)) return false;
		try {
			if (ctx.sessionManager !== current.manager || ctx.ui !== current.ui || ctx.cwd !== current.cwd) return false;
		} catch { return false; }
		contextSessions.set(ctx, current.sessionId);
		return true;
	};
	const isCurrent = (token: number): boolean => token === generation && !!current && current.isCurrentSession();
	const request = () => { if (isCurrent(generation)) scheduler.request(); };

	const refreshGit = async (token: number): Promise<void> => {
		if (!isCurrent(token)) return;
		if (gitJob?.generation === token) {
			gitJob.pending = true;
			return;
		}
		const job = { generation: token, pending: false };
		gitJob = job;
		const cwd = current!.cwd;
		try {
			do {
				job.pending = false;
				const segments = FOOTER_SEGMENTS;
				const git = segments.gitBranch || segments.gitStatus || segments.gitCommit
					? await queries.git(cwd, { readCommit: true, readTag: segments.gitCommit, readCounts: segments.gitStatus })
					: emptyGitStatus();
				if (!isCurrent(token)) return;
				state.git = git;
				request();
			} while (job.pending);
		} catch {
			// Readers normally return empty data on failure; injected readers may reject.
		} finally {
			if (gitJob === job) gitJob = undefined;
		}
	};
	const scheduleGit = () => {
		const token = generation;
		if (!isCurrent(token)) return;
		if (gitJob?.generation === token) {
			gitJob.pending = true;
			return;
		}
		scheduler.schedule(`${key}:git`, 0, () => { void refreshGit(token); });
	};
	const refreshRuntime = async (token: number): Promise<void> => {
		if (!isCurrent(token)) return;
		try {
			const runtime = FOOTER_SEGMENTS.runtime ? await queries.runtime(current!.cwd) : null;
			if (!isCurrent(token)) return;
			state.runtime = runtime;
			request();
		} catch { /* Runtime detection is optional. */ }
	};
	const invalidate = () => {
		if (!isCurrent(generation)) return;
		invalidateUsageCache(current!.manager);
		invalidateContextSnapshot(current!.ctx);
		request();
	};
	const dispose = () => {
		const manager = current?.manager;
		generation++;
		current = undefined;
		gitJob = undefined;
		for (const job of ["activity", "git", "runtime"]) scheduler.cancel(`${key}:${job}`);
		const footer = cleanupFooter;
		cleanupFooter = undefined;
		if (manager) invalidateUsageCache(manager);
		// The footer owns its host subscriptions and checks its captured
		// session/UI authority itself.
		footer?.();
	};

	return {
		start(ctx) {
			dispose();
			state = createInitialState();
			if (ctx.mode !== "tui" || !ctx.hasUI) return;
			current = { ...captureShellHost(ctx), ctx, cwd: ctx.cwd };
			contextSessions.set(ctx, current.sessionId);
			const token = generation;
			invalidateUsageCache(current.manager);
			try {
				cleanupFooter = installFooter(ctx, () => state, () => getModelMeta(ctx, () => pi.getThinkingLevel()), {
					requestRender: request,
					scheduleGitRefresh: scheduleGit,
					isCurrent: () => isCurrent(token),
				});
			} catch (error) {
				dispose();
				throw error;
			}
			scheduleGit();
			scheduler.schedule(`${key}:runtime`, 0, () => { void refreshRuntime(token); });
			request();
		},
		dispose,
		agentStart() {
			if (!isCurrent(generation)) return;
			state.workingSince ??= Date.now();
			state.lastDoneIn = undefined;
			const token = generation;
			scheduler.schedule(`${key}:activity`, 250, () => {
				if (isCurrent(token)) request();
			}, true);
			request();
		},
		agentEnd(ctx) {
			if (!matches(ctx)) return;
			scheduler.cancel(`${key}:activity`);
			if (state.workingSince !== undefined) {
				state.lastDoneIn = Date.now() - state.workingSince;
				state.workingSince = undefined;
			}
			invalidate();
			scheduleGit();
		},
		messageEnd: invalidate,
		toolEnd(ctx) {
			if (!matches(ctx)) return;
			invalidate();
			scheduleGit();
		},
		modelChanged: invalidate,
		rebuild(ctx) {
			if (!matches(ctx)) return;
			invalidate();
			scheduleGit();
		},
	};
}
