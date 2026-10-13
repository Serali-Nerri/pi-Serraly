// Adapted from pi-cc-extensions v0.8.69; see THIRD_PARTY_NOTICES.md.
import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, TuiAltScreen, type Terminal } from "@earendil-works/pi-tui";
import { escCloseHitbox, hasActiveTextPreview, showTextPreview } from "../src/overlays/text-preview.ts";

initTheme("dark");

test("escCloseHitbox sits 5 columns wide at the title row's right edge", () => {
	assert.deepEqual(escCloseHitbox({ left: 8, top: 1, width: 64 }), {
		row: 3,
		startCol: 67,
		endCol: 71,
	});
	assert.deepEqual(escCloseHitbox({ left: 1, top: 1, width: 38 }), {
		row: 3,
		startCol: 34,
		endCol: 38,
	});
	assert.deepEqual(escCloseHitbox({ left: 20, top: 6, width: 50 }), {
		row: 8,
		startCol: 65,
		endCol: 69,
	});
});

/** showTextPreview 自定义 UI 的最小 harness：捕获 component（挂载后实时可读），theme 可注入，可选挂载回调。 */
function textPreviewHarness(
	theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text },
	onMount?: (component: any) => void,
): any {
	let component: any;
	const terminal = { columns: 80, rows: 24 };
	return {
		terminal,
		custom: async (factory: any) =>
			await new Promise<void>((resolve) => {
				component = factory(
					{ terminal, requestRender() {} },
					theme,
					null,
					resolve,
				);
				onMount?.(component);
			}),
		get component() {
			return component;
		},
	};
}

test("showTextPreview highlights and closes from the [esc] mouse hitbox", async () => {
	let escColor = "";
	const ui = textPreviewHarness(
		{
			fg: (color: string, text: string) => {
				if (text === "[esc]") escColor = color;
				return text;
			},
			bold: (text: string) => text,
		},
		(c) => c.render(64),
	);
	const preview = showTextPreview({ ui } as any, "Output", "hello");
	assert.equal(hasActiveTextPreview(), true);
	assert.equal(escColor, "muted");
	// 80×24、64 列居中、margin 2 → [esc] 命中 row=4, col=67..71。
	ui.component.handleInput(`\x1b[<35;67;4M`);
	ui.component.render(64);
	assert.equal(escColor, "text", "[esc] hover switches to text color");
	ui.component.handleInput(`\x1b[<0;67;4M`);
	await preview;
	assert.equal(hasActiveTextPreview(), false);
});

test("showTextPreview scrollbar supports press and drag", async () => {
	const ui = textPreviewHarness();
	const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
	const preview = showTextPreview({ ui } as any, "Output", content);
	const initial = ui.component.render(64).join("\n");
	assert.match(initial, /1-13 \/ 100 lines/);
	// scrollbar col=71，body track row=6..18；从顶部 thumb 拖到底部。
	ui.component.handleInput(`\x1b[<0;71;6M`);
	ui.component.handleInput(`\x1b[<32;71;18M`);
	ui.component.handleInput(`\x1b[<0;71;18m`);
	const dragged = ui.component.render(64).join("\n");
	assert.match(dragged, /88-100 \/ 100 lines/);
	ui.component.handleInput("\x1b");
	await preview;
});

