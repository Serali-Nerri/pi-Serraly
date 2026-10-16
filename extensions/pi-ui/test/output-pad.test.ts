// Pi 1.3.0 exposes `outputPad` in the tool render context and requires
// `renderShell: "self"` renderers to apply that indent themselves.
import assert from "node:assert/strict";
import test from "node:test";
import { setConfig } from "../src/config/config.ts";
import { createCcstyleTool } from "../src/transcript/tool-renderers.ts";
import { toolViewportWidth } from "../src/transcript/tool/result.ts";
import { strip } from "./harness.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

const theme = { fg: (_color: string, text: string) => text } as any;
const result = { content: [{ type: "text", text: "done" }], isError: false } as any;

function card(name: string, args: any, outputPad: number) {
	setConfig({ mode: "on" });
	const renderer = createCcstyleTool({ name, label: name, parameters: {} } as any, "generic");
	const context = {
		args, cwd: "/tmp", expanded: false, isPartial: false, executionStarted: false,
		isError: false, toolCallId: "pad", outputPad, durationMs: undefined,
	};
	return {
		call: renderer.renderCall(args, theme, context).render(100).map(strip),
		rendered: renderer.renderResult(result, { expanded: false, isPartial: false }, theme, context),
	};
}

const leading = (line: string): number => line.length - line.trimStart().length;

test("self-rendered tool cards apply the configured outputPad", () => {
	const padded = card("read", { path: "source.ts" }, 1);
	const flush = card("read", { path: "source.ts" }, 0);

	assert.equal(leading(padded.call[0]!), 1, "the default padding indents the call line once");
	assert.equal(leading(flush.call[0]!), 0, "outputPad 0 removes the renderer's own indent");
	assert.equal(leading(padded.rendered.render(100).map(strip)[0]!), 3, "the result line aligns under the call icon");
	assert.equal(leading(flush.rendered.render(100).map(strip)[0]!), 2, "the result line follows the call line");
});

test("padding changes neither the expand row nor the card's outer width", () => {
	const padded = card("read", { path: "source.ts" }, 1);
	const flush = card("read", { path: "source.ts" }, 0);

	for (const { rendered } of [padded, flush]) {
		assert.equal(rendered.actionAtRow(0), "expand", "the show-more row stays the first result row");
	}
	// The indent stays inside the viewport budget, so a wider pad never grows the card.
	const viewport = toolViewportWidth(100);
	for (const { call, rendered } of [padded, flush]) {
		for (const line of [...call, ...rendered.render(100).map(strip)]) {
			assert.ok(visibleWidth(line) <= viewport, `card line ${JSON.stringify(line)} stays inside the viewport`);
		}
	}
});
