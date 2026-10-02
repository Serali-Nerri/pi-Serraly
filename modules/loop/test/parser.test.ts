import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLoopInput } from "../src/index.ts";

// Literal expectations catch unit conversion, rounding and accidental prompt rewriting.
for (const [args, prompt, intervalMs, defaultInterval, roundedSeconds] of [
	["检查构建结果", "检查构建结果", 600_000, true, false],
	["  5m  检查构建结果  ", "检查构建结果", 300_000, false, false],
	["2H check", "check", 7_200_000, false, false],
	["1d check", "check", 86_400_000, false, false],
	["24h check", "check", 86_400_000, false, false],
	["1s check", "check", 60_000, false, true],
	["60s check", "check", 60_000, false, false],
	["61s check", "check", 120_000, false, true],
	["86400s check", "check", 86_400_000, false, false],
	["check every 2 hours", "check", 7_200_000, false, false],
	["check EVERY 1 minute", "check", 60_000, false, false],
	["check\nevery 2 mins", "check", 120_000, false, false],
	["check every 5sec", "check", 60_000, false, true],
	["check every 3 hrs", "check", 10_800_000, false, false],
	["check every 1 day", "check", 86_400_000, false, false],
	["check every 2m", "check", 120_000, false, false],
	["001m check", "check", 60_000, false, false],
	["5m /skill:review arg", "/skill:review arg", 300_000, false, false],
	["check every so often", "check every so often", 600_000, true, false],
	["1.5m check", "1.5m check", 600_000, true, false],
	["-1m check", "-1m check", 600_000, true, false],
	["5minutes check", "5minutes check", 600_000, true, false],
	["5mcheck", "5mcheck", 600_000, true, false],
] as const) {
	test(`parses ${JSON.stringify(args)} without changing the prompt`, () => {
		assert.deepEqual(parseLoopInput(args), { prompt, intervalMs, defaultInterval, roundedSeconds });
	});
}

for (const [args, error] of [
	["", /用法：\/loop/],
	[" \n ", /用法：\/loop/],
	["5m", /请提供要重复执行的提示词/],
	["0m check", /间隔必须为正整数/],
	["check every 0 seconds", /间隔必须为正整数/],
	["25h check", /1 分钟至 24 小时/],
	["2d check", /1 分钟至 24 小时/],
	["86401s check", /1 分钟至 24 小时/],
	["9007199254740992m check", /间隔必须为正整数/],
	["9007199254740991d check", /间隔过大/],
] as const) {
	test(`rejects ${JSON.stringify(args)} before scheduling`, () => {
		const result = parseLoopInput(args);
		assert.equal(typeof result, "string");
		assert.match(result as string, error);
	});
}

for (const [unit, intervalMs, roundedSeconds] of [
	["second", 60_000, true], ["seconds", 60_000, true],
	["sec", 60_000, true], ["secs", 60_000, true], ["s", 60_000, true],
	["minute", 60_000, false], ["minutes", 60_000, false],
	["min", 60_000, false], ["mins", 60_000, false], ["m", 60_000, false],
	["hour", 3_600_000, false], ["hours", 3_600_000, false],
	["hr", 3_600_000, false], ["hrs", 3_600_000, false], ["h", 3_600_000, false],
	["day", 86_400_000, false], ["days", 86_400_000, false], ["d", 86_400_000, false],
] as const) {
	test(`accepts the trailing ${unit} alias`, () => {
		assert.deepEqual(parseLoopInput(`check every 1 ${unit}`), {
			prompt: "check", intervalMs, defaultInterval: false, roundedSeconds,
		});
	});
}
