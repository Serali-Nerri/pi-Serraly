import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { config, configPath, DEFAULT_CONFIG, formatConfigStatus, getCompactThinkingConfig, normalizeConfig, setConfig, updateConfig } from "../src/config/config.ts";

const expected = {
	mode: "on",
	excludeRenderers: [],
	writePreviewLines: 10,
	editPreviewLines: 14,
	fileExpandedMaxLines: 80,
	useSummaryTitlesAsThinkingTitle: true,
	previewLines: 3,
	animationIntervalMs: 90,
	inputClip: 0,
	expandedCardBackground: "userMessageBg",
	expandedInputMaxLines: 5,
	expandedOutputMaxLines: 10,
};
const discarded = { dimThinkingText: true, expandedPreviewMaxLines: 999, scrollStepLines: 50 };
let directory: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	directory = mkdtempSync(join(tmpdir(), "pi-ui-config-test-"));
	process.env.PI_CODING_AGENT_DIR = directory;
	setConfig({});
});

afterEach(() => {
	setConfig({});
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(directory, { recursive: true, force: true });
});

function loadInChild(agentDirectory: string = directory) {
	const url = new URL("../src/config/config.ts", import.meta.url).href;
	const source = `const module = await import(${JSON.stringify(url)}); console.log(JSON.stringify({ config: module.config, path: module.configPath() }));`;
	return JSON.parse(execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", source], {
		cwd: directory,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDirectory },
		encoding: "utf8",
	}));
}

test("effective settings use adaptive summaries and the existing expanded background by default", () => {
	assert.deepEqual(DEFAULT_CONFIG, expected);
	assert.equal(Object.keys(DEFAULT_CONFIG).length, 12);
	assert.deepEqual(normalizeConfig(undefined), expected);
	assert.deepEqual(config, expected);
});

test("discarded and unrelated keys never enter runtime configuration or status", () => {
	const input = { ...discarded, enableContextCommand: false, unrelated: { enabled: true }, mode: "compact", inputClip: 160 };
	assert.deepEqual(normalizeConfig(input), { ...expected, mode: "compact", inputClip: 160 });
	setConfig(input as never);
	assert.deepEqual(config, { ...expected, mode: "compact", inputClip: 160 });
	const status = formatConfigStatus();
	assert.deepEqual(status.split(" · ").map((entry) => entry.split("=")[0]), Object.keys(expected));
	assert.ok(status.includes("excludeRenderers=none"));
	for (const key of [...Object.keys(discarded), "enableContextCommand", "unrelated"]) assert.ok(!status.includes(key));
});

test("retained numeric fields are finite, floored and clamped to their bounds", () => {
	assert.deepEqual(normalizeConfig({
		writePreviewLines: -1, editPreviewLines: 999, fileExpandedMaxLines: 100_000,
		previewLines: 999, animationIntervalMs: 1, inputClip: 1,
		expandedInputMaxLines: 9_000, expandedOutputMaxLines: 0,
	}), {
		...expected, writePreviewLines: 0, editPreviewLines: 500, fileExpandedMaxLines: 50_000,
		previewLines: 100, animationIntervalMs: 40, inputClip: 8,
		expandedInputMaxLines: 5_000, expandedOutputMaxLines: 1,
	});
	assert.equal(normalizeConfig({ inputClip: 160.9 }).inputClip, 160);
	for (const value of [NaN, Infinity, -Infinity, "160", null]) {
		assert.equal(normalizeConfig({ inputClip: value }).inputClip, 0);
	}
	assert.equal(normalizeConfig({ animationIntervalMs: 5_000 }).animationIntervalMs, 1_000);
});

test("mode and the thinking toggle require the documented types", () => {
	for (const mode of ["on", "compact", "off"]) assert.equal(normalizeConfig({ mode }).mode, mode);
	for (const mode of ["unknown", new String("off"), true, 0]) assert.equal(normalizeConfig({ mode }).mode, "on");
	assert.deepEqual(normalizeConfig({ useSummaryTitlesAsThinkingTitle: false }), {
		...expected, useSummaryTitlesAsThinkingTitle: false,
	});
	assert.deepEqual(normalizeConfig({ useSummaryTitlesAsThinkingTitle: "false" }), expected);
	for (const value of [null, [], "off", 10]) assert.deepEqual(normalizeConfig(value), expected);
});

