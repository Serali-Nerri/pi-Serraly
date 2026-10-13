import assert from "node:assert/strict";
import { test } from "node:test";
import { DAY, loopHarness, MINUTE } from "./helpers.ts";

// These exercise the registered command/events, never source text or mock implementation.
test("does not execute or create a loop until the session is ready", (t) => {
	const h = loopHarness(t);
	h.command("1m check");
	assert.deepEqual(h.delivered, []);
	assert.match(h.notices.at(-1)?.message ?? "", /会话尚未就绪/);
	h.tick(MINUTE);
	assert.deepEqual(h.delivered, []);
});

test("runs immediately then only at the exact interval boundary", (t) => {
	const h = loopHarness(t);
	h.emit("session_start");
	h.command("1m check");
	assert.deepEqual(h.delivered, [{ prompt: "check", expandPromptTemplates: false }]);
	assert.equal(h.statuses.get("local-loop"), "loops: 1");
	h.emit("agent_start");
	h.tick(MINUTE - 1);
	assert.equal(h.delivered.length, 1);
	h.tick(1);
	assert.equal(h.delivered.length, 2);
});

test("coalesces missed busy intervals and resumes at agent_settled, not agent_end", (t) => {
	const h = loopHarness(t);
	h.emit("session_start");
	h.setIdle(false);
	h.command("1m check");
	h.tick(MINUTE * 4);
	assert.deepEqual(h.delivered, []);
	h.command("list");
	assert.match(h.notices.at(-1)?.message ?? "", /等待空闲/);
	h.setIdle(true);
	h.emit("agent_end");
	assert.deepEqual(h.delivered, []);
	h.emit("agent_settled");
	assert.deepEqual(h.delivered, [{ prompt: "check", expandPromptTemplates: false }]);
	h.emit("agent_settled");
	assert.equal(h.delivered.length, 1);
	h.tick(MINUTE - 1);
	assert.equal(h.delivered.length, 1);
	h.tick(1);
	assert.equal(h.delivered.length, 2);
});

test("does not dispatch while a user message is queued even if idle", (t) => {
	const h = loopHarness(t);
	h.emit("session_start");
	h.setQueued(true);
	h.command("1m check");
	h.tick(MINUTE);
	h.emit("agent_settled");
	assert.deepEqual(h.delivered, []);
	h.setQueued(false);
	h.emit("agent_settled");
	assert.equal(h.delivered.length, 1);
});

test("serializes pending loops in creation order", (t) => {
	const h = loopHarness(t);
	h.emit("session_start");
	h.command("1m first");
	h.command("1m second");
	h.command("1m third");
	assert.deepEqual(h.delivered.map((entry) => entry.prompt), ["first"]);
	h.emit("agent_settled");
	assert.deepEqual(h.delivered.map((entry) => entry.prompt), ["first", "second"]);
	h.emit("agent_settled");
	assert.deepEqual(h.delivered.map((entry) => entry.prompt), ["first", "second", "third"]);
	h.emit("agent_settled");
	assert.equal(h.delivered.length, 3);
});

test("stop cancels a pending loop without altering another loop", (t) => {
	const h = loopHarness(t);
	h.emit("session_start");
	h.setIdle(false);
	h.command("1m stop-me");
	const id = h.createdId();
	h.command("1m keep-me");
	h.command(`stop ${id}`);
	assert.match(h.notices.at(-1)?.message ?? "", /已停止 Loop/);
	assert.equal(h.statuses.get("local-loop"), "loops: 1");
	h.setIdle(true);
	h.emit("agent_settled");
	h.emit("agent_start");
	h.tick(MINUTE);
	assert.deepEqual(h.delivered.map((entry) => entry.prompt), ["keep-me", "keep-me"]);
});

test("stopping the last job removes its status and is safe to repeat", (t) => {
	const h = loopHarness(t);
	h.emit("session_start");
	h.setIdle(false);
	h.command("1m check");
	const id = h.createdId();
	h.command(`stop ${id}`);
	assert.equal(h.statuses.get("local-loop"), undefined);
	h.command(`stop ${id}`);
	assert.match(h.notices.at(-1)?.message ?? "", /找不到 Loop/);
	h.setIdle(true);
	h.tick(MINUTE * 2);
	h.emit("agent_settled");
	assert.deepEqual(h.delivered, []);
	h.command("list");
	assert.match(h.notices.at(-1)?.message ?? "", /没有运行中的 Loop/);
});

test("lists IDs, intervals and a single-line prompt preview", (t) => {
	const h = loopHarness(t);
	h.emit("session_start");
	h.setIdle(false);
	h.command("2h review\n  build");
	const id = h.createdId();
	h.command("list");
	const listing = h.notices.at(-1)?.message ?? "";
	assert.ok(listing.includes(`${id}  120m  等待空闲  review build`));
	assert.match(listing, /\/loop stop <ID>/);
});

test("limits live jobs to 50 and permits replacement after stopping one", (t) => {
	const h = loopHarness(t);
	h.emit("session_start");
	h.setIdle(false);
	let id = "";
	for (let i = 0; i < 50; i++) {
		h.command(`1m check-${i}`);
		id = h.createdId();
	}
	h.command("1m overflow");
	assert.match(h.notices.at(-1)?.message ?? "", /最多 50 个 Loop/);
	assert.equal(h.statuses.get("local-loop"), "loops: 50");
	h.command(`stop ${id}`);
	h.command("1m replacement");
	h.createdId();
	assert.equal(h.statuses.get("local-loop"), "loops: 50");
});

