import assert from "node:assert/strict";
import test from "node:test";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { HStack, MouseRegion, ScrollView, Text, TuiAltScreen, VStack, setCapabilityOverrides, sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { setToolMouseTui } from "../src/overlays/mouse-state.ts";
import { harness, strip } from "./harness.ts";

const work = () => new Text(Array.from({ length: 12 }, (_, i) => `Work output ${i}`).join("\n"), 0, 0);

test("fullscreen pins the first body line by viewed history, replacing it only after the next instruction crosses the top", async () => {
	const h = await harness({ rows: 8 });
	try {
		h.root.addChild(new UserMessageComponent("First instruction\nSecond body line"));
		h.root.addChild(work());
		h.root.addChild(new UserMessageComponent("Next instruction"));
		h.root.addChild(work());
		h.render();
		h.tui.scrollToTop();
		assert.equal(h.render()[0]!.trim(), "");
		h.tui.scrollBy(1);
		assert.equal(h.render()[0]!.trim(), "First instruction");
		h.tui.scrollBy(1);
		assert.equal(h.render()[0]!.trim(), "First instruction", "the body is now above the viewport");
		assert.doesNotMatch(h.render()[0]!, /Second body line/);
		h.tui.scrollBy(14);
		assert.equal(h.render()[0]!.trim(), "First instruction", "the next instruction has not crossed yet");
		h.tui.scrollBy(2);
		assert.equal(h.render()[0]!.trim(), "Next instruction");
		h.tui.scrollBy(-16);
		assert.equal(h.render()[0]!.trim(), "First instruction", "viewing history does not retain the newest prompt");
	} finally { await h.close(); }
});

test("only the painted instruction cells jump in an offset viewport, leaving its other rows and margins native", async () => {
	const h = await harness({ rows: 9, columns: 24 });
	try {
		let nativeClicks = 0;
		const native = (component: Text) => new MouseRegion(component, (event) => {
			if (event.type === "click") nativeClicks++;
			return { handled: true };
		});
		h.root.addChild(new UserMessageComponent("Jump"));
		h.root.addChild(native(work()));
		const scroll = new ScrollView(h.root, { primary: true, scrollbar: "always" });
		h.tui.setLayoutRoot(new HStack([
			{ component: native(new Text("Sidebar", 0, 0)), basis: 4, shrink: 0 },
			{ component: new VStack([
				{ component: native(new Text("Header", 0, 0)), basis: 2, shrink: 0 },
				{ component: scroll, grow: 1 },
				{ component: native(new Text("Footer", 0, 0)), basis: 1, shrink: 0 },
			]), grow: 1 },
		]));
		h.render();
		scroll.scrollTo(5);
		const screen = h.render();
		assert.equal(screen[0]!.slice(4).trim(), "Header");
		assert.match(screen[2]!, /^ {5}Jump/);
		for (const [x, y] of [[5, 0], [5, 3], [4, 2], [9, 2]]) {
			h.click(x!, y!);
			assert.equal(scroll.scrollTop, 5, "header, body rows and sticky margins do not jump");
		}
		assert.equal(nativeClicks, 4, "unpainted areas retain the host's component interaction");
		h.click(8, 2);
		assert.equal(scroll.scrollTop, 0, "the last painted body cell still jumps");
		assert.equal(nativeClicks, 4);
	} finally { await h.close(); }
});

test("compact sticky text preserves CJK, emoji and combining cells without occupying the scrollbar", async () => {
	const h = await harness({ mode: "compact", rows: 8, columns: 12 });
	try {
		h.root.addChild(new Text("pre\npre\npre\npre\npre\npre", 0, 0));
		h.root.addChild(new UserMessageComponent("你好👩‍💻é终Z尾", undefined, 0));
		h.root.addChild(work());
		h.tui.setLayoutRoot(new ScrollView(h.root, { primary: true, scrollbar: "always" }));
		h.render();
		h.tui.scrollToTop();
		h.tui.scrollBy(12);
		let screen = h.render();
		assert.equal(sliceByColumn(screen[0]!, 0, 11).trim(), "你好👩‍💻é终Z");
		assert.equal(sliceByColumn(screen[0]!, 11, 1), "│", "the host still paints the scrollbar column");
		assert.ok(screen.every((line) => visibleWidth(line) <= 12));
		h.click(11, 0);
		assert.equal(h.tui.viewportTop, 0, "scrollbar input goes to the host, not the instruction at row six");
		h.tui.scrollBy(12);
		h.render();
		h.click(9, 0);
		assert.equal(h.tui.viewportTop, 6, "either cell of a painted wide grapheme returns to the prompt");
		h.terminal.columns = 5;
		h.render();
		h.tui.scrollBy(6);
		screen = h.render();
		assert.equal(sliceByColumn(screen[0]!, 0, 4).trim(), "你", "a wide character crossing the last body column is omitted whole");
		assert.ok(screen.every((line) => visibleWidth(line) <= 5));
		h.click(3, 0);
		assert.equal(h.tui.viewportTop, 12, "unused clipping padding is outside the drawn text target");
		h.click(2, 0);
		assert.equal(h.tui.viewportTop, 6, "both drawn cells of the remaining wide character are active");
	} finally { await h.close(); }
});

test("moving from a file hint onto sticky text clears the previous native card hover", async () => {
	const h = await harness({ rows: 8 });
	setCapabilityOverrides({ trueColor: true });
	try {
		h.root.addChild(new UserMessageComponent("Viewed instruction"));
		const write = h.tool("write", "sticky-hover", {
			path: "long.ts", content: Array.from({ length: 120 }, (_, index) => `line ${index + 1}`).join("\n"),
		}, { content: [{ type: "text", text: "ok" }], isError: false });
		write.setExpanded(true);
		h.render();
		h.tui.scrollToTop();
		let lines = h.render();
		let row = -1;
		for (let i = 0; i < 80 && row < 0; i++) {
			h.tui.scrollBy(1);
			lines = h.render();
			row = lines.findIndex((line, index) => index > 0 && line.includes("click to show more"));
		}
		assert.ok(row > 0, "a file hint is visible below the sticky instruction");
		assert.match(lines[0]!, /Viewed instruction/);
		const hint = () => h.tui.getScreenLines().find((line: string) => strip(line).includes("click to show more"))!;
		assert.match(hint(), /\x1b\[38;2;127;127;127m/);
		h.pointer(lines[row]!.indexOf("click to show more"), row, "move");
		h.render();
		assert.match(hint(), /\x1b\[38;2;242;242;242m/);
		h.pointer(2, 0, "move");
		h.render();
		assert.match(hint(), /\x1b\[38;2;127;127;127m/, "the covered card no longer remains hovered");
	} finally { setCapabilityOverrides({}); await h.close(); }
});

test("a one-row viewport preserves the native jump-to-end label and its input instead of hiding it under sticky text", async () => {
	const h = await harness({ rows: 1, columns: 32 });
	let input: (data: string) => void = () => assert.fail("terminal input is not connected");
	const tui = new TuiAltScreen({ ...h.terminal,
		start(onInput: (data: string) => void) { input = onInput; },
	} as any, false, undefined, { scrollToEndIndicator: () => "Back to end", copyOnSelect: false });
	try {
		h.root.addChild(new UserMessageComponent("Important instruction"));
		h.root.addChild(work());
		h.tui.removeChild(h.root);
		tui.addChild(h.root);
		setToolMouseTui(tui);
		tui.start();
		tui.requestRender(true);
		await h.flush();
		tui.scrollToTop();
		tui.scrollBy(5);
		tui.requestRender(true);
		await h.flush();
		const line = tui.getScreenLines().map(strip)[0]!;
		assert.match(line, /Back to end/);
		assert.doesNotMatch(line, /Important instruction/);
		const x = visibleWidth(line.slice(0, line.indexOf("Back to end")));
		input(`\x1b[<0;${x + 1};1M`);
		input(`\x1b[<0;${x + 1};1m`);
		assert.equal(tui.isFollowingOutput, true, "the visible host label still owns its jump-to-end action");
	} finally { tui.stop({ preserveScreen: true }); await h.close(); }
});

test("style-off, regular and non-TUI hosts keep native user-message frames", async () => {
	for (const options of [{ mode: "off" as const }, { tuiMode: "regular" as const }, { headless: true }]) {
		const h = await harness({ rows: 8, ...options });
		try {
			h.root.addChild(new UserMessageComponent("Native instruction"));
			h.root.addChild(work());
			h.render();
			if (h.tui.mode === "fullscreen") {
				h.tui.scrollToTop();
				h.tui.scrollBy(5);
			}
			const screen = h.render();
			assert.doesNotMatch(screen[0]!, /Native instruction/);
			if (h.tui.mode === "regular") assert.equal(screen[1]!.trim(), "Native instruction", "regular keeps the natural message body");
			else {
				h.click(2, 0);
				assert.equal(h.tui.viewportTop, 5, "native pointer input does not acquire a sticky jump");
			}
		} finally { await h.close(); }
	}
});

test("clicking a sticky instruction survives ordinary repaints between press and release", async () => {
	const h = await harness({ rows: 8 });
	try {
		h.root.addChild(new UserMessageComponent("Repainted instruction"));
		h.root.addChild(work());
		h.render();
		h.tui.scrollToTop();
		h.tui.scrollBy(5);
		assert.equal(h.render()[0]!.trim(), "Repainted instruction");
		h.pointer(2, 0);
		assert.equal(h.render()[0]!.trim(), "Repainted instruction");
		assert.equal(h.render()[0]!.trim(), "Repainted instruction");
		h.pointer(2, 0, "release");
		assert.equal(h.tui.viewportTop, 0, "unchanged instruction cells remain the pressed target after repaint");
	} finally { await h.close(); }
});

test("scroll, resize and layout replacement reject a sticky press from the previous painted frame", async () => {
	const h = await harness({ rows: 8 });
	try {
		h.root.addChild(new UserMessageComponent("Stale instruction"));
		h.root.addChild(work());
		h.render();
		h.tui.scrollToTop();
		h.tui.scrollBy(5);
		assert.equal(h.render()[0]!.trim(), "Stale instruction");
		h.pointer(2, 0);
		h.tui.scrollBy(1);
		h.pointer(2, 0, "release");
		assert.equal(h.tui.viewportTop, 6, "scrolling invalidates the press even before a repaint");
		h.render();
		h.pointer(2, 0);
		h.terminal.columns = 60;
		h.pointer(2, 0, "release");
		assert.equal(h.tui.viewportTop, 6, "resizing invalidates the old width before a repaint");
		h.render();
		h.pointer(2, 0);
		h.tui.setLayoutRoot(new ScrollView(h.root, { primary: true }));
		h.pointer(2, 0, "release");
		assert.equal(h.tui.viewportTop, 6, "replacing the layout invalidates the old target before rendering");
		h.render();
		h.tui.scrollBy(5);
		assert.equal(h.render()[0]!.trim(), "Stale instruction");
		h.click(2, 0);
		assert.equal(h.tui.viewportTop, 0, "a fresh layout restores a usable jump");
	} finally { await h.close(); }
});

test("navigation and shutdown reject old sticky gestures and return pointer ownership to the host", async () => {
	const h = await harness({ rows: 8 });
	try {
		h.root.addChild(new UserMessageComponent("Old instruction"));
		h.root.addChild(work());
		h.render();
		h.tui.scrollToTop();
		h.tui.scrollBy(5);
		assert.equal(h.render()[0]!.trim(), "Old instruction");
		h.pointer(2, 0);
		await h.emit("session_tree");
		h.pointer(2, 0, "release");
		assert.equal(h.tui.viewportTop, 5, "navigation clears a press already captured by the native host");
		h.root.clear();
		h.root.addChild(new UserMessageComponent("Replacement instruction"));
		h.root.addChild(work());
		h.click(2, 0);
		assert.equal(h.tui.viewportTop, 5, "navigation invalidates the previous frame before the host rebuild renders");
		assert.equal(h.render()[0]!.trim(), "Replacement instruction");
		h.pointer(2, 0);
		await h.close();
		let nativeClicks = 0;
		h.root.clear();
		h.root.addChild(new MouseRegion(work(), (event) => {
			if (event.type === "click") nativeClicks++;
			return { handled: true };
		}));
		h.render();
		h.click(2, 0);
		assert.equal(nativeClicks, 1, "shutdown releases a sticky press without leaving an owned native capture");
		assert.doesNotMatch(h.render().join("\n"), /instruction/);
	} finally { await h.close(); }
});

test("reload handover leaves the new host's sticky jump active when the previous host renders or shuts down", async () => {
	const previous = await harness({ rows: 8 });
	let current: Awaited<ReturnType<typeof harness>> | undefined;
	try {
		previous.root.addChild(new UserMessageComponent("Previous instruction"));
		previous.root.addChild(work());
		previous.render();
		previous.tui.scrollToTop();
		previous.tui.scrollBy(5);
		assert.equal(previous.render()[0]!.trim(), "Previous instruction");
		previous.pointer(2, 0);
		current = await harness({ rows: 8 });
		current.root.addChild(new UserMessageComponent("Current instruction"));
		current.root.addChild(work());
		current.render();
		current.tui.scrollToTop();
		current.tui.scrollBy(5);
		assert.equal(current.render()[0]!.trim(), "Current instruction");
		assert.doesNotMatch(previous.render()[0]!, /Previous instruction/, "the previous host returns to native rendering");
		await previous.close();
		current.click(2, 0);
		assert.equal(current.tui.viewportTop, 0, "an old render and shutdown cannot invalidate the new sticky frame");
		assert.equal(current.render()[1]!.trim(), "Current instruction");
	} finally { await current?.close(); await previous.close(); }
});

test("clicking the drawn sticky body returns to the original prompt, without changing its saved text", async () => {
	const h = await harness({ rows: 8 });
	try {
		const user = new UserMessageComponent("Return here\nOriginal second line");
		h.root.addChild(user);
		h.root.addChild(work());
		h.render();
		h.tui.scrollToTop();
		h.tui.scrollBy(5);
		assert.equal(h.render()[0]!.trim(), "Return here");
		h.click(2, 0);
		assert.equal(h.tui.viewportTop, 0);
		const screen = h.render();
		assert.equal(screen[1]!.trim(), "Return here");
		assert.equal(screen[2]!.trim(), "Original second line");
		assert.doesNotMatch(h.tui.getScreenLines().join("\n"), /\x1b\]133;/, "native prompt zones are consumed before terminal output");
	} finally { await h.close(); }
});
