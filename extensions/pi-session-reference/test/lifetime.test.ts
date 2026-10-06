import assert from "node:assert/strict";
import fs, { rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { AgentSessionRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { harness, references } from "./harness.ts";

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((done) => { release = done; });
	return { promise, release };
}

test("late discovery cannot restore removed candidates after tree navigation, and shutdown leaves old providers inert", async (t) => {
	const h = await harness(t, "tui");
	const old = h.source("old history", "Old candidate");
	await h.session.prompt("Current branch");
	const target = h.manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user")!.id;
	const entered = gate(), finish = gate();
	const original = SessionManager.listAll.bind(SessionManager);
	let pause = true;
	t.mock.method(SessionManager, "listAll", async (dir?: string) => {
		const result = await original(dir);
		if (pause) { pause = false; entered.release(); await finish.promise; }
		return result;
	});
	const pending = h.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
	try {
		await entered.promise;
		await rm(old.getSessionFile()!);
		const fresh = h.source("fresh history", "Fresh candidate");
		assert.equal((await h.session.navigateTree(target)).cancelled, false);
		finish.release();
		await pending;
		const provider = h.factories.at(-1)!(new CombinedAutocompleteProvider([], h.cwd));
		const options = { signal: new AbortController().signal };
		const result = await provider.getSuggestions(["@session:"], 0, 9, options);
		assert.ok(result?.items.some((item) => item.value.includes(fresh.getSessionId())));
		assert.ok(!result?.items.some((item) => item.value.includes(old.getSessionId())));
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
		assert.equal((await provider.getSuggestions(["@session:"], 0, 9, options))?.items.length ?? 0, 0);
	} finally { finish.release(); await pending; }
});

test("cancelled host navigation preserves completion while invalidating pending selected reads", async (t) => {
	for (const transition of ["tree", "new", "resume", "fork"] as const) {
		await t.test(transition, { timeout: 8000 }, async (t) => {
			const h = await harness(t, "tui", "custom", (pi) => {
				pi.on("session_before_tree", () => ({ cancel: true }));
				pi.on("session_before_switch", () => ({ cancel: true }));
				pi.on("session_before_fork", () => ({ cancel: true }));
			});
			await h.session.prompt("Current branch");
			const target = h.manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user")!.id;
			const source = h.source("HISTORY AFTER CANCEL", "Still available");
			await h.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
			const provider = h.factories.at(-1)!(new CombinedAutocompleteProvider([], h.cwd));
			const options = { signal: new AbortController().signal };
			const suggestions = () => provider.getSuggestions(["@session:"], 0, 9, options);
			const before = await suggestions();
			assert.ok(before?.items.some((item) => item.value.includes(source.getSessionId())));
			const runtime = new AgentSessionRuntime(h.session, h.services, async () => assert.fail("cancelled navigation must not replace the runtime"));
			const leaf = h.manager.getLeafId();
			const entered = gate(), finish = gate();
			const original = fs.readFile;
			t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
				const bytes = await original(...args);
				if (String(args[0]) === source.getSessionFile()) { entered.release(); await finish.promise; }
				return bytes;
			});
			syncBuiltinESMExports();
			const pending = h.session.extensionRunner.emitBeforeAgentStart(`@session:[${source.getSessionId()}]`, undefined, { cwd: h.cwd, selectedTools: [] });
			try {
				await entered.promise;
				const result = transition === "tree" ? await h.session.navigateTree(target)
					: transition === "new" ? await runtime.newSession()
					: transition === "resume" ? await runtime.switchSession(source.getSessionFile()!)
					: await runtime.fork(target);
				assert.equal(result.cancelled, true);
				assert.equal(h.manager.getLeafId(), leaf);
				finish.release();
				assert.deepEqual((await pending).messages, [], "a read begun before navigation is stale even when navigation is cancelled");
				assert.deepEqual(await suggestions(), before, "unchanged session retains completion without an after event");
			} finally {
				finish.release();
				await pending;
				t.mock.restoreAll();
				syncBuiltinESMExports();
			}
			await h.session.prompt(`Use @session:[${source.getSessionId()}] after cancelling`);
			assert.match(String(references(h).at(-1)?.content), /HISTORY AFTER CANCEL/);
		});
	}
});

test("delayed selected reads never inject across new, resume, fork, tree, reload or shutdown", async (t) => {
	for (const transition of ["new", "resume", "fork", "tree", "reload", "quit"] as const) {
		await t.test(transition, { timeout: 8000 }, async (t) => {
			const h = await harness(t);
			const source = h.source("STALE SOURCE MUST NOT INJECT");
			let target: string | undefined;
			if (transition === "tree") {
				await h.session.prompt("Current branch");
				target = h.manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user")!.id;
			}
			const entered = gate(), finish = gate();
			const original = fs.readFile;
			t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
				const bytes = await original(...args);
				if (String(args[0]) === source.getSessionFile()) { entered.release(); await finish.promise; }
				return bytes;
			});
			syncBuiltinESMExports();
			const runner = h.session.extensionRunner;
			const pending = runner.emitBeforeAgentStart(`@session:[${source.getSessionId()}]`, undefined, { cwd: h.cwd, selectedTools: [] });
			try {
				await entered.promise;
				if (transition === "new" || transition === "resume") {
					await runner.emit({ type: "session_before_switch", reason: transition });
				} else if (transition === "fork") {
					await runner.emit({ type: "session_before_fork", entryId: "fixture", position: "at" });
				} else if (transition === "tree") {
					assert.equal((await h.session.navigateTree(target!)).cancelled, false);
				} else await runner.emit({ type: "session_shutdown", reason: transition });
				finish.release();
				assert.deepEqual((await pending).messages, []);
			} finally {
				finish.release();
				await pending;
				t.mock.restoreAll();
				syncBuiltinESMExports();
			}
		});
	}
});
