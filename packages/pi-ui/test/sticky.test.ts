import assert from "node:assert/strict";
import test from "node:test";
import {
	getMarkdownTheme,
	initTheme,
	UserMessageComponent,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	ScrollView,
	Text,
	TuiAltScreen,
	VStack,
	stripTerminalSequences,
	type Terminal,
} from "@earendil-works/pi-tui";
import { installSticky } from "../src/sticky.js";

initTheme("dark");

class FakeTerminal implements Terminal {
	columns: number;
	rows: number;
	kittyProtocolActive = false;
	private input: ((data: string) => void) | undefined;

	constructor(columns: number, rows: number) {
		this.columns = columns;
		this.rows = rows;
	}

	start(onInput: (data: string) => void, _onResize: () => void): void {
		this.input = onInput;
	}

	stop(): void {
		this.input = undefined;
	}

	async drainInput(): Promise<void> {}

	write(_data: string): void {}

	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	setProgramStatus(): void {}

	private mouse(button: number, x: number, y: number, release = false): void {
		this.input?.(`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`);
	}

	press(x: number, y: number, modifiers = 0): void {
		this.mouse(modifiers, x, y);
	}

	drag(x: number, y: number): void {
		this.mouse(32, x, y);
	}

	release(x: number, y: number, modifiers = 0): void {
		this.mouse(modifiers, x, y, true);
	}
}

function fakeTheme(marker: string): Theme {
	return {
		fg: (_token: string, text: string) => text,
		bg: (_token: string, text: string) => `\x1b[${marker}m${text}\x1b[49m`,
	} as unknown as Theme;
}

function visible(line: string): string {
	return stripTerminalSequences(line);
}

function firstBody(component: UserMessageComponent, width: number): { offset: number; text: string } {
	const lines = component.render(width);
	const offset = lines.findIndex((line) => visible(line).trim().length > 0);
	assert.notEqual(offset, -1, "user message must render a body line");
	return { offset, text: visible(lines[offset] ?? "").trim() };
}

function createFixture(options: {
	enabled?: () => boolean;
	width?: number;
	rows?: number;
	theme?: () => Theme;
}) {
	const width = options.width ?? 40;
	const rows = options.rows ?? 12;
	const terminal = new FakeTerminal(width, rows);
	const tui = new TuiAltScreen(terminal, false, undefined, {
		mouse: true,
		scrollToEndIndicator: () => "JUMP TO END",
	});
	const first = new UserMessageComponent("First question", getMarkdownTheme(), 0);
	const second = new UserMessageComponent("Second question", getMarkdownTheme(), 0);
	const head = new Text("head", 0, 0);
	const fillerA = new Text(Array.from({ length: 10 }, (_, index) => `a${index}`).join("\n"), 0, 0);
	const fillerB = new Text(Array.from({ length: 12 }, (_, index) => `b${index}`).join("\n"), 0, 0);
	const chat = new Container();
	chat.addChild(head);
	chat.addChild(first);
	chat.addChild(fillerA);
	chat.addChild(second);
	chat.addChild(fillerB);
	const scroll = new ScrollView(chat, { follow: "end", primary: true, scrollbar: "always" });
	const root = new VStack([
		{ component: scroll, basis: 0, grow: 1, minSize: 1 },
		{ component: new Text("footer", 0, 0), basis: 1 },
	]);
	tui.setLayoutRoot(root);
	tui.start();
	tui.renderNow(true);

	const secondStart = head.render(width).length + first.render(width).length + fillerA.render(width).length;
	const firstBodyLine = firstBody(first, width);
	const secondBody = firstBody(second, width);
	const sourceRow = secondStart;
	const scrolledTop = sourceRow + secondBody.offset + 1;
	const maxTop = chat.render(width).length - scroll.viewportHeight;
	assert.ok(scrolledTop <= maxTop, `test transcript needs more content after the second message (${scrolledTop} > ${maxTop})`);

	const sticky = installSticky({
		getTui: () => tui,
		getTheme: options.theme ?? (() => fakeTheme("44")),
		enabled: options.enabled ?? (() => true),
	});

	return {
		terminal,
		tui,
		scroll,
		first,
		second,
		firstBody: firstBodyLine,
		secondBody,
		sourceRow,
		scrolledTop,
		sticky,
		dispose() {
			sticky.dispose();
			tui.stop();
		},
	};
}

test("paints the nearest user body at the transcript top once it scrolls out", (t) => {
	const fixture = createFixture({});
	t.after(() => fixture.dispose());

	fixture.scroll.scrollTo(fixture.sourceRow);
	fixture.tui.renderNow(true);
	assert.ok(!visible(fixture.tui.getScreenLines()[0] ?? "").includes(fixture.secondBody.text), "a visible user message is not sticky");
	fixture.scroll.scrollTo(fixture.sourceRow + fixture.secondBody.offset);
	fixture.tui.renderNow(true);
	assert.ok(
		!visible(fixture.tui.getScreenLines()[0] ?? "").includes(fixture.firstBody.text),
		"a user body on the top row is still visible, so an older message is not sticky",
	);

	fixture.scroll.scrollTo(fixture.scrolledTop);
	fixture.tui.renderNow(true);
	const screen = fixture.tui.getScreenLines();
	const top = visible(screen[0] ?? "");
	assert.ok(top.includes(fixture.secondBody.text), "the nearest scrolled-out user body is shown at the top");
	assert.ok(!top.includes("First question"), "an older user message never replaces the nearest one");
	assert.ok(["│", "┃", "█"].includes(top.at(-1) ?? ""), "the sticky row leaves the scrollbar column untouched");
	assert.ok(visible(screen[fixture.scroll.viewportHeight - 1] ?? "").includes("JUMP TO END"), "the native jump-to-end label remains available");
});

