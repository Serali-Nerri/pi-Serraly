import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import type { GitStatus } from "../shell/git.ts";
import { emptyGitStatus } from "../shell/git.ts";
import type { RuntimeInfo } from "../shell/runtime.ts";
import { finiteOrZero, formatProviderLabel } from "../shell/utils.ts";

export interface FooterState {
	git: GitStatus;
	runtime: RuntimeInfo | null;
	workingSince: number | undefined;
	lastDoneIn: number | undefined;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	latestCacheHitRate: number | undefined;
}

let usageCache = new WeakMap<ExtensionContext["sessionManager"], { revision: string; totals: UsageTotals }>();

export function getUsageTotals(ctx: ExtensionContext): UsageTotals {
	const manager = ctx.sessionManager;
	// Pi 1.0.4 exposes an O(1) entry count. Do not copy the session on every
	// animation frame; the count also catches idle usage entries with no event.
	// Public SessionManager API, omitted from Pi's ReadonlySessionManager Pick.
	const count = (manager as typeof manager & Partial<Pick<SessionManager, "getEntryCount">>).getEntryCount?.();
	const leafId = manager.getLeafId?.();
	const leaf = leafId ? manager.getEntry?.(leafId) : undefined;
	const entries = count === undefined ? manager.getEntries() : undefined;
	const last = entries?.at(-1);
	const revision = JSON.stringify([
		manager.getSessionId?.(), count ?? entries!.length,
		last?.id ?? leafId, last?.timestamp ?? leaf?.timestamp,
	]);
	const cached = usageCache.get(manager);
	if (cached?.revision === revision) return cached.totals;

	const totals: UsageTotals = {
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
		latestCacheHitRate: undefined,
	};
	for (const entry of entries ?? manager.getEntries()) {
		let u: Usage | undefined;
		let updateCacheHitRate = false;
		if (entry.type === "message" && entry.message.role === "assistant") {
			u = entry.message.usage;
			updateCacheHitRate = true;
		} else if (entry.type === "message" && entry.message.role === "toolResult") {
			u = entry.message.usage;
		} else if (entry.type === "branch_summary" || entry.type === "compaction" || entry.type === "usage") {
			u = entry.usage;
		}
		if (!u) continue;
		const input = finiteOrZero(u.input);
		const cacheRead = finiteOrZero(u.cacheRead);
		const cacheWrite = finiteOrZero(u.cacheWrite);
		// input matches /session's "uncached" total: cacheWrite is billed near full
		// price (fresh content), only cacheRead is discounted repeat content.
		totals.input += input + cacheWrite;
		totals.output += finiteOrZero(u.output);
		totals.cacheRead += cacheRead;
		totals.cacheWrite += cacheWrite;
		totals.cost += finiteOrZero(u.cost?.total);
		if (updateCacheHitRate) {
			const promptTokens = input + cacheRead + cacheWrite;
			totals.latestCacheHitRate = promptTokens > 0
				? (cacheRead / promptTokens) * 100
				: undefined;
		}
	}
	usageCache.set(manager, { revision, totals });
	return totals;
}

export function invalidateUsageCache(manager?: ExtensionContext["sessionManager"]): void {
	if (manager) usageCache.delete(manager);
	else usageCache = new WeakMap();
}

export function createInitialState(): FooterState {
	return {
		git: emptyGitStatus(),
		runtime: null,
		workingSince: undefined,
		lastDoneIn: undefined,
	};
}

export interface ModelMeta {
	provider: string;
	model: string;
	effort: string | undefined;
}

export function getModelMeta(
	ctx: ExtensionContext,
	getThinkingLevel: () => string,
): ModelMeta {
	const provider = formatProviderLabel(ctx.model?.provider);
	const model = ctx.model?.name ?? ctx.model?.id ?? "no-model";
	const reasoning = ctx.model?.reasoning ?? false;
	const effort = reasoning ? getThinkingLevel() : undefined;
	return { provider, model, effort };
}
