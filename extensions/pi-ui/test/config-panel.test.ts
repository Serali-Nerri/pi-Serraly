import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { UserMessageComponent, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Text, visibleWidth, type Component, type Focusable, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { config, configPath, setConfig } from "../src/config/config.ts";
import { showStylePanel } from "../src/config/panel.ts";
import { harness } from "./harness.ts";

let directory: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	directory = mkdtempSync(join(tmpdir(), "pi-ui-config-panel-"));
	process.env.PI_CODING_AGENT_DIR = directory;
	setConfig({});
});

afterEach(() => {
	setConfig({});
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(directory, { recursive: true, force: true });
});

function mountPanel() {
	let component!: Component & Focusable;
	let renders = 0;
	let changes = 0;
	let closed = false;
	const ctx = {
		ui: {
			custom(factory: (...args: any[]) => Component & Focusable) {
				return new Promise<void>((resolve) => {
					component = factory({ requestRender() { renders++; } }, {
						fg(_token: string, text: string) { return text; }, bold(text: string) { return text; },
					}, {}, () => { closed = true; resolve(); });
				});
			},
		},
	} as unknown as ExtensionCommandContext;
	const completion = showStylePanel(ctx, () => { changes++; });
	return {
		component, completion,
		get renders() { return renders; }, get changes() { return changes; }, get closed() { return closed; },
		input(data: string) { component.handleInput!(data); },
		text(width = 120) { return component.render(width).join("\n"); },
		mouse(x: number, y: number) {
			return component.handleMouse!({ type: "click", button: "left", x, y } as TuiMouseEvent);
		},
	};
}

test("four-page panel exposes current settings and omits discarded controls", async () => {
	const panel = mountPanel();
	const pages = [
		["Mode", "Original renderers"],
		["Write preview lines", "Edit preview lines", "Expanded file lines"],
		["Summary titles", "Preview lines", "Animation interval (ms)"],
		["Summary characters (0 = auto)", "Input preview lines", "Output preview lines", "Expanded card background", "Sticky user message"],
	];
	for (const labels of pages) {
		const text = panel.text();
		assert.equal(panel.component.render(120)[2], "Style / Files / Thinking / UI");
		for (const label of labels) assert.ok(text.includes(label), label);
		for (const label of ["Dim thinking", "Extended preview lines", "Scroll lines", "Context inspector"]) assert.ok(!text.includes(label));
		panel.input("\t");
	}
	assert.ok(panel.text().includes("Original renderers"));
	panel.input("\x1b[Z");
	assert.ok(panel.text().includes("Expanded card background"));
	assert.equal(panel.changes, 0);
	assert.deepEqual(readdirSync(directory), []);
	panel.input("\x1b");
	await panel.completion;
	assert.equal(panel.closed, true);
});

test("the host exposes enabled sticky prompts and the panel can save an explicit off switch", async () => {
	writeFileSync(configPath(), JSON.stringify({ unrelated: { keep: true }, previewLines: 5 }));
	const h = await harness({ rows: 8 });
	try {
		h.root.addChild(new UserMessageComponent("Configurable instruction"));
		h.root.addChild(new Text(Array.from({ length: 12 }, (_, i) => `Result ${i}`).join("\n"), 0, 0));
		h.render();
		h.tui.scrollToTop();
		h.tui.scrollBy(5);
		assert.equal(h.render()[0]!.trim(), "Configurable instruction");
		await h.commands.get("ccstyle").handler("status", h.ctx);
		assert.match(h.notices.at(-1)!.message, /stickyUserMessage=true/);
		const completion = h.commands.get("ccstyle").handler("panel", h.ctx);
		const panel = h.overlay!;
		for (let page = 0; page < 3; page++) panel.handleInput!("\t");
		const lines = panel.render(100);
		const row = lines.findIndex((line) => line.includes("Sticky user message"));
		assert.ok(row >= 0, "the UI page offers sticky prompts");
		panel.handleMouse!({ type: "click", button: "left", x: 4, y: row } as TuiMouseEvent);
		assert.match(panel.render(100).join("\n"), /Sticky user message[\s\S]*false/);
		panel.handleInput!("\x1b");
		await completion;
		await h.commands.get("ccstyle").handler("status", h.ctx);
		assert.match(h.notices.at(-1)!.message, /stickyUserMessage=false/);
		assert.deepEqual(JSON.parse(readFileSync(configPath(), "utf8")).unrelated, { keep: true });
		h.click(2, 0);
		assert.equal(h.tui.viewportTop, 5, "the off switch invalidates the previous sticky frame before repaint");
		assert.doesNotMatch(h.render()[0]!, /Configurable instruction/);
	} finally { await h.close(); }
});