test("only expands loaded skill commands and prompt templates", (t) => {
	const h = loopHarness(t);
	h.emit("session_start");
	h.setCommands([
		{ name: "skill:review", source: "skill" },
		{ name: "template", source: "prompt" },
		{ name: "other", source: "extension" },
	]);
	for (const prompt of ["/reload", "/missing", "/other"]) {
		h.command(`1m ${prompt}`);
		assert.match(h.notices.at(-1)?.message ?? "", /Pi 内置命令不支持/);
	}
	assert.equal(h.delivered.length, 0);
	h.command("1m /skill:review all");
	h.emit("agent_settled");
	h.command("1m /template arg");
	assert.deepEqual(h.delivered, [
		{ prompt: "/skill:review all", expandPromptTemplates: true },
		{ prompt: "/template arg", expandPromptTemplates: true },
	]);
});

test("rejects an invalid interval without allocating a job", (t) => {
	const h = loopHarness(t);
	h.emit("session_start");
	h.command("0m check");
	assert.equal(h.notices.at(-1)?.level, "warning");
	assert.equal(h.statuses.get("local-loop"), undefined);
	h.tick(MINUTE);
	assert.deepEqual(h.delivered, []);
});

test("expires at exactly seven days without a final dispatch", (t) => {
	const h = loopHarness(t);
	h.emit("session_start");
	h.setIdle(false);
	h.command("1d check");
	h.tick(7 * DAY - 1);
	assert.equal(h.statuses.get("local-loop"), "loops: 1");
	h.tick(1);
	assert.equal(h.statuses.get("local-loop"), undefined);
	assert.match(h.notices.at(-1)?.message ?? "", /已到期（7 天）/);
	h.setIdle(true);
	h.emit("agent_settled");
	assert.deepEqual(h.delivered, []);
});

test("a delayed timer skips the backlog and schedules from the current time", (t) => {
	const h = loopHarness(t);
	h.emit("session_start");
	h.command("1m check");
	h.emit("agent_start");
	// setTime changes wall time without executing callbacks, like suspend/resume.
	h.setTime(Date.now() + 5 * MINUTE);
	h.tick(MINUTE);
	assert.equal(h.delivered.length, 2);
	h.emit("agent_start");
	h.tick(MINUTE - 1);
	assert.equal(h.delivered.length, 2);
	h.tick(1);
	assert.equal(h.delivered.length, 3);
});

test("session replacement drops jobs and does not reconstruct them from the same ID", (t) => {
	const h = loopHarness(t);
	h.emit("session_start");
	h.setIdle(false);
	h.command("1m old");
	h.emit("session_start");
	h.setIdle(true);
	h.tick(MINUTE);
	h.emit("agent_settled");
	assert.equal(h.delivered.length, 0);
	assert.equal(h.statuses.get("local-loop"), undefined);
	h.command("1m new");
	assert.deepEqual(h.delivered.map((entry) => entry.prompt), ["new"]);
});

test("does not send a timer prompt when the context reports a different session", (t) => {
	const h = loopHarness(t);
	h.emit("session_start");
	h.setIdle(false);
	h.command("1m old");
	h.setSessionId("different-synthetic-session");
	h.setIdle(true);
	h.tick(MINUTE);
	h.emit("agent_settled");
	assert.deepEqual(h.delivered, []);
});

test("shutdown is idempotent and prevents later pending dispatches", (t) => {
	const h = loopHarness(t);
	h.emit("session_start");
	h.setIdle(false);
	h.command("1m old");
	h.emit("session_shutdown");
	h.emit("session_shutdown");
	h.setIdle(true);
	h.tick(MINUTE * 2);
	h.emit("agent_settled");
	assert.deepEqual(h.delivered, []);
	assert.equal(h.statuses.get("local-loop"), undefined);
});

// RED regressions: the imported implementation leaves delivery watchdogs unowned.
test("shutdown cancels the delivery watchdog before its context is disposed", (t) => {
	const h = loopHarness(t);
	h.emit("session_start");
	h.command("1m check");
	h.emit("session_shutdown");
	h.invalidateContext();
	assert.doesNotThrow(() => h.tick(5000));
	assert.equal(h.delivered.length, 1);
});

test("agent_start cancels the pre-start delivery watchdog", (t) => {
	const h = loopHarness(t);
	h.emit("session_start");
	h.command("1m check");
	h.emit("agent_start");
	h.invalidateContext();
	assert.doesNotThrow(() => h.tick(5000));
});

test("the command returns a promise for the Pi 1.2.0 command contract", async (t) => {
	const h = loopHarness(t);
	h.emit("session_start");
	const result = h.command("1m check");
	assert.ok(result instanceof Promise);
	await result;
	assert.deepEqual(h.delivered.map((entry) => entry.prompt), ["check"]);
});

test("a delivery exception does not permanently block other pending jobs", async (t) => {
	const h = loopHarness(t);
	h.emit("session_start");
	h.setDeliveryError(true);
	await assert.rejects(h.command("1m failed") as Promise<void>, /scripted delivery failure/);
	h.setDeliveryError(false);
	h.command("1m next");
	assert.deepEqual(h.delivered.map((entry) => entry.prompt), ["next"]);
});