test("a sticky click jumps to the exact source line of the original user message", (t) => {
	const fixture = createFixture({});
	t.after(() => fixture.dispose());

	fixture.scroll.scrollTo(fixture.scrolledTop);
	fixture.tui.renderNow(true);
	fixture.terminal.press(1, 0);
	fixture.terminal.release(1, 0);
	fixture.tui.renderNow(true);

	assert.equal(fixture.scroll.scrollTop, fixture.sourceRow);
	assert.ok(
		fixture.tui
			.getScreenLines()
			.slice(0, fixture.secondBody.offset + 1)
			.some((line) => visible(line).includes(fixture.secondBody.text)),
	);
});

for (const [name, modifiers] of [
	["shift", 4],
	["alt", 8],
	["ctrl", 16],
] as const) {
	test(`sticky ignores ${name}-modified clicks`, (t) => {
		const fixture = createFixture({});
		t.after(() => fixture.dispose());

		fixture.scroll.scrollTo(fixture.scrolledTop);
		fixture.tui.renderNow(true);
		fixture.terminal.press(1, 0, modifiers);
		fixture.terminal.release(1, 0, modifiers);
		fixture.tui.renderNow(true);

		assert.equal(fixture.scroll.scrollTop, fixture.scrolledTop, "a modified click never navigates the transcript");
	});
}

test("native drag selection survives a drag across the sticky row", (t) => {
	const fixture = createFixture({});
	t.after(() => fixture.dispose());

	fixture.scroll.scrollTo(fixture.scrolledTop);
	fixture.tui.renderNow(true);
	assert.ok(visible(fixture.tui.getScreenLines()[0] ?? "").includes(fixture.secondBody.text));

	fixture.terminal.press(2, 2);
	fixture.terminal.drag(2, 0);
	fixture.terminal.release(2, 0);
	fixture.tui.renderNow(true);

	assert.ok(fixture.tui.hasActiveSelection(), "the native selection still owns the drag gesture");
});

test("reads the current theme for every sticky frame", (t) => {
	let marker = "44";
	const fixture = createFixture({ theme: () => fakeTheme(marker) });
	t.after(() => fixture.dispose());

	fixture.scroll.scrollTo(fixture.scrolledTop);
	fixture.tui.renderNow(true);
	assert.ok((fixture.tui.getScreenLines()[0] ?? "").includes("\x1b[44m"));

	marker = "45";
	fixture.tui.renderNow(true);
	const top = fixture.tui.getScreenLines()[0] ?? "";
	assert.ok(top.includes("\x1b[45m"), "theme changes apply to the next frame");
	assert.ok(!top.includes("\x1b[44m"), "the previous theme is not retained");
});

test("recomputes the sticky row after a terminal resize", (t) => {
	const fixture = createFixture({});
	t.after(() => fixture.dispose());

	fixture.scroll.scrollTo(fixture.scrolledTop);
	fixture.tui.renderNow(true);
	assert.ok(visible(fixture.tui.getScreenLines()[0] ?? "").includes(fixture.secondBody.text));

	fixture.terminal.columns = 30;
	fixture.terminal.rows = 10;
	fixture.tui.renderNow(true);
	const top = visible(fixture.tui.getScreenLines()[0] ?? "");
	assert.ok(top.includes(fixture.secondBody.text), "the sticky body survives a resize");
	assert.equal(top.length, 30, "the sticky row uses the resized terminal width");
});

test("disabled sticky leaves the scrolled transcript untouched", (t) => {
	const fixture = createFixture({ enabled: () => false });
	t.after(() => fixture.dispose());

	fixture.scroll.scrollTo(fixture.scrolledTop);
	fixture.tui.renderNow(true);
	const top = visible(fixture.tui.getScreenLines()[0] ?? "");
	assert.ok(!top.includes(fixture.secondBody.text));
});

test("rejects an incompatible fullscreen renderer before installing", () => {
	const proto = TuiAltScreen.prototype;
	const descriptor = Object.getOwnPropertyDescriptor(proto, "dispatchMouseToLayout");
	assert.ok(descriptor);
	Object.defineProperty(proto, "dispatchMouseToLayout", { ...descriptor, value: undefined });
	try {
		assert.throws(
			() =>
				installSticky({
					getTui: () => undefined,
					getTheme: () => fakeTheme("44"),
					enabled: () => true,
				}),
			/dispatchMouseToLayout/,
		);
	} finally {
		Object.defineProperty(proto, "dispatchMouseToLayout", descriptor);
	}
});

test("rejects a renderer without the primary scroll view capability before installing", () => {
	const proto = TuiAltScreen.prototype;
	const descriptor = Object.getOwnPropertyDescriptor(proto, "getPrimaryScrollView");
	assert.ok(descriptor);
	Object.defineProperty(proto, "getPrimaryScrollView", { ...descriptor, value: undefined });
	let installed: ReturnType<typeof installSticky> | undefined;
	try {
		assert.throws(
			() => {
				installed = installSticky({
					getTui: () => undefined,
					getTheme: () => fakeTheme("44"),
					enabled: () => true,
				});
			},
			/getPrimaryScrollView/,
		);
	} finally {
		installed?.dispose();
		Object.defineProperty(proto, "getPrimaryScrollView", descriptor);
	}
});
