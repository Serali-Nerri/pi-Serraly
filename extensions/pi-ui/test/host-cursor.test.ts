import assert from "node:assert/strict";
import test from "node:test";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Input, ScrollView, Text, VStack, visibleWidth } from "@earendil-works/pi-tui";
import { harness, strip } from "./harness.ts";

test("focused overlay and editor cursors remain native above the sticky transcript", async () => {
	const h = await harness({ rows: 10, columns: 40 });
	const writes: string[] = [];
	// Observe the terminal protocol; components and rendering stay native.
	h.terminal.write = (data: string) => writes.push(data);
	const editor = new Input();
	editor.handleInput("BASE");
	const popup = new Input();
	popup.handleInput("POP");
	const scroll = new ScrollView(h.root, { primary: true, scrollbar: "always" });
	h.root.addChild(new UserMessageComponent("Retained instruction"));
	h.root.addChild(new Text(Array.from({ length: 30 }, (_, i) => `Work line ${i}`).join("\n"), 0, 0));
	h.tui.setLayoutRoot(new VStack([
		{ component: scroll, grow: 1 },
		{ component: editor, basis: 1, shrink: 0 },
	]));
	h.tui.setFocus(editor);
	let overlay: ReturnType<typeof h.tui.showOverlay> | undefined;
	const screen = () => {
		h.tui.renderNow();
		const lines = h.tui.getScreenLines() as string[];
		assert.ok(lines.every((line) => !line.includes(CURSOR_MARKER)), "cursor markers never reach terminal output");
		assert.ok(lines.every((line) => visibleWidth(line) <= h.terminal.columns));
		return lines;
	};
	try {
		screen();
		scroll.scrollTo(5);
		let lines = screen();
		assert.match(strip(lines[0]!), /Retained instruction/);
		assert.equal(editor.focused, true);
		assert.ok(editor.render(40)[0]!.includes(CURSOR_MARKER));
		assert.match(lines[9]!, /BASE\x1b\[7m \x1b\[27m/, "the focused editor retains a native fake cursor");

		overlay = h.tui.showOverlay(popup, { row: 2, col: 5, width: 20, maxHeight: 1 });
		lines = screen();
		assert.equal(h.tui.getFocusedComponent(), popup);
		assert.equal(editor.focused, false);
		assert.equal(popup.focused, true);
		assert.match(strip(lines[0]!), /Retained instruction/);
		assert.match(lines[2]!, /POP\x1b\[7m \x1b\[27m/);
		assert.match(lines[9]!, /BASE\x1b\[7m \x1b\[27m/, "the unfocused editor cursor remains visible");

		h.tui.setShowHardwareCursor(true);
		lines = screen();
		assert.ok(writes.at(-1)!.includes("\x1b[3;11H\x1b[?25h"), "the overlay owns the visible hardware cursor position");
		assert.doesNotMatch(lines[2]!, /\x1b\[7m/, "the focused fake cursor is suppressed for hardware mode");
		assert.match(lines[9]!, /BASE\x1b\[7m \x1b\[27m/, "an unfocused fake cursor is not suppressed");
		h.tui.setShowHardwareCursor(false);
		lines = screen();
		assert.ok(writes.at(-1)!.includes("\x1b[3;11H\x1b[?25l"));
		assert.match(lines[2]!, /POP\x1b\[7m \x1b\[27m/);

		overlay.hide();
		lines = screen();
		assert.equal(h.tui.hasOverlay(), false);
		assert.equal(h.tui.getFocusedComponent(), editor);
		assert.equal(popup.focused, false);
		assert.match(strip(lines[0]!), /Retained instruction/);
		assert.doesNotMatch(lines.map(strip).join("\n"), /POP/);
		assert.match(lines[9]!, /BASE\x1b\[7m \x1b\[27m/);
		assert.ok(writes.at(-1)!.includes("\x1b[10;7H\x1b[?25l"), "closing the overlay restores the editor cursor position");
	} finally {
		overlay?.hide();
		await h.close();
	}
});
