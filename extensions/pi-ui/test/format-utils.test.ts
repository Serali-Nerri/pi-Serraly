// Adapted from pi-cc-extensions v0.8.69; see THIRD_PARTY_NOTICES.md.
import assert from "node:assert/strict";
import test from "node:test";
import { formatDuration, oneLine } from "../src/utils/format.ts";

test("formatDuration formats elapsed seconds", () => {
	assert.equal(formatDuration(999), "");
	assert.equal(formatDuration(1_000), "1s");
	assert.equal(formatDuration(62_000), "1m 2s");
	assert.equal(formatDuration(3_721_000), "1h 2m 1s");
});

test("oneLine: 默认 max=96，超长截断加省略号", () => {
	const long = "x".repeat(120);
	const out = oneLine(long);
	assert.equal(out.length, 96);
	assert.equal(out.endsWith("…"), true);
	assert.equal(out, `${"x".repeat(95)}…`);
});

test("oneLine: 显式 max 覆盖默认；空白折叠为单行", () => {
	assert.equal(oneLine("a\n\tb  c", 10), "a b c");
	assert.equal(oneLine("hello world", 8), "hello w…");
	assert.equal(oneLine(null), "");
	assert.equal(oneLine(undefined), "");
});
