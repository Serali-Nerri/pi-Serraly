import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
	APPLY_PATCH_FORMAT,
	PER_VIEW_DIFF_MAX_BYTES,
	PER_VIEW_DIFF_MAX_LINES,
	TOTAL_DIFF_MAX_BYTES,
	TOTAL_DIFF_MAX_LINES,
} from "../../packages/pi-apply-patch-protocol/src/index.ts";
import { parseApplyPatchDetails } from "../../extensions/pi-ui/src/transcript/tool/apply-patch.ts";
import { buildPackages } from "../../scripts/lib/build-package.mjs";
import { discoverPackages } from "../../scripts/lib/packages.mjs";
import { packedFixture } from "./helpers/packed.mjs";

function detailsWith(diff, { views = 1 } = {}) {
	const facts = { exists: true, bytes: 1, lines: 1, bom: false, endings: { lf: 1, crlf: 0, cr: 0 }, finalNewline: true };
	return {
		format: APPLY_PATCH_FORMAT,
		changes: Array.from({ length: views }, (_, index) => ({
			kind: "update", path: `file-${index}.txt`,
			views: [{ role: "file", before: facts, after: facts, added: 1, removed: 1, diff, availability: "complete", diffTotalLines: diff === "" ? 0 : diff.split("\n").length, lineEndingsChanged: false }],
		})),
	};
}

const rows = (count, prefix = "+line") => Array.from({ length: count }, (_, index) => `${prefix} ${index}`).join("\n");

test("the consumer enforces the per-view line and byte budgets", () => {
	assert.ok(parseApplyPatchDetails(detailsWith(rows(PER_VIEW_DIFF_MAX_LINES))), "exactly the row budget is accepted");
	assert.equal(parseApplyPatchDetails(detailsWith(rows(PER_VIEW_DIFF_MAX_LINES + 1))), undefined, "one row over is rejected");
	const ascii = "+" + "a".repeat(PER_VIEW_DIFF_MAX_BYTES - 1);
	assert.ok(parseApplyPatchDetails(detailsWith(ascii)), "exactly the byte budget is accepted");
	assert.equal(parseApplyPatchDetails(detailsWith(`${ascii}a`)), undefined, "one byte over is rejected");
	// A three-byte character counts as three bytes, not one column.
	const multibyte = "+" + "界".repeat(Math.floor((PER_VIEW_DIFF_MAX_BYTES - 1) / 3));
	assert.ok(parseApplyPatchDetails(detailsWith(multibyte)), "a multi-byte diff under the byte budget is accepted");
	assert.equal(parseApplyPatchDetails(detailsWith(`${multibyte}界`)), undefined, "multi-byte characters count as bytes");
});

test("the consumer enforces the total budget across views", () => {
	const perView = Math.floor(TOTAL_DIFF_MAX_LINES / 4);
	const accepted = parseApplyPatchDetails(detailsWith(rows(perView), { views: 4 }));
	assert.ok(accepted, "four views inside the total row budget are accepted");
	assert.equal(accepted.changes.length, 4);
	assert.equal(parseApplyPatchDetails(detailsWith(rows(perView + 1), { views: 4 })), undefined, "one row over the total budget is rejected");
	// Four views at the per-view byte cap add up to exactly the total byte budget.
	const full = "+" + "a".repeat(PER_VIEW_DIFF_MAX_BYTES - 1);
	assert.equal(4 * PER_VIEW_DIFF_MAX_BYTES, TOTAL_DIFF_MAX_BYTES);
	assert.ok(parseApplyPatchDetails(detailsWith(full, { views: 4 })), "views summing to the total byte budget are accepted");
	assert.equal(parseApplyPatchDetails({ format: APPLY_PATCH_FORMAT,
		changes: [...detailsWith(full, { views: 4 }).changes, ...detailsWith("+", { views: 1 }).changes] }), undefined,
		"one byte over the total budget is rejected even when every view is small");
});

test("a consumer rebuilds its bundled library", { timeout: 300000 }, async () => {
	const packages = await discoverPackages();
	const library = packages.find((pkg) => pkg.name === "pi-apply-patch-protocol");
	const consumer = packages.find((pkg) => pkg.name === "pi-ui");
	assert.ok(library && consumer, "the protocol library and its consumer are discovered");
	await rm(join(library.directory, "dist"), { recursive: true, force: true });
	assert.equal(existsSync(join(library.directory, "dist/index.js")), false, "the fixture removes the built library");
	await buildPackages(packages, ["pi-ui"]);
	assert.equal(existsSync(join(library.directory, "dist/index.js")), true, "the consumer build rebuilt its library first");
});

test("a consumer built without its library dist still packs and installs standalone", { timeout: 300000 }, async (t) => {
	const packages = await discoverPackages();
	const library = packages.find((pkg) => pkg.name === "pi-apply-patch-protocol");
	await rm(join(library.directory, "dist"), { recursive: true, force: true });
	await buildPackages(packages, ["pi-ui"]);
	const packed = await packedFixture(t, "pi-ui");
	assert.equal(packed.installed.status, 0, `the packed consumer installs offline: ${packed.installed.stderr}`);
	assert.ok(packed.entry && existsSync(packed.entry), "the installed payload exposes its entry point");
});