test("renderer exclusions validate names, deduplicate and do not share arrays", () => {
	const input = ["read", "read", "my.tool:v2-test", "bad name", "../bad", "", 1];
	const normalized = normalizeConfig({ excludeRenderers: input });
	assert.deepEqual(normalized.excludeRenderers, ["read", "my.tool:v2-test"]);
	normalized.excludeRenderers.push("other");
	assert.deepEqual(normalizeConfig(undefined).excludeRenderers, []);
	assert.deepEqual(DEFAULT_CONFIG.excludeRenderers, []);
	assert.equal(input.length, 7);
});

test("in-memory changes never create the config file", () => {
	setConfig({ inputClip: 160, excludeRenderers: ["bash"] });
	assert.equal(config.inputClip, 160);
	assert.ok(formatConfigStatus().includes("excludeRenderers=bash"));
	assert.equal(existsSync(configPath()), false);
	assert.deepEqual(getCompactThinkingConfig(), {
		useSummaryTitlesAsThinkingTitle: true, previewLines: 3, animationIntervalMs: 90,
	});
	setConfig({});
	assert.deepEqual(config, expected);
});

test("startup uses defaults without creating an agent directory or config", () => {
	const missingDirectory = join(directory, "not-created");
	const loaded = loadInChild(missingDirectory);
	assert.deepEqual(loaded.config, expected);
	assert.equal(loaded.path, join(missingDirectory, "claude-style-tools.json"));
	assert.equal(existsSync(missingDirectory), false);
});

test("startup normalizes a legacy file in memory without migrating it on disk", () => {
	const contents = JSON.stringify({ ...discarded, mode: "off", inputClip: 160.8, unrelated: [1, 2] });
	writeFileSync(configPath(), contents);
	const before = statSync(configPath());
	assert.deepEqual(loadInChild().config, { ...expected, mode: "off", inputClip: 160 });
	assert.equal(readFileSync(configPath(), "utf8"), contents);
	assert.equal(statSync(configPath()).ino, before.ino);
	assert.equal(statSync(configPath()).mtimeMs, before.mtimeMs);
});

test("PI_CODING_AGENT_DIR config is the only source, not a working-directory file", () => {
	const agentDirectory = join(directory, "agent");
	mkdirSync(agentDirectory);
	writeFileSync(join(directory, "claude-style-tools.json"), '{"mode":"off"}');
	writeFileSync(join(agentDirectory, "claude-style-tools.json"), '{"mode":"compact"}');
	assert.equal(loadInChild(agentDirectory).config.mode, "compact");
	assert.equal(configPath(), join(directory, "claude-style-tools.json"));
	delete process.env.PI_CODING_AGENT_DIR;
	assert.equal(configPath(), join(homedir(), ".pi", "agent", "claude-style-tools.json"));
});

test("invalid startup JSON falls back to defaults without overwriting the file", () => {
	const contents = "{ invalid config";
	writeFileSync(configPath(), contents);
	assert.deepEqual(loadInChild().config, expected);
	assert.equal(readFileSync(configPath(), "utf8"), contents);
});

test("explicit save preserves unknown fields and cleans all discarded keys", () => {
	const contents = JSON.stringify({ ...discarded, unrelated: { nested: [1, "two", null] }, enableContextCommand: false, futureFlag: false });
	writeFileSync(configPath(), contents);
	updateConfig({ mode: "compact", fileExpandedMaxLines: 200 });
	const stored = JSON.parse(readFileSync(configPath(), "utf8"));
	assert.deepEqual(stored, {
		unrelated: { nested: [1, "two", null] }, enableContextCommand: false, futureFlag: false,
		...expected, mode: "compact", fileExpandedMaxLines: 200,
	});
	assert.deepEqual(config, { ...expected, mode: "compact", fileExpandedMaxLines: 200 });
	assert.equal(Object.keys(config).length, 12);
});