test("mouse tabs select retained pages and ignore the area after the last tab", async () => {
	const panel = mountPanel();
	panel.text();
	assert.deepEqual(panel.mouse(18, 2), { handled: true, render: true });
	assert.ok(panel.text().includes("Summary titles"));
	assert.deepEqual(panel.mouse(28, 2), { handled: true, render: true });
	assert.equal(panel.mouse(33, 2), undefined);
	assert.ok(panel.text().includes("Expanded card background"));
	assert.equal(panel.mouse(7, 2), undefined);
	assert.deepEqual(readdirSync(directory), []);
	panel.input("\x1b");
	await panel.completion;
});

test("mode cycling saves once, preserving unknown data and cleaning discarded fields", async () => {
	writeFileSync(configPath(), JSON.stringify({ unrelated: { keep: true }, dimThinkingText: true, scrollStepLines: 7, expandedPreviewMaxLines: 500 }));
	const panel = mountPanel();
	panel.input("\r");
	assert.equal(config.mode, "compact");
	assert.equal(panel.changes, 1);
	const stored = JSON.parse(readFileSync(configPath(), "utf8"));
	assert.deepEqual(stored.unrelated, { keep: true });
	for (const key of ["dimThinkingText", "scrollStepLines", "expandedPreviewMaxLines"]) assert.ok(!Object.hasOwn(stored, key));
	assert.ok(panel.renders > 0);
	assert.match(panel.text(), /Mode\s+compact/);
	panel.input("\x1b");
	await panel.completion;
});

test("numeric submenu accepts custom values, normalizes and saves exactly once", async () => {
	const panel = mountPanel();
	panel.input("\t");
	panel.input("\r");
	panel.input("\x05");
	panel.input("\x15");
	panel.input("24.9");
	panel.input("\r");
	assert.equal(config.writePreviewLines, 24);
	assert.equal(panel.changes, 1);
	assert.match(panel.text(), /Write preview lines\s+24/);
	panel.input("\x1b");
	await panel.completion;
});

test("numeric validation errors keep the submenu open without saving", async () => {
	const panel = mountPanel();
	panel.input("\t");
	panel.input("\r");
	panel.input("\x05");
	panel.input("\x15");
	panel.input("oops");
	panel.input("\r");
	assert.equal(config.writePreviewLines, 10);
	assert.equal(panel.changes, 0);
	assert.ok(panel.text().includes("Enter a number"));
	assert.deepEqual(readdirSync(directory), []);
	panel.input("\x15");
	panel.input("40");
	panel.input("\r");
	assert.equal(config.writePreviewLines, 40);
	assert.equal(panel.changes, 1);
	assert.ok(!panel.text().includes("Enter a number"));
	panel.input("\x1b");
	await panel.completion;
});

test("renderer exclusions remain editable and cancel does not save", async () => {
	const panel = mountPanel();
	panel.input("\x1b[B");
	panel.input("\r");
	panel.input("read, read, custom:v2, invalid name");
	panel.input("\r");
	assert.deepEqual(config.excludeRenderers, ["read", "custom:v2"]);
	assert.equal(panel.changes, 1);
	assert.match(panel.text(), /Original renderers\s+read, custom:v2/);
	const saved = readFileSync(configPath(), "utf8");
	panel.input("\r");
	panel.input("changed");
	panel.input("\x1b");
	assert.equal(panel.closed, false);
	assert.equal(readFileSync(configPath(), "utf8"), saved);
	panel.input("\x1b");
	await panel.completion;
});

test("retained thinking toggle saves on its original page", async () => {
	const panel = mountPanel();
	panel.input("\t"); panel.input("\t"); panel.input("\r");
	assert.equal(config.useSummaryTitlesAsThinkingTitle, false);
	assert.equal(panel.changes, 1);
	panel.input("\x1b");
	await panel.completion;
});

test("numeric and exclusion submenus propagate focus for the terminal cursor", async () => {
	const panel = mountPanel();
	panel.component.focused = true;
	panel.input("\x1b[B");
	panel.input("\r");
	assert.ok(panel.text().includes(CURSOR_MARKER));
	panel.component.focused = false;
	assert.ok(!panel.text().includes(CURSOR_MARKER));
	panel.input("\x1b");
	panel.input("\t");
	panel.component.focused = true;
	panel.input("\r");
	assert.ok(panel.text().includes(CURSOR_MARKER));
	panel.input("\x1b");
	panel.input("\x1b");
	await panel.completion;
});

test("panel lines fit narrow widths across all pages and editable inputs", async () => {
	const panel = mountPanel();
	for (let page = 0; page < 4; page++) {
		for (const width of [1, 8, 20, 60]) {
			for (const line of panel.component.render(width)) assert.ok(visibleWidth(line) <= width);
		}
		panel.component.invalidate();
		panel.input("\t");
	}
	panel.input("\x1b[B");
	panel.input("\r");
	for (const line of panel.component.render(8)) assert.ok(visibleWidth(line) <= 8);
	panel.input("\x1b"); panel.input("\x1b");
	await panel.completion;
});
