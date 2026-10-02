import assert from "node:assert/strict";
import test from "node:test";
import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { generateBoundedDiff } from "../src/diff.ts";

const generous = { maxEditLength: 1_000, timeout: 10_000 };

test("bounded diff matches Pi display rows, context gaps and original/new line numbers", () => {
	const old = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`);
	const changed = [...old];
	changed.splice(5, 1, "first replacement", "inserted");
	changed.splice(90, 2, "last replacement");
	const cases: Array<[string, string]> = [
		["", ""], ["a\n", "a\n"], ["", "\n"], ["a\n", ""], ["a\n", "b\n"],
		["same\n".repeat(30), "same\n".repeat(14) + "new\n" + "same\n".repeat(15)],
		[old.join("\n") + "\n", changed.join("\n") + "\n"],
		["a", "a\n"], ["\n", "\n\n"], ["a\r\nb\r\n", "a\r\nB\r\n"],
		["+source\n-source\ncontext\n", "++source\n--source\ncontext\n"],
	];
	for (const length of [9, 10, 99, 100, 999]) {
		const before = "keep\n".repeat(length - 1) + "old\n";
		cases.push([before, "keep\n".repeat(length - 1) + "new\n"]);
	}
	for (const [before, after] of cases) {
		const result = generateBoundedDiff(before, after, generous);
		assert.ok(result);
		assert.equal(result.diff, generateDiffString(before, after).diff);
		assert.equal(result.added, result.diff.split("\n").filter((line) => line.startsWith("+")).length);
		assert.equal(result.removed, result.diff.split("\n").filter((line) => line.startsWith("-")).length);
	}
});

test("bounded edit distance counts changes, not the gap between distant changes", () => {
	const before = Array.from({ length: 600 }, (_, index) => `line ${index + 1}`);
	const after = [...before];
	after[5] = "first";
	after[590] = "last";
	const result = generateBoundedDiff(before.join("\n") + "\n", after.join("\n") + "\n",
		{ ...generous, maxEditLength: 4 });
	assert.equal(result?.added, 2);
	assert.equal(result?.removed, 2);
	assert.equal(generateBoundedDiff(before.join("\n") + "\n", after.join("\n") + "\n",
		{ ...generous, maxEditLength: 3 }), undefined);
});

test("display projection agrees with Pi over seeded insert/delete/repeated-line cases", () => {
	let seed = 417;
	const random = (size: number) => {
		seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
		return seed % size;
	};
	for (let scenario = 0; scenario < 250; scenario++) {
		const before = Array.from({ length: random(80) }, () => ["", "repeat", "alpha", "中文", "+prefix", "-prefix"][random(6)]);
		const after = [...before];
		for (let edit = 0; edit < 8; edit++) {
			const at = random(after.length + 1);
			after.splice(at, random(3), ...Array.from({ length: random(3) }, () => `new ${random(8)}`));
		}
		const oldText = before.length ? before.join("\n") + "\n" : "";
		const newText = after.length ? after.join("\n") + "\n" : "";
		assert.equal(generateBoundedDiff(oldText, newText, generous)?.diff,
			generateDiffString(oldText, newText).diff, `scenario ${scenario}`);
	}
});

test("a genuinely large rewrite stops at the actual edit-distance budget", () => {
	const before = Array.from({ length: 600 }, (_, index) => `old ${index}\n`).join("");
	const after = Array.from({ length: 600 }, (_, index) => `new ${index}\n`).join("");
	assert.equal(generateBoundedDiff(before, after, { ...generous, maxEditLength: 1_000 }), undefined);
});

test("the algorithm itself observes its timeout without a wall-clock sleep", (t) => {
	let tick = 0;
	t.mock.method(Date, "now", () => tick++ * 1_000);
	assert.equal(generateBoundedDiff("old\n", "new\n", { maxEditLength: 100, timeout: 1 }), undefined);
});

test("zero or invalid budgets cannot silently enable unbounded work", () => {
	for (const budget of [
		{ maxEditLength: 0, timeout: 100 }, { maxEditLength: 100, timeout: 0 },
		{ maxEditLength: Infinity, timeout: 100 }, { maxEditLength: 100, timeout: Infinity },
		{ maxEditLength: NaN, timeout: 100 }, { maxEditLength: -1, timeout: 100 },
	]) {
		assert.equal(generateBoundedDiff("old\n", "new\n", budget), undefined);
	}
});