test("normalized preview scrolling preserves wheel lines and cancels scrollbar dragging on resize", async () => {
	const ui = textPreviewHarness();
	const preview = showTextPreview({ ui } as any, "Output", Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n"));
	// Absolute coordinates deliberately differ from the centered dialog: normalized
	// component input must be independent of terminal placement.
	const mouse = (type: string, x: number, y: number, wheelDelta = 0) => ui.component.handleMouse({
		type, button: "left", x, y, screenX: x + 100, screenY: y + 100, width: 64, height: 30,
		shift: false, alt: false, ctrl: false, wheelDelta,
	});
	const status = () => ui.component.render(64).join("\n");
	try {
		assert.match(status(), /1-13 \/ 100 lines/);
		mouse("wheel", 20, 8, 9);
		assert.match(status(), /10-22 \/ 100 lines/);
		mouse("wheel", 20, 8, -4);
		assert.match(status(), /6-18 \/ 100 lines/);
		mouse("wheel", 20, 8, 0);
		assert.match(status(), /6-18 \/ 100 lines/);
		mouse("wheel", 20, 8, 1_000);
		assert.match(status(), /88-100 \/ 100 lines/);
		mouse("wheel", 20, 8, -1_000);
		assert.match(status(), /1-13 \/ 100 lines/);
		assert.notEqual(mouse("press", 20, 8)?.capture, true, "body selection is not captured");
		mouse("drag", 20, 15);
		assert.match(status(), /1-13 \/ 100 lines/);

		assert.equal(mouse("press", 62, 3)?.capture, true, "only scrollbar dragging captures");
		ui.terminal.rows = 40;
		assert.match(status(), /1-24 \/ 100 lines/);
		mouse("drag", 62, 26);
		assert.match(status(), /1-24 \/ 100 lines/, "resize cancels the active drag");
		mouse("release", 62, 26);
		assert.equal(mouse("press", 62, 3)?.capture, true, "a fresh press resumes dragging");
		mouse("drag", 62, 26);
		assert.match(status(), /77-100 \/ 100 lines/);
		mouse("release", 62, 26);
		mouse("drag", 62, 3);
		assert.match(status(), /77-100 \/ 100 lines/, "release ends dragging");
		ui.terminal.rows = 24;
		assert.match(status(), /77-89 \/ 100 lines/);
		assert.equal(mouse("press", 62, 15)?.capture, true, "track click jumps to its position");
		assert.match(status(), /88-100 \/ 100 lines/);
		mouse("release", 62, 15);
		assert.notEqual(mouse("press", 58, 1)?.capture, true, "close is not a drag interaction");
		await preview;
	} finally { ui.component.handleInput("\x1b"); await preview; }
});

test("native captured preview drag is cancelled by resize and resumes after release and fresh press", async () => {
	let input: (data: string) => void = () => { throw new Error("terminal not started"); };
	let resize: () => void = () => { throw new Error("terminal not started"); };
	const terminal = {
		columns: 80, rows: 24, kittyProtocolActive: false,
		start(onInput: (data: string) => void, onResize: () => void) { input = onInput; resize = onResize; },
		stop() {}, drainInput: async () => {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {},
		clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
	} satisfies Terminal;
	const tui = new TuiAltScreen(terminal);
	let overlay: ReturnType<typeof tui.showOverlay> | undefined;
	const ui = {
		custom: (factory: any, options: any) => new Promise<void>((done) => {
			const component = factory(tui,
				{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
				null, () => { overlay?.hide(); done(); });
			overlay = tui.showOverlay(component, options.overlayOptions);
		}),
	};
	const screen = () => {
		tui.renderNow();
		return tui.getScreenLines().map(stripTerminalSequences);
	};
	const scrollbar = () => {
		const lines = screen();
		const thumbRow = lines.findIndex((line) => line.includes("█"));
		assert.notEqual(thumbRow, -1, "the scrollbar thumb is painted");
		const col = lines[thumbRow]!.indexOf("█");
		const endRow = lines.reduce((last, line, row) => line[col] === "█" || line[col] === "│" ? row : last, thumbRow);
		return { col, thumbRow, endRow };
	};
	const pointer = (col: number, row: number, type: "press" | "drag" | "release") => {
		input(`\x1b[<${type === "drag" ? 32 : 0};${col + 1};${row + 1}${type === "release" ? "m" : "M"}`);
	};
	tui.start();
	const preview = showTextPreview({ ui } as any, "Output", Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n"));
	try {
		assert.match(screen().join("\n"), /1-13 \/ 100 lines/);
		const before = scrollbar();
		pointer(before.col, before.thumbRow, "press");
		terminal.rows = 40;
		resize();
		assert.match(screen().join("\n"), /1-24 \/ 100 lines/);
		const after = scrollbar();
		assert.notEqual(after.thumbRow, before.thumbRow, "the centered overlay moves on resize");
		// Send terminal coordinates through Pi's dispatcher, which retains the
		// press-time origin during capture rather than using the new overlay origin.
		pointer(after.col, after.thumbRow, "drag");
		assert.match(screen().join("\n"), /1-24 \/ 100 lines/, "a stale captured drag must not jump the thumb");
		pointer(after.col, after.thumbRow, "release");
		pointer(after.col, after.thumbRow, "press");
		pointer(after.col, after.endRow, "drag");
		assert.match(screen().join("\n"), /77-100 \/ 100 lines/, "fresh dragging uses the resized layout");
		pointer(after.col, after.thumbRow, "drag");
		assert.match(screen().join("\n"), /1-24 \/ 100 lines/, "ordinary thumb repaints do not cancel dragging");
		pointer(after.col, after.endRow, "drag");
		assert.match(screen().join("\n"), /77-100 \/ 100 lines/);
		terminal.columns = 100;
		resize();
		assert.match(screen().join("\n"), /77-100 \/ 100 lines/);
		const wider = scrollbar();
		assert.notEqual(wider.col, after.col, "the scrollbar moves when columns change");
		pointer(wider.col, after.thumbRow, "drag");
		assert.match(screen().join("\n"), /77-100 \/ 100 lines/, "column resize cancels dragging without resetting the offset");
		pointer(wider.col, after.thumbRow, "release");
		pointer(wider.col, wider.thumbRow, "press");
		pointer(wider.col, after.thumbRow, "drag");
		assert.match(screen().join("\n"), /1-24 \/ 100 lines/, "fresh dragging also resumes after column resize");
		pointer(wider.col, after.thumbRow, "release");
	} finally {
		input("\x1b");
		overlay?.hide();
		tui.stop();
		await preview;
	}
});

test("text preview activity is released when custom UI rejects", async () => {
	await assert.rejects(showTextPreview({ ui: { custom: async () => { throw new Error("closed"); } } } as any, "Output", "text"), /closed/);
	assert.equal(hasActiveTextPreview(), false);
});
