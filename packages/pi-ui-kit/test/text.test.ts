import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { padToWidth } from "../src/text.ts";

describe("padToWidth", () => {
	it("pads a short line to the exact visible width", () => {
		const padded = padToWidth("abc", 6);
		assert.equal(padded, "abc   ");
		assert.equal(visibleWidth(padded), 6);
	});

	it("counts wide characters by their columns", () => {
		const padded = padToWidth("界界", 6);
		assert.equal(visibleWidth(padded), 6);
		assert.equal(padded, "界界  ");
	});

	it("keeps an already wide line and an exact-width line unchanged", () => {
		assert.equal(padToWidth("abcdefgh", 6), "abcdefgh");
		assert.equal(padToWidth("abcdef", 6), "abcdef");
	});

	it("returns an empty string for a non-positive width", () => {
		assert.equal(padToWidth("abc", 0), "");
		assert.equal(padToWidth("abc", -3), "");
	});
});
