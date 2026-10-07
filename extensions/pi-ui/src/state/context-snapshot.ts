import { calculateContextTokens, estimateTokens, type ExtensionContext, type SessionEntry, type SessionProjection } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";

export type ContextSnapshot = {
	tokens: number | undefined;
	contextWindow: number;
	percent: number | undefined;
	source: "usage" | "mixed" | "estimate" | "unknown";
};
export type ContextSnapshotContext = Pick<ExtensionContext, "sessionManager" | "getContextUsage" | "model" | "getSystemPrompt">;

type ContextEstimate = { tokens: number; trailingTokens: number; lastUsageIndex: number | null };
const finiteNonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Pi 1.0.4 estimateContextTokens semantics, using only public exports.
 * That helper isn't exported from the package root. Never use billing UsageEntry.
 */
function estimateAllContext(projection: SessionProjection): number {
	const system = getCurrentSystemMessage(projection.messages);
	return (system ? estimateTokens(system) : 0) + projection.messages.reduce((total, message) =>
		total + (message.role === "system" ? 0 : estimateTokens(message)), 0);
}

function estimateProjectedContext(projection: SessionProjection, branch?: SessionEntry[]): ContextEstimate {
	const messages = projection.messages;
	let lastUsageIndex: number | null = null;
	let usageTokens = 0;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted" || !message.usage) continue;
		const tokens = calculateContextTokens(message.usage);
		if (!finiteNonnegative(tokens) || tokens === 0) continue;
		lastUsageIndex = index;
		usageTokens = tokens;
		break;
	}
	if (lastUsageIndex !== null) {
		// estimateProjectedContextTokens invalidates any anchor captured before
		// a later edit/compaction, even when that assistant itself is retained.
		const entries = branch ?? projection.entries.map((entry) => entry.sourceEntry);
		let messageIndex = 0;
		let anchorId: string | undefined;
		for (const entry of projection.entries) {
			messageIndex += entry.messages.length;
			if (lastUsageIndex < messageIndex) { anchorId = entry.sourceEntry.id; break; }
		}
		const anchor = anchorId === undefined ? -1 : entries.findIndex((entry) => entry.id === anchorId);
		let invalidation = -1;
		for (let index = entries.length - 1; index >= 0; index--) {
			if (entries[index].type === "context_edit" || entries[index].type === "compaction") { invalidation = index; break; }
		}
		// Synthetic projections without provenance can still express an anchor;
		// real SessionManager projections always have source entries.
		if (invalidation >= 0 && anchor <= invalidation) lastUsageIndex = null;
	}
	if (lastUsageIndex !== null) {
		const trailingTokens = messages.slice(lastUsageIndex + 1).reduce((total, message) => total + estimateTokens(message), 0);
		return { tokens: usageTokens + trailingTokens, trailingTokens, lastUsageIndex };
	}
	const tokens = estimateAllContext(projection);
	return { tokens, trailingTokens: tokens, lastUsageIndex: null };
}

function computeContextSnapshot(ctx: ContextSnapshotContext): ContextSnapshot {
	const projection = ctx.sessionManager.buildSessionProjection();
	const branch = ctx.sessionManager.getBranch?.();
	const estimate = estimateProjectedContext(projection, branch);
	const usage = ctx.getContextUsage();
	const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const contextWindow = finiteNonnegative(window) ? window : 0;
	const hasAnchor = estimate.lastUsageIndex !== null;
	const hasSystem = projection.messages.some((message) => message.role === "system");
	const reported = usage?.tokens;
	const fromPercent = finiteNonnegative(usage?.percent) && contextWindow > 0
		? Math.round(usage.percent / 100 * contextWindow) : undefined;
	let tokens: number | undefined;
	let source: ContextSnapshot["source"] = "unknown";
	if ((hasAnchor || hasSystem) && (finiteNonnegative(reported) || fromPercent !== undefined)) {
		tokens = finiteNonnegative(reported) ? reported : fromPercent;
		if (fromPercent !== undefined && tokens !== undefined && Math.abs(tokens - fromPercent) > Math.max(32, Math.round(contextWindow * 0.001))) tokens = fromPercent;
		// Pi's total includes an anchor plus estimates of trailing messages.
		source = hasAnchor ? estimate.trailingTokens > 0 ? "mixed" : "usage" : "estimate";
	} else {
		// A null report (notably just after compaction) is not measured zero.
		// Rebuild a complete estimate, ignoring obsolete usage on retained messages.
		const fullEstimate = estimateAllContext(projection);
		const prompt = !hasSystem && typeof ctx.getSystemPrompt === "function" ? ctx.getSystemPrompt() : "";
		const fallback = fullEstimate + Math.ceil(prompt.length / 4);
		if (finiteNonnegative(fallback) && fallback > 0) { tokens = fallback; source = "estimate"; }
	}
	if (tokens === 0 && !hasAnchor && !hasSystem) { tokens = undefined; source = "unknown"; }
	return { tokens, contextWindow, percent: tokens === undefined || contextWindow <= 0 ? undefined : tokens / contextWindow * 100, source };
}

/** O(1) leaf/model checks on footer frames; only cache misses call Pi's usage getter
 * (which itself projects history). Lifecycle may invalidate at routed boundaries.
 */
export function createContextSnapshotStore(): {
	read(ctx: ContextSnapshotContext): ContextSnapshot;
	invalidate(ctx?: Pick<ContextSnapshotContext, "sessionManager">): void;
} {
	let cache = new WeakMap<object, { key: string; snapshot: ContextSnapshot }>();
	return {
		read(ctx) {
			const manager = ctx.sessionManager;
			const leaf = manager.getLeafId?.();
			const key = `${manager.getSessionId?.() ?? ""}:${leaf ?? ""}:${ctx.model?.provider ?? ""}:${ctx.model?.id ?? ""}:${ctx.model?.contextWindow ?? 0}`;
			// Contexts without a leaf/version use fresh reads.
			// Real session managers expose an append-only leaf.
			const cacheable = typeof manager.getLeafId === "function";
			const hit = cacheable ? cache.get(manager) : undefined;
			if (hit?.key === key) return hit.snapshot;
			const snapshot = computeContextSnapshot(ctx);
			if (cacheable) cache.set(manager, { key, snapshot });
			return snapshot;
		},
		invalidate(ctx) {
			if (ctx) cache.delete(ctx.sessionManager);
			else cache = new WeakMap();
		},
	};
}

const defaultStore = createContextSnapshotStore();
/** Footer snapshot cache. No subscriptions or resources at creation. */
export const readContextSnapshot = defaultStore.read;
export const invalidateContextSnapshot = defaultStore.invalidate;
