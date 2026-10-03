import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { getUsageTotals, invalidateUsageCache } from "../../src/state/usage.ts";

function usage(input = 1, cacheWrite = 2, cacheRead = 3, output = 4, cost = 0.5): Usage {
	return { input, cacheWrite, cacheRead, output, totalTokens: input + cacheWrite + cacheRead + output,
		cost: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: cost } };
}

function assistant(u: Usage): AssistantMessage {
	return { role: "assistant", content: [], api: "openai-responses", provider: "test", model: "test",
		usage: u, stopReason: "stop", timestamp: 1 };
}

function ctxFor(manager: ExtensionContext["sessionManager"]): ExtensionContext {
	return { sessionManager: manager } as ExtensionContext;
}

test("all-entry billing includes off-branch assistants, aggregate tool usage, summaries and every usage kind", () => {
	const manager = SessionManager.inMemory("/tmp/pi-ui-synthetic");
	const first = manager.appendMessage(assistant(usage(10, 20, 70, 5, 1)));
	manager.appendMessage(assistant(usage(7, 3, 90, 5, 1)));
	manager.branch(first);
	manager.appendMessage({ role: "toolResult", toolName: "parent", toolCallId: "parent", content: [], isError: false,
		timestamp: 2, usage: usage(), details: { usage: usage(999), nested: [{ usage: usage(999) }] },
		nestedCalls: { calls: [{ toolCallId: "parent/1", toolName: "nested", args: {}, status: "success", durationMs: 1 }], complete: true },
	} as unknown as Parameters<SessionManager["appendMessage"]>[0]);
	manager.appendCompaction("summary", first, 100, undefined, false, usage());
	manager.branchWithSummary(first, "branch summary", undefined, false, usage());
	manager.appendUsage("cache_warm", "test", "test", usage());
	manager.appendUsage("future_unknown_kind", "test", "test", usage());
	const totals = getUsageTotals(ctxFor(manager));
	assert.deepEqual(totals, {
		input: 55, cacheWrite: 33, cacheRead: 175, output: 30, cost: 4.5, latestCacheHitRate: 90,
	});
	assert.equal(manager.getBranch().some((e) => e.type === "message" && e.message.role === "assistant" && e.message.usage.input === 7), false);
});

test("revision checks reuse totals without copying history, and detect idle appended usage", () => {
	const manager = SessionManager.inMemory("/tmp/pi-ui-synthetic");
	manager.appendMessage(assistant(usage()));
	let reads = 0;
	const getEntries = manager.getEntries.bind(manager);
	manager.getEntries = () => { reads++; return getEntries(); };
	const ctx = ctxFor(manager);
	const first = getUsageTotals(ctx);
	for (let frame = 0; frame < 100; frame++) assert.equal(getUsageTotals(ctx), first);
	assert.equal(reads, 1);
	manager.appendUsage("cache_warm", "test", "test", usage(5, 10, 20, 0, 0.25));
	const second = getUsageTotals(ctx);
	assert.notEqual(second, first);
	assert.equal(reads, 2);
	assert.equal(second.input, 18);
	assert.equal(second.cacheRead, 23);
	assert.equal(second.cost, 0.75);
	assert.equal(second.latestCacheHitRate, 50, "billing-only usage never replaces the last assistant hit rate");
	assert.equal(getUsageTotals(ctx), second);
	assert.equal(reads, 2);
	invalidateUsageCache(manager);
	assert.notEqual(getUsageTotals(ctx), second);
	assert.equal(reads, 3);
});

test("cache invalidation is session-scoped and session replacement cannot reuse equal-length totals", () => {
	const a = SessionManager.inMemory("/tmp/pi-ui-synthetic");
	const b = SessionManager.inMemory("/tmp/pi-ui-synthetic");
	a.appendMessage(assistant(usage(1)));
	b.appendMessage(assistant(usage(10)));
	const ctxA = ctxFor(a);
	const ctxB = ctxFor(b);
	const cachedB = getUsageTotals(ctxB);
	const cachedA = getUsageTotals(ctxA);
	invalidateUsageCache(a);
	assert.notEqual(getUsageTotals(ctxA), cachedA);
	assert.equal(getUsageTotals(ctxB), cachedB);
	a.newSession();
	a.appendMessage(assistant(usage(50)));
	assert.equal(getUsageTotals(ctxA).input, 52);
});

test("fallback revisions include count, last id and timestamp and sanitize non-finite usage", () => {
	const entries = [{ id: "a", timestamp: "one", type: "usage", kind: "anything", usage: usage() }] as unknown as SessionEntry[];
	const manager = { getEntries: () => entries } as ExtensionContext["sessionManager"];
	const ctx = ctxFor(manager);
	const first = getUsageTotals(ctx);
	assert.equal(getUsageTotals(ctx), first);
	entries[0] = { ...entries[0], id: "b", timestamp: "two" };
	assert.notEqual(getUsageTotals(ctx), first);
	const second = getUsageTotals(ctx);
	entries[0] = { ...entries[0], timestamp: "three" };
	assert.notEqual(getUsageTotals(ctx), second);
	entries.push({ id: "bad", timestamp: "bad", type: "usage", kind: "other", usage: usage(NaN, Infinity, NaN, Infinity, Infinity) } as unknown as SessionEntry);
	assert.deepEqual(getUsageTotals(ctx), { input: 3, cacheWrite: 2, cacheRead: 3, output: 4, cost: 0.5, latestCacheHitRate: undefined });
});
