import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionProjection, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { createContextSnapshotStore, readContextSnapshot } from "../src/state/context-snapshot.ts";
import { collectContextBreakdown } from "../src/state/context.ts";

function entry(id: string, message: unknown, parentId: string | null = null): any {
	return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:00Z", message };
}
const user = (id: string, content = "12345678", parentId: string | null = null) => entry(id, { role: "user", content, timestamp: 1 }, parentId);
const assistant = (id: string, tokens = 100, stopReason = "stop", parentId: string | null = null) => entry(id, {
	role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 2, stopReason,
	usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens },
}, parentId);

function context(entries: SessionEntry[], report: any, leafId = entries.at(-1)?.id, prompt = ""): any {
	return {
		model: { contextWindow: 1_000, id: "synthetic", provider: "test" },
		getSystemPrompt: () => prompt,
		getSystemPromptOptions: () => ({ selectedTools: [] }),
		getContextUsage: () => report,
		sessionManager: {
			getBranch() {
				const branch: SessionEntry[] = [];
				let current = entries.find((entry) => entry.id === leafId);
				while (current) { branch.unshift(current); current = entries.find((entry) => entry.id === current?.parentId); }
				return branch;
			},
			buildSessionProjection: () => buildSessionProjection(entries, leafId),
		},
	};
}

test("snapshot distinguishes an actual usage anchor from estimated trailing context", () => {
	assert.deepEqual(readContextSnapshot(context([assistant("a")], { tokens: 100, percent: 10, contextWindow: 1_000 })), {
		tokens: 100, percent: 10, contextWindow: 1_000, source: "usage",
	});
	const entries = [assistant("a"), user("u", "12345678", "a")];
	assert.deepEqual(readContextSnapshot(context(entries, { tokens: 102, percent: 10.2, contextWindow: 1_000 })), {
		tokens: 102, percent: 10.2, contextWindow: 1_000, source: "mixed",
	});
	// Empty trailing content contributes no estimate, matching estimateContextTokens.
	assert.equal(readContextSnapshot(context([assistant("a"), user("u", "", "a")], { tokens: 100, percent: 10, contextWindow: 1_000 })).source, "usage");
});

test("standalone usage contributes neither a context anchor nor category content", () => {
	const usage = { type: "usage", id: "bill", parentId: "u", timestamp: "2026-01-01T00:00:00Z", kind: "cache_warm", provider: "test", model: "synthetic", usage: { input: 99_999, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 99_999 } } as SessionEntry;
	const ctx = context([user("u"), usage], { tokens: 2, percent: 0.2, contextWindow: 1_000 });
	assert.equal(readContextSnapshot(ctx).source, "estimate");
	assert.equal(readContextSnapshot(ctx).tokens, 2);
	const breakdown = collectContextBreakdown(ctx, []);
	assert.equal(breakdown.parts.find((part) => part.label === "Context")!.tokens, 2);
	assert.doesNotMatch(breakdown.previews.contextFiles, /cache_warm|99.?999/);
	const billingOnly = { ...usage, parentId: null };
	assert.deepEqual(readContextSnapshot(context([billingOnly], { tokens: 0, percent: 0, contextWindow: 1_000 })), {
		tokens: undefined, contextWindow: 1_000, percent: undefined, source: "unknown",
	});
});

test("usage from an excluded branch cannot turn active context into actual usage", () => {
	const entries = [user("root"), assistant("excluded", 99_000, "stop", "root"), user("active", "keep", "root")];
	const ctx = context(entries, { tokens: 3, percent: 0.3, contextWindow: 1_000 }, "active");
	assert.equal(readContextSnapshot(ctx).source, "estimate");
	assert.equal(readContextSnapshot(ctx).tokens, 3);
	assert.doesNotMatch(collectContextBreakdown(ctx, []).previews.contextFiles, /done/);
});

