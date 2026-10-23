import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createUiConfig } from "../src/config.js";

function fixture(t: test.TestContext) {
	const home = mkdtempSync(join(tmpdir(), "pi-ui-config-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	return join(home, "agent", "pi-ui.json");
}

test("settings load without creating files and save bounded values privately", (t) => {
	const path = fixture(t);
	const store = createUiConfig(path);
	assert.equal(store.get().previewLines, 3);
	assert.equal(readdirSync(join(path, "../.." )).length, 0);
	store.update({ previewLines: 200, animationIntervalMs: 1, stickyUserMessage: false });
	assert.equal(store.get().previewLines, 20);
	assert.equal(store.get().animationIntervalMs, 40);
	assert.equal(store.get().stickyUserMessage, false);
	assert.equal(createUiConfig(path).get().stickyUserMessage, false);
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.equal(statSync(join(path, "..")).mode & 0o777, 0o700);
	assert.deepEqual(readdirSync(join(path, "..")), ["pi-ui.json"]);
});

test("invalid or oversized settings fall back read-only and cannot be overwritten", (t) => {
	const path = fixture(t);
	mkdirSync(join(path, ".."));
	for (const contents of [Buffer.from("{"), Buffer.from("[]"), Buffer.from([0xff]), Buffer.alloc(65_537, 32)]) {
		writeFileSync(path, contents);
		const store = createUiConfig(path);
		assert.equal(store.get().previewLines, 3);
		assert.throws(() => store.update({ previewLines: 5 }));
		assert.equal(store.get().previewLines, 3);
		assert.deepEqual(readFileSync(path), contents);
	}
	rmSync(path);
	mkdirSync(path);
	assert.equal(createUiConfig(path).get().previewLines, 3);
	assert.throws(() => createUiConfig(path).update({ previewLines: 5 }));
});

test("saving merges current settings without retaining caller mutations", (t) => {
	const path = fixture(t);
	mkdirSync(join(path, ".."));
	writeFileSync(path, JSON.stringify({ previewLines: 7, extra: "preserved" }));
	const store = createUiConfig(path);
	store.get().previewLines = 19;
	assert.equal(store.get().previewLines, 7);
	writeFileSync(path, JSON.stringify({ previewLines: 7, extra: "changed" }));
	store.update({ useSummaryTitlesAsThinkingTitle: false });
	assert.equal(JSON.parse(readFileSync(path, "utf8")).extra, "changed");
	assert.equal(createUiConfig(path).get().useSummaryTitlesAsThinkingTitle, false);
});
