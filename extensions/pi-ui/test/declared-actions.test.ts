import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { harness, strip } from "./harness.ts";
import { setToolMouseTui } from "../src/overlays/mouse-state.ts";
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

test("Thinking title is an action while body dragging remains native text selection", async () => {
	const h = await harness();
	try {
		h.root.addChild(new AssistantMessageComponent({
			role: "assistant", timestamp: 802,
			content: [{ type: "thinking", thinking: Array.from({ length: 9 }, (_, i) => `THINKING_BODY_${i}`).join("\n") }],
			api: "openai-responses", provider: "fixture", model: "fixture", stopReason: "stop",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		}, true));
		const lines = h.render();
		assert.ok(!lines.some((line) => line.includes("THINKING_BODY_0")));
		clickText(h, lines, lines.findIndex((line) => line.includes("Thought")), "Thought");
		const expanded = h.render();
		const bodyRow = expanded.findIndex((line) => line.includes("THINKING_BODY_0"));
		assert.ok(bodyRow >= 0, expanded.join("\n"));
		h.pointer(2, bodyRow);
		h.pointer(10, bodyRow, "drag");
		h.pointer(10, bodyRow, "release");
		assert.equal(h.tui.hasActiveSelection(), true, "body drag belongs to Pi selection");
		assert.ok(h.render().some((line) => line.includes("THINKING_BODY_0")), "selection does not collapse Thinking");
	} finally { await h.close(); }
});

test("Thinking body hyperlinks activate the host URL hook without collapsing the preview", async () => {
	const h = await harness();
	let input: (data: string) => void = () => assert.fail("terminal input is not connected");
	const opened: string[] = [];
	// The real host accepts its URL hook and terminal input through its public
	// constructor/start contract; do not assign a private URL callback on h.tui.
	const tui = new TuiAltScreen({ ...h.terminal,
		start(onInput: (data: string) => void) { input = onInput; },
	} as any, false, undefined, { openUrl: (url) => opened.push(url), copyOnSelect: false });
	const screen = () => tui.getScreenLines().map(strip);
	const click = async (text: string) => {
		const lines = screen();
		const row = lines.findIndex((line) => line.includes(text));
		assert.ok(row >= 0, lines.join("\n"));
		const x = visibleWidth(lines[row]!.slice(0, lines[row]!.indexOf(text)));
		input(`\x1b[<0;${x + 1};${row + 1}M`);
		input(`\x1b[<0;${x + 1};${row + 1}m`);
		tui.requestRender(true);
		await h.flush();
	};
	try {
		const url = "https://thinking.example.invalid/retained";
		h.root.addChild(new AssistantMessageComponent({
			role: "assistant", timestamp: 804,
			content: [{ type: "thinking", thinking: `\x1b]8;;${url}\x07THINKING_LINK\x1b]8;;\x07\n${Array.from({ length: 9 }, (_, i) => `LINK_BODY_${i}`).join("\n")}` }],
			api: "openai-responses", provider: "fixture", model: "fixture", stopReason: "stop",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		}, true));
		h.tui.removeChild(h.root);
		tui.addChild(h.root);
		setToolMouseTui(tui);
		tui.start();
		tui.requestRender(true);
		await h.flush();
		await click("Thought");
		await click("THINKING_LINK");
		assert.deepEqual(opened, [url], "body links belong to the host URL action");
		assert.ok(screen().some((line) => line.includes("LINK_BODY_0")), "link activation leaves Thinking expanded");
	} finally { tui.stop({ preserveScreen: true }); await h.close(); }
});

test("Thinking title expansion keeps its compact Work Group and process members visible", async () => {
	const h = await harness({ mode: "compact", rows: 48 });
	try {
		h.root.addChild(new AssistantMessageComponent({
			role: "assistant", timestamp: 803,
			content: [
				{ type: "thinking", thinking: Array.from({ length: 9 }, (_, i) => `NESTED_THINKING_${i}`).join("\n") },
				{ type: "toolCall", id: "thinking-sibling", name: "read", arguments: { path: "PRESERVED_FILE.ts" } },
			],
			api: "openai-responses", provider: "fixture", model: "fixture", stopReason: "toolUse",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		}, true));
		h.tool("read", "thinking-sibling", { path: "PRESERVED_FILE.ts" }, {
			content: [{ type: "text", text: "SIBLING_RESULT" }], isError: false,
		});
		let lines = h.render();
		clickText(h, lines, lines.findIndex((line) => line.includes("Read 1 file")));
		lines = h.render();
		assert.ok(!lines.some((line) => line.includes("NESTED_THINKING_0")));
		clickText(h, lines, lines.findIndex((line) => line.includes("Thought")), "Thought");
		lines = h.render();
		assert.ok(lines.some((line) => line.includes("NESTED_THINKING_0")), lines.join("\n"));
		assert.ok(lines.some((line) => line.includes("PRESERVED_FILE.ts")), "Thinking's process sibling remains visible");
		assert.ok(!lines.some((line) => line.includes("Read 1 file") && line.includes(action)), "the outer Work Group does not return to its collapsed summary");
	} finally { await h.close(); }
});

test("expanding a nested tool again preserves its enclosing tool group", async () => {
	const h = await harness({ rows: 48 });
	try {
		h.tool("bash", "nested-first", { command: "FIRST_COMMAND" }, {
			content: [{ type: "text", text: "FIRST_TOOL_BODY" }], isError: false,
		});
		h.tool("bash", "nested-second", { command: "SECOND_COMMAND" }, {
			content: [{ type: "text", text: "SECOND_TOOL_BODY" }], isError: false,
		});
		let lines = h.render();
		clickText(h, lines, lines.findIndex((line) => line.includes("Bash: 2 done")));
		lines = h.render();
		clickText(h, lines, lines.findIndex((line) => line.includes("FIRST_TOOL_BODY")), "FIRST_TOOL_BODY");
		lines = h.render();
		assert.ok(lines.some((line) => line.includes("SECOND_TOOL_BODY")), "collapsing a child leaves its sibling visible");
		clickText(h, lines, lines.findIndex((line) => line.includes("1 line returned")));
		lines = h.render();
		assert.ok(lines.some((line) => line.includes("FIRST_TOOL_BODY")), lines.join("\n"));
		assert.ok(lines.some((line) => line.includes("SECOND_COMMAND")), "re-expanding a child retains its sibling in the enclosing group");
		assert.ok(lines.some((line) => line.includes("Bash: 2 done") && line.includes("click to collapse")));
	} finally { await h.close(); }
});

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
