import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { UiScheduler } from "../../src/scheduler.ts";
import { createShellController, type ShellQueries } from "../../src/shell/controller.ts";
import { emptyGitStatus, type GitStatus } from "../../src/shell/git.ts";
import type { RuntimeInfo } from "../../src/shell/runtime.ts";
import { stripAnsi } from "../../src/shell/utils.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
type View = Component & { dispose?(): void };

class SchedulerHarness {
	jobs = new Map<string, { delay: number; callback: () => void; repeat: boolean }>();
	renders = 0;
	request() { this.renders++; }
	schedule(key: string, delay: number, callback: () => void, repeat = false) {
		const job = { delay, callback, repeat };
		this.jobs.set(key, job);
		return () => { if (this.jobs.get(key) === job) this.cancel(key); };
	}
	cancel(key: string) { this.jobs.delete(key); }
	flush(suffix: string) {
		for (const [key, job] of Array.from(this.jobs)) {
			if (!key.endsWith(suffix)) continue;
			if (!job.repeat) this.jobs.delete(key);
			job.callback();
		}
	}
	get scheduler() { return this as unknown as UiScheduler; }
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
async function settle() { await Promise.resolve(); await Promise.resolve(); }

function harness(queries: ShellQueries = { git: async () => emptyGitStatus(), runtime: async () => null }) {
	let footer: View | undefined;
	let removedFooter = 0;
	let unsubscribed = 0;
	const branches: (() => void)[] = [];
	const scheduler = new SchedulerHarness();
	const pi = new Proxy({ getCommands: () => [{ name: "review" }], getThinkingLevel: () => "high" }, {
		get(target, key) { assert.ok(key in target, `unowned ExtensionAPI access: ${String(key)}`); return Reflect.get(target, key); },
	}) as unknown as ExtensionAPI;
	const ui = new Proxy({ theme,
		setFooter(factory: Function | undefined) {
			// Deliberately do NOT dispose old components: the controller must own cleanup.
			if (!factory) removedFooter++;
			footer = factory?.({ requestRender() { throw new Error("separate TUI bridge"); } }, theme, {
				onBranchChange(fn: () => void) { branches.push(fn); return () => { unsubscribed++; }; },
				getExtensionStatuses: () => new Map([["test", "other extension status"]]),
			});
		},
	}, { get(target, key) { assert.ok(key in target, `unowned UI access: ${String(key)}`); return Reflect.get(target, key); } });
	function context(manager: ExtensionContext["sessionManager"] = SessionManager.inMemory("/tmp/pi-ui-synthetic"), cwd = "/tmp/pi-ui-synthetic"): ExtensionContext {
		return { mode: "tui", hasUI: true, cwd, ui, sessionManager: manager, isIdle: () => true,
			model: { provider: "test", id: "test", reasoning: true, contextWindow: 100000 },
			getContextUsage: () => ({ tokens: null, percent: null, contextWindow: 100000 }), getSystemPrompt: () => "",
		} as unknown as ExtensionContext;
	}
	const controller = createShellController(pi, scheduler.scheduler, queries);
	// The synthetic UI deliberately omits `setHeader`: the proxy asserts on any
	// unowned access, so installing a startup header fails the test itself.
	return { controller, pi, scheduler, context, branches, footer: () => footer,
		removedFooter: () => removedFooter, unsubscribed: () => unsubscribed };
}

// Model Pi 1.2.0: all context getters and the captured public liveness query
// reject after runner invalidation, even if the manager and session ID survive.
function invalidatableContext(base: ExtensionContext, onProbe = () => {}) {
	let active = true;
	const staleReads: PropertyKey[] = [];
	const ctx = new Proxy({ ...base, isIdle() {
		onProbe();
		if (!active) throw new Error("runner.assertActive: invalidated context");
		return false; // Busy is still current; the result is not an activity guard.
	} }, {
		get(target, property, receiver) {
			if (!active) {
				staleReads.push(property);
				throw new Error(`runner.assertActive: stale ${String(property)} getter`);
			}
			return Reflect.get(target, property, receiver);
		},
	});
	return { ctx, staleReads, invalidate: () => { active = false; } };
}

test("controller installs the footer shell, uses only owned scheduler jobs and releases subscriptions without host disposal", async () => {
	const h = harness();
	const ctx = h.context();
	h.scheduler.schedule("parent:work", 1, () => {}, true);
	h.controller.start(ctx);
	assert.match(h.footer()!.render(180).join("\n"), /other extension status/);
	h.scheduler.flush(":git"); h.scheduler.flush(":runtime"); await settle();
	h.controller.agentStart();
	assert.match(h.footer()!.render(180).join("\n"), /working/);
	const activity = Array.from(h.scheduler.jobs.values()).find((job) => job.delay === 250)!;
	assert.equal(activity.repeat, true);
	h.controller.agentStart();
	assert.equal(Array.from(h.scheduler.jobs.keys()).filter((key) => key.endsWith(":activity")).length, 1);
	h.controller.agentEnd(ctx);
	assert.match(h.footer()!.render(180).join("\n"), /done/);
	assert.equal(Array.from(h.scheduler.jobs.keys()).some((key) => key.endsWith(":activity")), false);
	const footer = h.footer()!;
	h.controller.dispose(); h.controller.dispose();
	assert.equal(h.unsubscribed(), 1);
	assert.equal(h.removedFooter(), 1);
	assert.deepEqual(Array.from(h.scheduler.jobs.keys()), ["parent:work"]);
	const renders = h.scheduler.renders;
	h.branches[0](); activity.callback(); footer.dispose?.();
	assert.deepEqual(footer.render(180), []);
	assert.equal(h.scheduler.renders, renders);
	assert.equal(h.unsubscribed(), 1);
});

test("controller skips every non-TUI mode and exposes no event or widget integration", () => {
	const h = harness();
	for (const mode of ["rpc", "json", "print", "tui"] as const) {
		const ctx = { ...h.context(), mode, hasUI: mode !== "tui", ui: new Proxy({}, { get() { throw new Error("unexpected UI access"); } }) } as ExtensionContext;
		h.controller.start(ctx);
		h.controller.agentStart(); h.controller.messageEnd(); h.controller.toolEnd(ctx);
		h.controller.modelChanged(); h.controller.rebuild(ctx); h.controller.agentEnd(ctx);
		h.controller.dispose();
		assert.equal(h.scheduler.jobs.size, 0);
		assert.equal(h.scheduler.renders, 0);
	}
});

test("Git refresh requests coalesce before launch and into one follow-up during an in-flight job", async () => {
	const jobs: ReturnType<typeof deferred<GitStatus>>[] = [];
	const h = harness({ git: async (_cwd, options) => {
		assert.deepEqual(options, { readCommit: true, readTag: false, readCounts: true });
		const job = deferred<GitStatus>(); jobs.push(job); return job.promise;
	}, runtime: async () => null });
	const ctx = h.context();
	h.controller.start(ctx);
	for (let i = 0; i < 30; i++) h.controller.toolEnd(ctx);
	assert.equal(Array.from(h.scheduler.jobs.keys()).filter((key) => key.endsWith(":git")).length, 1);
	h.scheduler.flush(":git");
	assert.equal(jobs.length, 1);
	for (let i = 0; i < 30; i++) { h.controller.toolEnd(ctx); h.branches[0](); }
	assert.equal(jobs.length, 1);
	jobs[0].resolve({ ...emptyGitStatus(), branch: "first" }); await settle();
	assert.equal(jobs.length, 2);
	jobs[1].resolve({ ...emptyGitStatus(), branch: "final" }); await settle();
	assert.equal(jobs.length, 2);
	assert.match(h.footer()!.render(180).join("\n"), /final/);
	h.controller.dispose();
});

test("generation guards ignore Git/runtime completions and queued callbacks from replaced sessions", async () => {
	const gitJobs: ReturnType<typeof deferred<GitStatus>>[] = [];
	const runtimeJobs: ReturnType<typeof deferred<RuntimeInfo | null>>[] = [];
	const h = harness({ git: async () => { const job = deferred<GitStatus>(); gitJobs.push(job); return job.promise; },
		runtime: async () => { const job = deferred<RuntimeInfo | null>(); runtimeJobs.push(job); return job.promise; } });
	const old = h.context();
	h.controller.start(old); h.scheduler.flush(":git"); h.scheduler.flush(":runtime");
	h.controller.agentStart();
	const staleActivity = Array.from(h.scheduler.jobs.values()).find((job) => job.repeat)!.callback;
	const staleFooter = h.footer()!;
	const fresh = h.context();
	h.controller.start(fresh);
	const baseline = h.scheduler.renders;
	gitJobs[0].resolve({ ...emptyGitStatus(), branch: "STALE" }); runtimeJobs[0].resolve({ name: "STALE", version: "123" });
	await settle(); staleActivity(); h.branches[0]();
	h.controller.toolEnd(old); h.controller.agentEnd(old); h.controller.rebuild(old);
	assert.equal(h.scheduler.renders, baseline);
	assert.deepEqual(staleFooter.render(180), []);
	assert.doesNotMatch(h.footer()!.render(180).join("\n"), /STALE|working|done/);
	h.scheduler.flush(":git"); h.scheduler.flush(":runtime");
	gitJobs[1].resolve({ ...emptyGitStatus(), branch: "fresh" }); runtimeJobs[1].resolve({ name: "nodejs", version: "24.0.0" });
	await settle();
	assert.match(h.footer()!.render(180).map(stripAnsi).join("\n"), /fresh.*24\.0\.0/);
	h.controller.dispose();
	assert.equal(h.unsubscribed(), 2);
});

test("a reused manager's replaced session cleans listeners but never clears stale host UI", () => {
	const h = harness();
	const manager = SessionManager.inMemory("/tmp/pi-ui-synthetic");
	const old = h.context(manager);
	h.controller.start(old);
	const oldEventContext = h.context(manager);
	h.controller.toolEnd(oldEventContext);
	const footer = h.footer()!;
	manager.newSession();
	const renders = h.scheduler.renders;
	h.branches[0](); h.controller.agentEnd(old); h.controller.messageEnd();
	assert.equal(h.scheduler.renders, renders);
	h.controller.dispose();
	assert.equal(h.unsubscribed(), 1);
	assert.equal(h.removedFooter(), 0);
	assert.deepEqual(footer.render(180), []);
	const fresh = h.context(manager);
	h.controller.start(fresh);
	const before = h.scheduler.renders;
	h.controller.toolEnd(old); h.controller.rebuild(old); h.controller.agentEnd(old);
	h.controller.toolEnd(oldEventContext); h.controller.rebuild(oldEventContext); h.controller.agentEnd(oldEventContext);
	assert.equal(h.scheduler.renders, before);
	h.controller.dispose();
	assert.equal(h.unsubscribed(), 2);
});

for (const replacement of ["foreign", "new shell"] as const) {
	test(`invalidated getter cleanup releases owned work without touching a ${replacement} installation`, () => {
		let gitCalls = 0;
		let runtimeCalls = 0;
		const queries: ShellQueries = {
			git: async () => { gitCalls++; return emptyGitStatus(); },
			runtime: async () => { runtimeCalls++; return null; },
		};
		const h = harness(queries);
		const base = h.context();
		let disposing = false;
		const disposalProbes: { unsubscribed: number; ownedJobs: number }[] = [];
		const old = invalidatableContext(base, () => {
			if (!disposing) return;
			disposalProbes.push({ unsubscribed: h.unsubscribed(), ownedJobs: oldKeys.filter((key) => h.scheduler.jobs.has(key)).length });
		});
		h.scheduler.schedule("parent:work", 1, () => {}, true);
		h.controller.start(old.ctx);
		h.controller.agentStart();
		const oldFooter = h.footer()!;
		const oldKeys = Array.from(h.scheduler.jobs.keys()).filter((key) => key !== "parent:work");
		assert.equal(oldKeys.length, 3);
		const oldCallbacks = oldKeys.map((key) => h.scheduler.jobs.get(key)!.callback);
		old.invalidate();
		// These synthetic getters really throw, rather than merely swapping IDs.
		assert.throws(() => old.ctx.sessionManager, /runner\.assertActive/);
		assert.throws(() => old.ctx.ui, /runner\.assertActive/);
		old.staleReads.length = 0;
		let newer: ReturnType<typeof createShellController> | undefined;
		if (replacement === "foreign") {
			base.ui.setFooter(() => ({ invalidate() {}, render: () => ["foreign footer"] }));
		} else {
			newer = createShellController(h.pi, h.scheduler.scheduler, queries);
			// Same UI, manager and ID: ownership and runner validity must suffice.
			newer.start(h.context(base.sessionManager));
		}
		const newFooter = h.footer();
		const remainingKeys = Array.from(h.scheduler.jobs.keys()).filter((key) => !oldKeys.includes(key));
		const renders = h.scheduler.renders;
		h.controller.messageEnd(); h.branches[0]();
		assert.deepEqual(oldFooter.render(180), []);
		disposing = true;
		assert.doesNotThrow(() => h.controller.dispose());
		assert.doesNotThrow(() => h.controller.dispose());
		for (const callback of oldCallbacks) callback();
		h.branches[0](); oldFooter.dispose?.();
		assert.equal(h.unsubscribed(), 1);
		assert.equal(h.removedFooter(), 0);
		assert.equal(h.footer(), newFooter);
		assert.deepEqual(Array.from(h.scheduler.jobs.keys()), remainingKeys);
		assert.equal(h.scheduler.renders, renders);
		assert.equal(gitCalls, 0); assert.equal(runtimeCalls, 0);
		assert.deepEqual(old.staleReads, [], "cleanup and stale callbacks never re-read the old context");
		assert.deepEqual(disposalProbes, replacement === "foreign" ? [
			{ unsubscribed: 1, ownedJobs: 0 },
		] : [], "local jobs and subscriptions are released before any host liveness query");
		newer?.dispose();
		assert.deepEqual(Array.from(h.scheduler.jobs.keys()), ["parent:work"]);
	});
}

test("restart after runner invalidation ignores in-flight results and coalesced Git follow-ups", async () => {
	const gitJobs: ReturnType<typeof deferred<GitStatus>>[] = [];
	const runtimeJobs: ReturnType<typeof deferred<RuntimeInfo | null>>[] = [];
	const h = harness({
		git: async () => { const job = deferred<GitStatus>(); gitJobs.push(job); return job.promise; },
		runtime: async () => { const job = deferred<RuntimeInfo | null>(); runtimeJobs.push(job); return job.promise; },
	});
	const old = invalidatableContext(h.context());
	h.controller.start(old.ctx);
	h.scheduler.flush(":git"); h.scheduler.flush(":runtime");
	h.controller.agentStart();
	for (let i = 0; i < 30; i++) h.controller.toolEnd(old.ctx);
	const activity = Array.from(h.scheduler.jobs.values()).find((job) => job.repeat)!.callback;
	const oldFooter = h.footer()!;
	old.invalidate();
	const fresh = h.context();
	assert.doesNotThrow(() => h.controller.start(fresh));
	assert.equal(h.unsubscribed(), 1);
	assert.equal(h.removedFooter(), 0);
	const freshFooter = h.footer();
	const renders = h.scheduler.renders;
	gitJobs[0].resolve({ ...emptyGitStatus(), branch: "STALE" });
	runtimeJobs[0].resolve({ name: "STALE", version: "123" });
	await settle();
	activity(); h.branches[0]();
	h.controller.toolEnd(old.ctx); h.controller.agentEnd(old.ctx); h.controller.rebuild(old.ctx);
	assert.deepEqual(oldFooter.render(180), []);
	assert.equal(h.footer(), freshFooter);
	assert.equal(h.scheduler.renders, renders);
	assert.equal(gitJobs.length, 1, "no stale coalesced follow-up");
	assert.equal(runtimeJobs.length, 1);
	assert.deepEqual(old.staleReads, []);
	h.scheduler.flush(":git"); h.scheduler.flush(":runtime");
	gitJobs[1].resolve({ ...emptyGitStatus(), branch: "fresh" }); runtimeJobs[1].resolve(null);
	await settle();
	assert.match(h.footer()!.render(180).join("\n"), /fresh/);
	h.controller.dispose(); h.controller.dispose();
	assert.equal(h.unsubscribed(), 2);
	assert.equal(h.removedFooter(), 1);
	assert.equal(h.scheduler.jobs.size, 0);
});

test("billing usage appended while idle is visible on the next host-requested render", () => {
	const h = harness();
	const manager = SessionManager.inMemory("/tmp/pi-ui-synthetic");
	const ctx = h.context(manager);
	h.controller.start(ctx);
	assert.match(h.footer()!.render(180).join("\n"), /\$0\.000/);
	manager.appendUsage("cache_warm", "test", "test", { input: 1000, cacheWrite: 2000, cacheRead: 4000, output: 0, totalTokens: 7000,
		cost: { input: 0.1, cacheWrite: 0.2, cacheRead: 0.3, output: 0, total: 0.6 } });
	const rendered = h.footer()!.render(180).join("\n");
	assert.match(rendered, /7\.0k \(U 3\.0k \+ R 4\.0k\)/);
	assert.match(rendered, /\$0\.600/);
	assert.match(rendered, /\?\/100k/);
	assert.doesNotMatch(rendered, /unknown|usage-anchored|mixed-estimate/);
	assert.doesNotMatch(rendered.split("\n")[0], /0\.0%|0\/100k/);
	h.controller.dispose();
});

test("rejected queries are contained and disposal does not stop parent scheduler resources", async () => {
	const h = harness({ git: async () => { throw new Error("Git unavailable"); }, runtime: async () => { throw new Error("runtime unavailable"); } });
	h.controller.start(h.context());
	h.scheduler.flush(":git"); h.scheduler.flush(":runtime"); await settle();
	assert.doesNotThrow(() => h.footer()!.render(120));
	h.controller.dispose();
});

test("failed host installation rolls back every acquired footer subscription", () => {
	const h = harness();
	const ctx = h.context();
	const originalUI = ctx.ui;
	ctx.ui = { ...originalUI, setFooter(factory) {
		originalUI.setFooter(factory);
		if (factory) throw new Error("host rejected installed footer");
	} };
	assert.throws(() => h.controller.start(ctx), /host rejected installed footer/);
	assert.equal(h.unsubscribed(), 1);
	assert.equal(h.scheduler.jobs.size, 0);
	assert.deepEqual(h.footer()!.render(120), []);
	h.controller.dispose();
	assert.equal(h.unsubscribed(), 1);
});