test("context edits invalidate retained usage, then post-edit usage restores an actual anchor", () => {
	const edit: any = { type: "context_edit", id: "edit", parentId: "a", targetId: "u", replacement: { content: "tiny" }, timestamp: "2026-01-01T00:00:03Z" };
	const entries = [user("u", "long original text"), assistant("a", 100, "stop", "u"), edit];
	const ctx = context(entries, { tokens: 2, percent: 0.2, contextWindow: 1_000 });
	assert.equal(readContextSnapshot(ctx).source, "estimate");
	assert.equal(collectContextBreakdown(ctx, []).hasReliablePiUsage, false);
	assert.match(collectContextBreakdown(ctx, []).previews.contextFiles, /tiny/);
	assert.doesNotMatch(collectContextBreakdown(ctx, []).previews.contextFiles, /long original/);
	entries.push(assistant("new", 50, "stop", "edit"));
	assert.equal(readContextSnapshot(context(entries, { tokens: 50, percent: 5, contextWindow: 1_000 })).source, "usage");
});

test("omitted usage and compaction retained assistants use estimates rather than stale anchors", () => {
	const omitted: any = { type: "context_edit", id: "edit", parentId: "a", targetId: "a", replacement: null, timestamp: "2026-01-01T00:00:03Z" };
	assert.equal(readContextSnapshot(context([user("u"), assistant("a", 100, "stop", "u"), omitted], { tokens: 2, percent: 0.2, contextWindow: 1_000 })).source, "estimate");
	const compact: any = { type: "compaction", id: "compact", parentId: "a", summary: "summary", tokensBefore: 100, firstKeptEntryId: "a", timestamp: "2026-01-01T00:00:03Z" };
	const snapshot = readContextSnapshot(context([user("u"), assistant("a", 100, "stop", "u"), compact], { tokens: null, percent: null, contextWindow: 1_000 }));
	assert.equal(snapshot.source, "estimate");
	assert.equal(snapshot.tokens, 3, "summary + retained answer are estimated, not 100-token historical usage");
});

test("all-zero/error/aborted usage and system-only transcripts remain estimates", () => {
	for (const [tokens, stopReason] of [[0, "stop"], [100, "error"], [100, "aborted"]] as const) {
		assert.equal(readContextSnapshot(context([assistant("a", tokens, stopReason)], { tokens: 1, percent: 0.1, contextWindow: 1_000 })).source, "estimate");
	}
	const system = entry("s", { role: "system", content: "", sections: { preamble: "base" }, timestamp: 1 });
	assert.equal(readContextSnapshot(context([system], { tokens: 1, percent: 0.1, contextWindow: 1_000 })).source, "estimate");
});

test("null/missing/no-known context never displays a real zero", () => {
	for (const usage of [undefined, { tokens: null, percent: null, contextWindow: 1_000 }, { tokens: 0, percent: 0, contextWindow: 1_000 }]) {
		const snapshot = readContextSnapshot(context([], usage));
		assert.equal(snapshot.tokens, undefined);
		assert.equal(snapshot.percent, undefined);
		assert.equal(snapshot.source, "unknown");
	}
	assert.equal(readContextSnapshot(context([], { tokens: null, percent: null, contextWindow: 1_000 }, undefined, "base prompt")).source, "estimate");
});

test("snapshot store projects and invokes Pi usage once per leaf/model/invalidation", () => {
	const store = createContextSnapshotStore();
	let projections = 0, usages = 0;
	let leaf = "a";
	const ctx = context([assistant("a")], { tokens: 100, percent: 10, contextWindow: 1_000 });
	const project = ctx.sessionManager.buildSessionProjection;
	ctx.sessionManager.buildSessionProjection = () => { projections++; return project(); };
	const usage = ctx.getContextUsage;
	ctx.getContextUsage = () => { usages++; return usage(); };
	ctx.sessionManager.getLeafId = () => leaf;
	ctx.sessionManager.getSessionId = () => "fixture-session";
	const first = store.read(ctx);
	for (let frame = 0; frame < 100; frame++) assert.strictEqual(store.read(ctx), first);
	assert.equal(projections, 1); assert.equal(usages, 1);
	leaf = "new-leaf"; store.read(ctx);
	ctx.model = { ...ctx.model, contextWindow: 2_000 }; store.read(ctx);
	store.invalidate(ctx); store.read(ctx);
	store.invalidate(); store.read(ctx);
	assert.equal(projections, 5); assert.equal(usages, 5);
});
