import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getConfigFilePath } from "../src/config.ts";
import { test } from "node:test";
import { host } from "./fixtures/host.ts";

test("opening and previewing before capture leaves the conversation untouched and labels estimates", { timeout: 15000 }, async () => {
	const h = await host();
	try {
		const before = h.sessionManager.getEntries();
		for (const command of ["/context", "/context usage", "/context injections"]) {
			await h.session.prompt(command);
			assert.deepEqual(h.errors, [], "public view command succeeds");
			assert.deepEqual(h.sessionManager.getEntries(), before, "viewing must not create messages or custom entries");
			assert.match(h.text(), /Not captured.*Session estimate/s);
			const view = h.overlays.at(-1)!;
			view.handleInput?.("\r");
			view.render(40);
			view.handleInput?.("\x1b[B");
			view.handleInput?.("\x1b");
		}
		assert.equal(h.requests, 0);
		assert.equal(h.executions, 0);
		assert.deepEqual(h.session.messages, []);
		assert.deepEqual(h.errors, []);
		assert.equal(h.settingsManager.getCacheWarmingMode(), "off");
	} finally { await h.close(); }
});


test("normal requests pass through, freeze Initial once, and reload cannot replay capture", { timeout: 15000 }, async () => {
	const h = await host();
	try {
		await h.session.prompt("Hello local fixture");
		assert.equal(h.requests, 1);
		assert.match(JSON.stringify(h.bodies[0]), /FIRST_CJK_指令/);
		assert.match(JSON.stringify(h.bodies[0]), /INITIAL_PRIVATE_CONTENT/);
		assert.equal(h.session.messages.at(-1)?.role, "assistant");
		assert.equal(h.executions, 0);
		assert.deepEqual(h.errors, []);
		const entries = h.sessionManager.getEntries();
		assert.equal(entries.filter((entry) => entry.type === "custom").length, 0);
		const files = await readdir(h.base, { recursive: true });
		await h.session.prompt("/context injections");
		assert.doesNotMatch(h.text(), /Not captured/);
		const view = h.overlays.at(-1)!;
		view.handleInput?.("\x1b[B");
		view.handleInput?.("\r");
		assert.match(h.text(), /FIRST_CJK_指令/);
		view.handleInput?.("\x1b");
		await h.session.prompt("/context usage");
		assert.match(h.text(), /Context Usage/);
		assert.deepEqual(h.sessionManager.getEntries(), entries, "view/preview adds no session entries");
		assert.deepEqual(await readdir(h.base, { recursive: true }), files, "view/preview adds no files");
		await h.session.prompt("Second local fixture");
		assert.equal(h.requests, 2);
		assert.match(JSON.stringify(h.bodies[1]), /SECOND_CJK_指令/);
		await h.session.prompt("/context injections");
		const frozen = h.overlays.at(-1)!;
		frozen.handleInput?.("\x1b[B");
		frozen.handleInput?.("\r");
		assert.match(h.text(), /FIRST_CJK_指令/);
		assert.doesNotMatch(h.text(), /SECOND_CJK_指令/);
		await h.session.reload();
		await h.session.prompt("/context injections");
		assert.match(h.text(), /Not captured.*Session estimate/s);
		assert.equal(h.requests, 2, "reload and inspection do not request a model");
		assert.equal(h.executions, 0);
		assert.deepEqual(h.errors, []);
	} finally { await h.close(); }
});

test("print mode refuses views but explicitly creates only owned display preferences", { timeout: 15000 }, async () => {
	const h = await host({ mode: "print" });
	try {
		for (const command of ["/context", "/context injections"]) await h.session.prompt(command);
		assert.equal(h.overlays.length, 0);
		assert.ok(h.notices.every((notice) => /TUI mode only/.test(notice)));
		const configPath = getConfigFilePath();
		await assert.rejects(readFile(configPath), { code: "ENOENT" });
		await h.session.prompt("/context config");
		const preferences = await readFile(configPath, "utf8");
		assert.equal(JSON.parse(preferences).mapCols, 16);
		assert.equal(Object.keys(JSON.parse(preferences)).length, 17);
		assert.doesNotMatch(preferences, /PRIVATE_CONTENT|CJK|messages|parameters/);
		await h.session.prompt("/context config");
		assert.equal(await readFile(configPath, "utf8"), preferences);
		assert.match(h.notices.at(-1)!, /already exists; left unchanged/);
		await assert.rejects(readFile(join(process.env.PI_CODING_AGENT_DIR!, "extensions/pi-context-view.json")), { code: "ENOENT" });
		assert.equal(h.requests, 0);
		assert.equal(h.executions, 0);
		assert.deepEqual(h.errors, []);
	} finally { await h.close(); }
});
