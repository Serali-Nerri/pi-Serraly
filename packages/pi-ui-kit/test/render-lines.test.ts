import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RenderLines } from "../src/render-lines.ts";

describe("RenderLines", () => {
	it("builds once per width and reuses the cached lines", () => {
		const widths: number[] = [];
		const component = new RenderLines((width) => { widths.push(width); return [`w${width}`]; });
		assert.deepEqual(component.render(20), ["w20"]);
		assert.deepEqual(component.render(20), ["w20"]);
		assert.deepEqual(widths, [20]);
		assert.deepEqual(component.render(30), ["w30"]);
		assert.deepEqual(widths, [20, 30]);
	});

	it("rebuilds after invalidate", () => {
		let value = "first";
		const component = new RenderLines(() => [value]);
		assert.deepEqual(component.render(20), ["first"]);
		value = "second";
		assert.deepEqual(component.render(20), ["first"], "a cached width hides the change until invalidated");
		component.invalidate();
		assert.deepEqual(component.render(20), ["second"]);
	});

	it("never asks the builder for a non-positive width", () => {
		const widths: number[] = [];
		const component = new RenderLines((width) => { widths.push(width); return []; });
		component.render(0);
		component.render(-4);
		assert.deepEqual(widths, [1], "a non-positive width is clamped and cached like any other");
	});
});
