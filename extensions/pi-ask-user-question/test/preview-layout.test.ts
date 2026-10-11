import assert from "node:assert/strict";
import test from "node:test";
import {
	adaptiveLeftWidth,
	decideLayout,
	MIN_LEFT,
	MIN_PREVIEW_WIDTH,
	PREVIEW_COLUMN_GAP,
	PREVIEW_MIN_WIDTH,
} from "../src/view/components/preview/preview-layout-decider.ts";
import type { WrappingSelectItem } from "../src/view/components/wrapping-select.ts";

const item = (label: string): WrappingSelectItem => ({ kind: "option", label, description: "" });

test("side-by-side previews engage only when terminal and pane are both wide enough", () => {
	assert.equal(decideLayout(PREVIEW_MIN_WIDTH, PREVIEW_MIN_WIDTH), "side-by-side");
	assert.equal(decideLayout(PREVIEW_MIN_WIDTH - 1, 120), "stacked");
	assert.equal(decideLayout(120, PREVIEW_MIN_WIDTH - 1), "stacked");
});

test("the options column keeps its floor, its ratio cap and room for the preview", () => {
	const long = adaptiveLeftWidth([item("x".repeat(120))], 2, 200);
	assert.equal(long, Math.floor(200 * 0.5), "the left column never exceeds half the pane");
	assert.ok(long <= 200 - PREVIEW_COLUMN_GAP - MIN_PREVIEW_WIDTH);

	const narrow = adaptiveLeftWidth([item("Label")], 2, 80);
	assert.ok(narrow >= MIN_LEFT && narrow <= Math.max(1, 80 - PREVIEW_COLUMN_GAP - MIN_PREVIEW_WIDTH));

	const empty = adaptiveLeftWidth([], 1, 120);
	assert.ok(empty >= MIN_LEFT);
});
