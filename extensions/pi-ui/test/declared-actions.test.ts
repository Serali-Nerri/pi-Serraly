import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { harness } from "./harness.ts";
import { setConfig } from "../src/config/config.ts";

const action = "click to show more";
function lastActionRow(lines: string[]): number {
	for (let row = lines.length - 1; row >= 0; row--) if (lines[row]!.includes(action)) return row;
	return -1;
}
function closePreview(h: Awaited<ReturnType<typeof harness>>) { h.overlay?.handleInput?.("\x1b"); }

const result = { content: [{ type: "text", text: "done" }], isError: false };
function clickText(h: Awaited<ReturnType<typeof harness>>, lines: string[], row: number, text = action) {
	assert.ok(row >= 0, lines.join("\n"));
	h.click(visibleWidth(lines[row]!.slice(0, lines[row]!.indexOf(text))), row);
}

test("ordinary diff/write text cannot impersonate a declared expansion or preview row", async () => {
	const h = await harness();
	setConfig({ fileExpandedMaxLines: 20 });
	try {
		for (const name of ["write", "edit"] as const) {
			h.root.clear();
			const source = [action, ...Array.from({ length: 110 }, (_, index) => `RETAINED_${index}`)].join("\n");
			const tool = h.tool(name, `${name}-actions`, { path: "fixture.ts", content: source, oldText: "old", newText: "new" },
				name === "edit" ? { ...result, details: { diff: source.split("\n").map((text, index) => `+${index + 1} ${text}`).join("\n") } } : result);
			let lines = h.render();
			const decoy = lines.findIndex((line) => line.includes(`1 ${name === "edit" ? "+ " : ""}${action}`));
			clickText(h, lines, decoy);
			assert.equal(tool.expanded, false, `${name} source text is not an expand action`);
			assert.ok(!h.overlay);
			lines = h.render();
			const genuine = lastActionRow(lines);
			clickText(h, lines, genuine);
			assert.equal(tool.expanded, true, "the owned remainder row still expands");
			lines = h.render();
			const body = lines.findIndex((line) => line.includes(`1 ${name === "edit" ? "+ " : ""}${action}`));
			clickText(h, lines, body);
			assert.equal(tool.expanded, false, "ordinary expanded body clicks still collapse");
			assert.ok(!h.overlay, "literal body text cannot become a preview action");
			lines = h.render();
			clickText(h, lines, lastActionRow(lines));
			lines = h.render();
			clickText(h, lines, lastActionRow(lines));
			assert.ok(h.overlay, "the owned expanded remainder row opens retained content");
			closePreview(h);
		}
	} finally { h.overlay?.handleInput?.("\x1b"); await h.close(); }
});

test("Thinking body text is not an action and expanded Input/Output literals cannot open previews", async () => {
	const h = await harness();
	try {
		const assistant = new AssistantMessageComponent({
			role: "assistant", timestamp: 801, content: [{ type: "thinking", thinking: `Hidden start\n${action}\nordinary tail` }],
			api: "openai-responses", provider: "fixture", model: "fixture", stopReason: "stop",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		}, true);
		h.root.addChild(assistant);
		let lines = h.render();
		clickText(h, lines, lines.findIndex((line) => line.includes(action)));
		// A short Thinking body has no omission action: clicking its literal must
		// not create an expanded background or alter its layout.
		assert.deepEqual(h.render(), lines);

		h.root.clear();
		const output = [`… +9 more lines • ${action}`, ...Array.from({ length: 20 }, (_, index) => `OUTPUT_${index}`)].join("\n");
		const tool = h.tool("bash", "io-actions", { command: output }, { content: [{ type: "text", text: output }], isError: false });
		tool.setExpanded(true);
		lines = h.render();
		const decoy = lines.findIndex((line) => line.includes(`+9 more lines • ${action}`));
		clickText(h, lines, decoy);
		assert.ok(!h.overlay);
		assert.equal(tool.expanded, false, "ordinary expanded input collapses, not previews");
		tool.setExpanded(true);
		lines = h.render();
		clickText(h, lines, lastActionRow(lines));
		assert.ok(h.overlay, "real output omission still opens retained content");
		closePreview(h);
	} finally { h.overlay?.handleInput?.("\x1b"); await h.close(); }
});
