import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_COLLAPSE_KEY, formatKeySpecForDisplay, loadConfig, resolveCollapseKey } from "../src/config.ts";

async function withConfigFile(contents: string, run: (path: string) => void): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "pi-ask-user-question-config-"));
	try {
		const path = join(directory, "ask-user-question.json");
		await writeFile(path, contents);
		run(path);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("a missing config file resolves every field to its default", () => {
	const config = loadConfig(join(tmpdir(), "pi-ask-user-question-absent", "ask-user-question.json"));
	assert.deepEqual(config, { collapseKey: DEFAULT_COLLAPSE_KEY });
});

test("collapseKey and the description override are read from the file", async () => {
	await withConfigFile(
		JSON.stringify({ collapseKey: "alt+o", guidance: { description: "House style." }, ignored: true }),
		(path) => {
			assert.deepEqual(loadConfig(path), { collapseKey: "alt+o", description: "House style." });
		},
	);
});

test("a wrong field type falls back instead of throwing", async () => {
	await withConfigFile(
		JSON.stringify({ collapseKey: 123, guidance: { description: 7 } }),
		(path) => {
			assert.deepEqual(loadConfig(path), { collapseKey: DEFAULT_COLLAPSE_KEY });
		},
	);
	await withConfigFile(JSON.stringify({ guidance: [] }), (path) => {
		assert.deepEqual(loadConfig(path), { collapseKey: DEFAULT_COLLAPSE_KEY });
	});
});

test("malformed JSON keeps the defaults and only warns", async () => {
	await withConfigFile("{ not json", (path) => {
		const warn = console.warn;
		console.warn = () => {};
		try {
			assert.deepEqual(loadConfig(path), { collapseKey: DEFAULT_COLLAPSE_KEY });
		} finally {
			console.warn = warn;
		}
	});
});

test("collapse key parsing accepts the documented grammar and rejects typos", () => {
	assert.equal(resolveCollapseKey("Alt+O"), "alt+o");
	assert.equal(resolveCollapseKey("  ctrl+shift+h  "), "ctrl+shift+h");
	assert.equal(resolveCollapseKey("f9"), "f9");
	assert.equal(resolveCollapseKey("off"), "off");
	assert.equal(resolveCollapseKey("ctr+]"), DEFAULT_COLLAPSE_KEY);
	assert.equal(resolveCollapseKey("ctrl++"), DEFAULT_COLLAPSE_KEY);
	assert.equal(resolveCollapseKey(""), DEFAULT_COLLAPSE_KEY);
	assert.equal(resolveCollapseKey(undefined), DEFAULT_COLLAPSE_KEY);
	assert.equal(resolveCollapseKey(123), DEFAULT_COLLAPSE_KEY);
	assert.equal(resolveCollapseKey({ key: "alt+o" }), DEFAULT_COLLAPSE_KEY);
});

test("formatKeySpecForDisplay renders the shortcut for UI copy", () => {
	assert.equal(formatKeySpecForDisplay("ctrl+]"), "Ctrl+]");
	assert.equal(formatKeySpecForDisplay("alt+o"), "Alt+O");
	assert.equal(formatKeySpecForDisplay("f9"), "F9");
	assert.equal(formatKeySpecForDisplay("ctrl+pagedown"), "Ctrl+PageDown");
});
