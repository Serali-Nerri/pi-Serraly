import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { buildSessionProjection, type ExtensionContext, type SessionEntry, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { installFooter } from "../../src/shell/footer.ts";
import { emptyGitStatus, parseGitStatus, readGitStatus } from "../../src/shell/git.ts";
import { createInitialState, getUsageTotals, invalidateUsageCache } from "../../src/state/usage.ts";
import { fitSegmentsByPriority, stripAnsi } from "../../src/shell/utils.ts";

const testAgentDir = await mkdtemp(join(tmpdir(), "pi-session-ui-tests-"));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = testAgentDir;
after(async () => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	assert.deepEqual(await readdir(testAgentDir), []);
	await rm(testAgentDir, { recursive: true, force: true });
});

const theme = {
	fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[0m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as Theme;

function contextFor(entries: unknown[] = [], extra: Record<string, unknown> = {}): ExtensionContext {
	return {
		mode: "tui",
		hasUI: true,
		cwd: "/tmp",
		model: { provider: "openai", name: "GPT-5.6 Sol", reasoning: true, contextWindow: 1000000 },
		getContextUsage: () => ({ tokens: 25000, contextWindow: 1000000, percent: 2.5 }),
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => entries,
			buildSessionProjection: () => buildSessionProjection(entries as SessionEntry[]),
			getCwd: () => "/tmp/工作目录/非常长的项目名字",
			getSessionName: () => "footer test",
		},
		...extra,
	} as unknown as ExtensionContext;
}

function usageEntry(id: string, input: number, cacheRead: number, output: number, cacheWrite = 0) {
	return {
		id, timestamp: id, parentId: id === "1" ? null : "1", type: "message",
		message: { role: "assistant", content: [], stopReason: "stop", usage: { input, cacheRead, cacheWrite, output, cost: { total: 0 } } },
	};
}

test("usage separates cumulative input from the latest request cache percentage and isolates sessions", () => {
	invalidateUsageCache();
	const ctx = contextFor([usageEntry("1", 20700, 89300, 1500), usageEntry("2", 1300, 18700, 1700)]);
	assert.deepEqual(getUsageTotals(ctx), {
		input: 22000, cacheRead: 108000, cacheWrite: 0, output: 3200, cost: 0, latestCacheHitRate: 93.5,
	});
	const other = contextFor([usageEntry("1", 1, 0, 2), usageEntry("2", 5, 80, 3, 15)]);
	const totals = getUsageTotals(other);
	assert.equal(totals.input, 21);
	assert.equal(totals.latestCacheHitRate, 80);
	assert.equal(getUsageTotals(ctx).cacheRead, 108000);
});

test("footer retains project, model, usage, and other extension statuses within terminal width", () => {
	const state = createInitialState();
	state.lastDoneIn = 35000;
	state.git = { ...emptyGitStatus(), branch: "main", modified: 2, untracked: 7 };
	let component: { render: (width: number) => string[]; dispose: () => void } | undefined;
	let branchListener: (() => void) | undefined;
	let unsubscribed = 0;
	let renders = 0;
	let refreshes = 0;
	const ctx = contextFor([usageEntry("1", 20700, 89300, 1500), usageEntry("2", 1300, 18700, 1700)], {
		ui: {
			setFooter(factory: Function | undefined) {
				component?.dispose();
				component = factory?.({ requestRender: () => { renders++; } }, theme, {
					onBranchChange: (callback: () => void) => { branchListener = callback; return () => { unsubscribed++; }; },
					getExtensionStatuses: () => new Map([["z", "工具状态\n准备完毕"], ["a", "Freeflow · Muse Spark"]]),
				});
			},
		},
	});
	const cleanup = installFooter(ctx, () => state, () => ({ provider: "Openai", model: "GPT-5.6 Sol", effort: "xhigh" }), {
		requestRender: () => { renders++; },
		scheduleGitRefresh: () => { refreshes++; },
	});
	const wide = component!.render(180).map(stripAnsi).join("\n");
	assert.match(wide, /main \[!2 \?7\] \+ done 35s/);
	assert.match(wide, /25k\/1\.0M/);
	assert.match(wide, /GPT-5\.6 Sol.*xhigh/);
	assert.match(wide, /130k \(U 22k \+ R 108k\)/);
	assert.match(wide, /3\.2k.*93\.5%.*\$0\.000/);
	assert.match(wide, /Freeflow · Muse Spark.*工具状态 准备完毕/);
	assert.doesNotMatch(wide, /footer test/);
	for (let width = 1; width <= 180; width++) {
		for (const line of component!.render(width)) {
			assert.ok(visibleWidth(line) <= width, `overflow at ${width}: ${stripAnsi(line)}`);
		}
	}
	branchListener!();
	assert.equal(refreshes, 1);
	assert.equal(renders, 1);
	cleanup();
	assert.equal(unsubscribed, 1);
});

test("narrow layouts retain segment positions when context is dropped", () => {
	assert.deepEqual(fitSegmentsByPriority([
		{ text: "project", priority: 0 },
		{ text: "context 20%", priority: 4 },
	], 8), ["project", ""]);
});

test("context footer shows occupancy without provenance labels and unknown without measured zero", () => {
	const assistant = usageEntry("1", 1000, 1000, 100);
	const user = { id: "2", parentId: "1", timestamp: "two", type: "message", message: { role: "user", content: "new input", timestamp: 2 } };
	const system = { id: "system", parentId: null, timestamp: "system", type: "message", message: { role: "system", content: "system prompt", timestamp: 1 } };
	for (const entries of [[assistant], [assistant, user], [system], []]) {
		let component: { render(width: number): string[] } | undefined;
		const ctx = contextFor([...entries], { ui: { setFooter: (factory: Function | undefined) => {
			component = factory?.({}, theme, { onBranchChange: () => () => {}, getExtensionStatuses: () => new Map() });
		} } });
		const cleanup = installFooter(ctx, createInitialState, () => ({ provider: "Test", model: "test", effort: undefined }), {
			requestRender() {}, scheduleGitRefresh() {},
		});
		const line = stripAnsi(component!.render(180)[0]);
		assert.doesNotMatch(line, /\busage-anchored\b|\bmixed-estimate\b|\bestimate\b|\bunknown\b/);
		if (entries.length === 0) {
			assert.match(line, /\?\/1\.0M/);
			assert.doesNotMatch(line, /0\.0%|0\/1\.0M|\[#+-*\]/);
		} else assert.match(line, /2\.5%.*25k\/1\.0M/);
		for (let width = 1; width <= 180; width++) {
			for (const rendered of component!.render(width)) {
				assert.ok(visibleWidth(rendered) <= width);
				assert.doesNotMatch(stripAnsi(rendered), /\busage-anchored\b|\bmixed-estimate\b|\bestimate\b|\bunknown\b/);
			}
		}
		cleanup();
	}
});

test("footer unsubscribe is explicit, idempotent and cannot clear a replacement installation", () => {
	let component: { render(width: number): string[]; dispose(): void } | undefined;
	let removals = 0;
	let unsubscribes = 0;
	let requests = 0;
	const listeners: (() => void)[] = [];
	const ctx = contextFor([], { ui: { setFooter: (factory: Function | undefined) => {
		if (!factory) removals++;
		component = factory?.({}, theme, {
			onBranchChange: (fn: () => void) => { listeners.push(fn); return () => { unsubscribes++; }; },
			getExtensionStatuses: () => new Map(),
		});
	} } });
	const hooks = { requestRender: () => { requests++; }, scheduleGitRefresh() {} };
	const meta = () => ({ provider: "Test", model: "test", effort: undefined });
	const firstCleanup = installFooter(ctx, createInitialState, meta, hooks);
	const first = component!;
	const secondCleanup = installFooter(ctx, createInitialState, meta, hooks);
	firstCleanup(); firstCleanup(); first.dispose(); listeners[0]();
	assert.equal(unsubscribes, 1);
	assert.equal(removals, 0);
	assert.equal(requests, 0);
	assert.deepEqual(first.render(120), []);
	listeners[1]();
	assert.equal(requests, 1);
	const second = component!;
	secondCleanup(); secondCleanup(); second.dispose(); listeners[1]();
	assert.equal(unsubscribes, 2);
	assert.equal(removals, 1);
	assert.equal(requests, 1);
});

test("footer releases every subscription before probing an invalidated runner, without context getter reads", () => {
	let invalid = false;
	let cleaning = false;
	let unsubscribes = 0;
	let removals = 0;
	let requests = 0;
	let probes = 0;
	let savedFactory: Function | undefined;
	const staleReads: PropertyKey[] = [];
	const cleanupProbes: { unsubscribes: number; renders: string[][] }[] = [];
	const listeners: (() => void)[] = [];
	const components: { render(width: number): string[]; dispose(): void }[] = [];
	const footerData = {
		onBranchChange(fn: () => void) { listeners.push(fn); return () => { unsubscribes++; }; },
		getExtensionStatuses: () => new Map(),
	};
	const ui = { setFooter(factory: Function | undefined) {
		if (!factory) removals++;
		savedFactory = factory ?? savedFactory;
		if (factory) components.push(factory({}, theme, footerData));
	} };
	const base = contextFor([], { ui, isIdle() {
		probes++;
		if (cleaning) cleanupProbes.push({ unsubscribes, renders: components.map((component) => component.render(120)) });
		if (invalid) throw new Error("runner.assertActive: invalidated context");
		return false;
	} });
	const ctx = new Proxy(base, { get(target, key, receiver) {
		if (invalid) { staleReads.push(key); throw new Error(`runner.assertActive: stale ${String(key)}`); }
		return Reflect.get(target, key, receiver);
	} });
	const cleanup = installFooter(ctx, createInitialState, () => ({ provider: "Test", model: "test", effort: undefined }), {
		requestRender: () => { requests++; }, scheduleGitRefresh: () => { requests++; },
	});
	// A host can replace a factory's component without disposing the previous one.
	components.push(savedFactory!({}, theme, footerData));
	assert.equal(components.length, 2);
	invalid = true;
	assert.throws(() => ctx.sessionManager, /runner\.assertActive/);
	assert.throws(() => ctx.ui, /runner\.assertActive/);
	staleReads.length = 0;
	cleaning = true;
	assert.doesNotThrow(() => cleanup());
	const afterCleanup = probes;
	cleanup();
	for (const listener of listeners) listener();
	for (const component of components) { component.dispose(); assert.deepEqual(component.render(120), []); }
	assert.deepEqual(savedFactory!({}, theme, footerData).render(120), []);
	assert.equal(unsubscribes, 2);
	assert.equal(probes, afterCleanup);
	assert.equal(removals, 0);
	assert.equal(requests, 0);
	assert.deepEqual(cleanupProbes, [{ unsubscribes: 2, renders: [[], []] }], "release all listeners before optional host access");
	assert.deepEqual(staleReads, []);
});

test("footer cleanup releases later subscriptions even when one unsubscribe throws", () => {
	let factory: Function | undefined;
	let unsubscribes = 0;
	let subscriptions = 0;
	let removals = 0;
	let requests = 0;
	const footerData = {
		onBranchChange() {
			const index = subscriptions++;
			return () => {
				unsubscribes++;
				if (index === 0) throw new Error("host unsubscribe failed");
			};
		},
		getExtensionStatuses: () => new Map(),
	};
	const components: { render(width: number): string[]; dispose(): void }[] = [];
	const ctx = contextFor([], { ui: { setFooter(value: Function | undefined) {
		if (!value) removals++;
		factory = value;
		if (value) components.push(value({}, theme, footerData));
	} } });
	const cleanup = installFooter(ctx, createInitialState, () => ({ provider: "Test", model: "test", effort: undefined }), {
		requestRender: () => { requests++; }, scheduleGitRefresh() {},
	});
	components.push(factory!({}, theme, footerData));
	assert.throws(cleanup, (error) => error instanceof AggregateError && error.errors.length === 1
		&& /host unsubscribe failed/.test(error.errors[0].message));
	assert.equal(unsubscribes, 2);
	assert.equal(removals, 0, "failed local releases skip optional host clearing");
	assert.doesNotThrow(cleanup);
	for (const component of components) { component.dispose(); assert.deepEqual(component.render(120), []); }
	assert.equal(unsubscribes, 2);
	assert.equal(requests, 0);
});

test("host-disposed footer does not clear another extension's replacement", () => {
	let component: { dispose(): void } | undefined;
	let removals = 0;
	let unsubscribes = 0;
	const ctx = contextFor([], { ui: { setFooter: (factory: Function | undefined) => {
		if (!factory) removals++;
		component = factory?.({}, theme, { onBranchChange: () => () => { unsubscribes++; }, getExtensionStatuses: () => new Map() });
	} } });
	const cleanup = installFooter(ctx, createInitialState, () => ({ provider: "", model: "test", effort: undefined }), {
		requestRender() {}, scheduleGitRefresh() {},
	});
	component!.dispose(); cleanup();
	assert.equal(unsubscribes, 1);
	assert.equal(removals, 0);
});

test("git parser handles divergence, stashes, rename paths, and detached HEAD", () => {
	const status = parseGitStatus([
		"# branch.oid abc123", "# branch.head main", "# branch.ab +3 -2", "# stash 4",
		"1 .M N... 100644 100644 100644 a b modified.ts",
		"2 R. N... 100644 100644 100644 a b R100 renamed.ts", "? this-is-the-old-name",
		"? actual-untracked", "u UU N... conflict.ts", "",
	].join("\0"));
	assert.equal(status.branch, "main");
	assert.equal(status.ahead, 3);
	assert.equal(status.behind, 2);
	assert.equal(status.stashed, 4);
	assert.equal(status.renamed, 1);
	assert.equal(status.untracked, 1);
	assert.equal(status.conflicted, 1);
	assert.equal(status.modified, 1);
	assert.deepEqual(parseGitStatus("# branch.oid abc123\0# branch.head (detached)\0").commit, {
		oid: "abc123", detached: true, tag: null,
	});
});

test("git status works in an unborn repository subdirectory and outside repositories", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-ui-git-"));
	try {
		assert.equal((await readGitStatus(root)).branch, undefined);
		execFileSync("git", ["init", "--initial-branch=main", root], { stdio: "ignore" });
		await mkdir(join(root, "src"));
		await writeFile(join(root, "src", "example.ts"), "export {};\n");
		const status = await readGitStatus(join(root, "src"));
		assert.equal(status.branch, "main");
		assert.equal(status.untracked, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
