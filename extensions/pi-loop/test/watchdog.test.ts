import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loopHarness } from "./helpers.ts";

test("watchdog releases the dispatch gate after five idle seconds without agent_start", (t) => {
	const h = loopHarness(t);
	h.emit("session_start");
	h.command("1m first");
	h.command("1m second");
	h.tick(4999);
	assert.deepEqual(h.delivered.map((entry) => entry.prompt), ["first"]);
	h.tick(1);
	h.command("1m third");
	assert.deepEqual(h.delivered.map((entry) => entry.prompt), ["first", "second"]);
});

test("watchdog does not unlock while the agent remains busy", (t) => {
	const h = loopHarness(t);
	h.emit("session_start");
	h.command("1m first");
	h.setIdle(false);
	h.tick(5000);
	h.setIdle(true);
	h.command("1m second");
	assert.deepEqual(h.delivered.map((entry) => entry.prompt), ["first"]);
	h.emit("agent_settled");
	assert.deepEqual(h.delivered.map((entry) => entry.prompt), ["first", "second"]);
});

test("same-ID session_start clears a previous context's watchdog", (t) => {
	const h = loopHarness(t);
	h.emit("session_start");
	h.command("1m old");
	const fresh = {
		...h.ctx,
		ui: { setStatus: () => {}, notify: () => {} },
		sessionManager: { getSessionId: () => "synthetic-session" },
		isIdle: () => true,
		hasPendingMessages: () => false,
	} as unknown as ExtensionCommandContext;
	h.emit("session_start", fresh);
	h.invalidateContext();
	assert.doesNotThrow(() => h.tick(5000));
	assert.deepEqual(h.delivered.map((entry) => entry.prompt), ["old"]);
});