test("save re-reads unknown data written since startup and ignores unknown update keys", () => {
	writeFileSync(configPath(), '{"unrelated":{"new":true},"__proto__":{"safe":true}}');
	updateConfig({ inputClip: 160, ...discarded, injected: "not a config field" } as never);
	const stored = JSON.parse(readFileSync(configPath(), "utf8"));
	assert.deepEqual(stored.unrelated, { new: true });
	assert.deepEqual(stored.__proto__, { safe: true });
	assert.ok(!Object.hasOwn(stored, "injected"));
	for (const key of Object.keys(discarded)) assert.ok(!Object.hasOwn(stored, key));
	stored.unrelated = { newer: true };
	writeFileSync(configPath(), JSON.stringify(stored));
	updateConfig({ previewLines: 5 });
	assert.deepEqual(JSON.parse(readFileSync(configPath(), "utf8")).unrelated, { newer: true });
	assert.equal(config.inputClip, 160);
	assert.equal(config.previewLines, 5);
});

test("save atomically replaces a private file and leaves no temporary files", () => {
	const original = '{"unknown":"preserved"}';
	writeFileSync(configPath(), original);
	const before = statSync(configPath());
	const descriptor = openSync(configPath(), "r");
	try {
		updateConfig({ editPreviewLines: 24 });
		assert.equal(readFileSync(descriptor, "utf8"), original);
	} finally { closeSync(descriptor); }
	assert.notEqual(statSync(configPath()).ino, before.ino);
	assert.equal(statSync(configPath()).mode & 0o777, 0o600);
	assert.deepEqual(readdirSync(directory), ["claude-style-tools.json"]);
	assert.equal(JSON.parse(readFileSync(configPath(), "utf8")).editPreviewLines, 24);
});

test("an explicit save creates only the single source config when it is absent", () => {
	process.env.PI_CODING_AGENT_DIR = join(directory, "nested", "agent");
	updateConfig({ mode: "off" });
	assert.deepEqual(JSON.parse(readFileSync(configPath(), "utf8")), { ...expected, mode: "off" });
	assert.deepEqual(readdirSync(join(directory, "nested", "agent")), ["claude-style-tools.json"]);
});

test("save refuses malformed or non-object files without data loss or runtime changes", () => {
	for (const contents of ["{ broken", "[]", "null", '"not an object"']) {
		writeFileSync(configPath(), contents);
		assert.throws(() => updateConfig({ mode: "off" }));
		assert.equal(readFileSync(configPath(), "utf8"), contents);
		assert.deepEqual(config, expected);
		assert.deepEqual(readdirSync(directory), ["claude-style-tools.json"]);
	}
});

test("a valid configuration larger than the bound is refused instead of loaded", () => {
	// Valid JSON that a bounded reader must reject: the padding alone is over 64 KiB.
	const oversized = `${JSON.stringify({ mode: "off", padding: "x".repeat(64 * 1024) })}`;
	writeFileSync(configPath(), oversized);
	assert.deepEqual(loadInChild().config, expected);
	assert.throws(() => updateConfig({ mode: "off" }), /exceeds 65536 bytes/);
	assert.equal(readFileSync(configPath(), "utf8"), oversized);
	assert.deepEqual(config, expected);
	assert.deepEqual(readdirSync(directory), ["claude-style-tools.json"]);
});

test("a save that would write more than the bound keeps the previous file and memory", () => {
	// A stored file just under the bound is readable; merging the retained fields
	// pushes the serialized result over it, so the save must be refused before any
	// temporary file is created.
	const stored = (size: number) => `{\n  "unknown": "${"x".repeat(size)}"\n}`;
	let size = 64 * 1024;
	while (Buffer.byteLength(stored(size)) >= 64 * 1024) size -= 8;
	writeFileSync(configPath(), stored(size));
	assert.ok(statSync(configPath()).size < 64 * 1024);
	assert.throws(() => updateConfig({ editPreviewLines: 24 }), /exceed 65536 bytes/);
	assert.equal(readFileSync(configPath(), "utf8"), stored(size));
	assert.deepEqual(config, expected);
	assert.deepEqual(readdirSync(directory), ["claude-style-tools.json"]);
});
