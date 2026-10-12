import assert from "node:assert/strict";
import test from "node:test";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { harness } from "./harness.ts";

const output = Array.from({ length: 60 }, (_, i) => `RETAINED_OUTPUT_${i}`).join("\n");

test("fullscreen mouse expansion holds the painted position and collapse keeps the new viewport", async () => {
	const h = await harness({ rows: 12 });
	try {
		h.root.addChild(new Text(Array.from({ length: 60 }, (_, i) => `PREFIX_${i}`).join("\n"), 0, 0));
		h.tool("bash", "viewport-tool", { command: "inspect retained output" }, {
			content: [{ type: "text", text: output }], isError: false,
		});
		const before = h.render();
		const initialTop = h.tui.viewportTop;
		assert.equal(h.tui.isFollowingOutput, true);
		const hintRow = before.findIndex((line) => line.includes("click to show more"));
		assert.ok(hintRow >= 0, before.join("\n"));
		h.click(visibleWidth(before[hintRow]!.split("click to show more")[0]!), hintRow);
		const expanded = h.render();
		assert.equal(h.tui.isFollowingOutput, false, "mouse expansion leaves bottom-following");
		assert.equal(h.tui.viewportTop, initialTop);
		assert.equal(expanded[0], before[0], "the painted prefix stays in place");

		h.root.addChild(new Text(Array.from({ length: 100 }, (_, i) => `TAIL_${i}`).join("\n"), 0, 0));
		h.render();
		h.tui.scrollBy(10);
		const scrolled = h.render();
		const collapseTop = h.tui.viewportTop;
		assert.ok(collapseTop > initialTop);
		const bodyRow = scrolled.findIndex((line) => line.includes("RETAINED_OUTPUT_"));
		assert.ok(bodyRow >= 0, scrolled.join("\n"));
		h.click(visibleWidth(scrolled[bodyRow]!.split("RETAINED_OUTPUT_")[0]!), bodyRow);
		h.render();
		assert.equal(h.tui.viewportTop, collapseTop, "collapse does not restore the pre-expansion position");
		assert.equal(h.tui.isFollowingOutput, false);
	} finally { await h.close(); }
});
