import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { initTheme, AssistantMessageComponent, type ExtensionAPI, type SessionEntry, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { installThinking } from "../src/thinking.js";

initTheme("dark");

type Message = NonNullable<ConstructorParameters<typeof AssistantMessageComponent>[0]>;
type Config = {
	useSummaryTitlesAsThinkingTitle: boolean;
	previewLines: number;
	animationIntervalMs: number;
	stickyUserMessage: boolean;
};

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
} as unknown as Theme;

function assistant(timestamp: number, content: unknown[], overrides: Record<string, unknown> = {}): Message {
	return {
		role: "assistant",
		timestamp,
		content,
		api: "openai-responses",
		provider: "fixture",
		model: "fixture",
		stopReason: "stop",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		...overrides,
	} as Message;
}

function thinking(text: string, thinkingSignature?: string) {
	return thinkingSignature === undefined ? { type: "thinking", thinking: text } : { type: "thinking", thinking: text, thinkingSignature };
}

function text(value: string) {
	return { type: "text", text: value };
}

function createRuntime() {
	const handlers = new Map<string, Set<(event: unknown) => void>>();
	const entries: { customType: string; data?: unknown }[] = [];
	let renders = 0;
	const config: Config = {
		useSummaryTitlesAsThinkingTitle: true,
		previewLines: 3,
		animationIntervalMs: 10,
		stickyUserMessage: true,
	};
	const pi = {
		on(name: string, handler: (event: unknown) => void) {
			let set = handlers.get(name);
			if (!set) handlers.set(name, (set = new Set()));
			set.add(handler);
			return () => set?.delete(handler);
		},
		appendEntry(customType: string, data?: unknown) {
			entries.push({ customType, data });
		},
	} as unknown as ExtensionAPI;
	const controller = installThinking(pi, {
		getConfig: () => config,
		requestRender: () => { renders += 1; },
		getTheme: () => theme,
	});
	return {
		config,
		controller,
		entries,
		get renders() { return renders; },
		handlerCount() {
			let count = 0;
			for (const set of handlers.values()) count += set.size;
			return count;
		},
		emit(name: string, event: unknown) {
			for (const handler of handlers.get(name) ?? []) handler(event);
		},
		update(message: Message, event: Record<string, unknown>) {
			const assistantMessageEvent = { ...event, partial: message };
			for (const handler of handlers.get("message_update") ?? []) handler({ type: "message_update", message, assistantMessageEvent });
		},
		end(message: Message) {
			for (const handler of handlers.get("message_end") ?? []) handler({ type: "message_end", message });
		},
	};
}

function rendered(component: AssistantMessageComponent, width = 80): string {
	return component.render(width).map((line) => stripTerminalSequences(line)).join("\n");
}

function regions(component: AssistantMessageComponent): any[] {
	return (component as any).contentContainer.children.filter((child: any) => child && "child" in child && typeof child.onMouse === "function");
}

function click(component: AssistantMessageComponent, index = 0): void {
	const region = regions(component)[index];
	assert.ok(region, `missing thinking region ${index}`);
	region.handleMouse({ type: "click", button: "left", x: 0, y: 0, screenX: 0, screenY: 0, width: 80, height: 10, shift: false, alt: false, ctrl: false, clickCount: 1 });
}

function customEntry(customType: string, data: unknown, id = "entry"): SessionEntry {
	return { type: "custom", id, parentId: null, timestamp: new Date(1_700_000_000_000).toISOString(), customType, data } as SessionEntry;
}

test("decorates hidden and expanded runs, preserving title and per-run native expansion", () => {
	const runtime = createRuntime();
	try {
		const first = Array.from({ length: 12 }, (_, index) => `FIRST_LINE_${index}`).join("\n");
		const second = Array.from({ length: 12 }, (_, index) => `SECOND_LINE_${index}`).join("\n");
		const message = assistant(1000, [
			thinking(`**Alpha plan**\n\n${first}`),
			text("ANSWER_BETWEEN_RUNS"),
			thinking(`**Beta plan**\n\n${second}`),
		]);
		const component = new AssistantMessageComponent(message, true);

		let output = rendered(component);
		assert.match(output, /Alpha plan/);
		assert.match(output, /FIRST_LINE_11/);
		assert.doesNotMatch(output, /FIRST_LINE_0\b/);
		assert.match(output, /click to expand/);
		assert.match(output, /ANSWER_BETWEEN_RUNS/);

		click(component, 0);
		output = rendered(component);
		assert.match(output, /Alpha plan/);
		assert.match(output, /FIRST_LINE_0\b/);
		assert.match(output, /SECOND_LINE_11/);
		assert.doesNotMatch(output, /SECOND_LINE_0\b/);

		component.setHideThinkingBlock(true);
		output = rendered(component);
		assert.match(output, /FIRST_LINE_0\b/);
		assert.match(output, /SECOND_LINE_11/);
		assert.doesNotMatch(output, /SECOND_LINE_0\b/);

		component.setHideThinkingBlock(false);
		output = rendered(component);
		assert.match(output, /FIRST_LINE_0\b/);
		assert.match(output, /SECOND_LINE_0\b/);

		component.setHideThinkingBlock(true);
		output = rendered(component);
		assert.doesNotMatch(output, /FIRST_LINE_0\b/);
		assert.match(output, /SECOND_LINE_11/);
		assert.match(output, /click to expand/);
	} finally {
		runtime.controller.dispose();
	}
});

test("preserves native initial expansion when hideThinkingBlock is false", () => {
	const runtime = createRuntime();
	try {
		const body = Array.from({ length: 6 }, (_, index) => `NATIVE_LINE_${index}`).join("\n");
		const component = new AssistantMessageComponent(assistant(1006, [thinking(`**Native plan**\n\n${body}`)]), false);
		const output = rendered(component);
		assert.match(output, /Native plan/);
		assert.match(output, /NATIVE_LINE_0\b/);
		assert.match(output, /NATIVE_LINE_5\b/);
		assert.doesNotMatch(output, /click to expand/);
	} finally {
		runtime.controller.dispose();
	}
});

test("same-value global hide does not clear local expansion; a real global transition does", () => {
	const runtime = createRuntime();
	try {
		const message = assistant(1001, [thinking(`**Plan**\n\n${["LOCAL_FIRST", ...Array.from({ length: 8 }, (_, index) => `LOCAL_LINE_${index}`), "LOCAL_BODY"].join("\n")}`)]);
		const component = new AssistantMessageComponent(message, true);
		click(component);
		assert.match(rendered(component), /LOCAL_FIRST/);
		assert.match(rendered(component), /LOCAL_BODY/);
		component.updateContent(assistant(1001, [thinking(`**Plan**\n\n${["LOCAL_FIRST", ...Array.from({ length: 8 }, (_, index) => `LOCAL_LINE_${index}`), "LOCAL_BODY", "STREAMED_TAIL"].join("\n")}`)]), true);
		assert.match(rendered(component), /STREAMED_TAIL/);

		component.setHideThinkingBlock(true);
		assert.match(rendered(component), /LOCAL_FIRST/);
		assert.match(rendered(component), /STREAMED_TAIL/);
		assert.match(rendered(component), /Plan/);

		component.setHideThinkingBlock(false);
		const globallyVisible = rendered(component);
		assert.match(globallyVisible, /LOCAL_FIRST/);
		assert.match(globallyVisible, /STREAMED_TAIL/);
		component.setHideThinkingBlock(true);
		const collapsed = rendered(component);
		assert.doesNotMatch(collapsed, /LOCAL_FIRST/);
		assert.match(collapsed, /STREAMED_TAIL/);
		assert.match(collapsed, /click to expand/);
	} finally {
		runtime.controller.dispose();
	}
});

test("preserves assistant text and errors across decoration", () => {
	const runtime = createRuntime();
	try {
		const message = assistant(1002, [thinking("**Plan**\n\nBODY"), text("VISIBLE_ANSWER")], {
			stopReason: "error",
			errorMessage: "BOOM",
		});
		const component = new AssistantMessageComponent(message, false);
		const output = rendered(component);
		assert.match(output, /VISIBLE_ANSWER/);
		assert.match(output, /Error: BOOM/);
		assert.match(output, /Plan/);
	} finally {
		runtime.controller.dispose();
	}
});

test("uses structured summary titles, latest live title, and config refresh without rebuild", () => {
	const runtime = createRuntime();
	try {
		const signature = JSON.stringify({ type: "reasoning", summary: [{ type: "summary_text", text: "**Signature title**\n\nSIGNATURE_BODY" }] });
		const message = assistant(1003, [thinking("RAW_HIDDEN_TEXT", signature)]);
		const component = new AssistantMessageComponent(message, true);
		assert.match(rendered(component), /Signature title/);
		assert.match(rendered(component), /SIGNATURE_BODY/);
		assert.doesNotMatch(rendered(component), /RAW_HIDDEN_TEXT/);

		runtime.config.useSummaryTitlesAsThinkingTitle = false;
		runtime.controller.refresh();
		const withoutTitles = rendered(component);
		assert.doesNotMatch(withoutTitles, /Signature title/);
		assert.match(withoutTitles, /Thought/);
		assert.match(withoutTitles, /RAW_HIDDEN_TEXT/);

		runtime.config.useSummaryTitlesAsThinkingTitle = true;
		runtime.controller.refresh();
		assert.match(rendered(component), /Signature title/);

		const live = assistant(1004, [thinking("**First title**\n\nOne\n\n**Latest title**\n\nTwo")]);
		runtime.update(live, { type: "thinking_start", contentIndex: 0 });
		const liveComponent = new AssistantMessageComponent(live, true);
		assert.match(rendered(liveComponent), /Latest title/);

		const plainProvider = assistant(1005, [thinking("**Plain provider plan**\n\nPLAIN_BODY")], { api: "anthropic-messages" });
		const plainOutput = rendered(new AssistantMessageComponent(plainProvider, true));
		assert.match(plainOutput, /Plain provider plan/);
		assert.match(plainOutput, /PLAIN_BODY/);

		const plainStructured = assistant(1007, [thinking("RAW_PROVIDER_TEXT", signature)], { api: "anthropic-messages" });
		const plainStructuredOutput = rendered(new AssistantMessageComponent(plainStructured, true));
		assert.match(plainStructuredOutput, /Signature title/);
		assert.match(plainStructuredOutput, /SIGNATURE_BODY/);
	} finally {
		runtime.controller.dispose();
	}
});

test("strips terminal controls from summary headings and previews before rendering", () => {
	const runtime = createRuntime();
	try {
		runtime.config.previewLines = 5;
		const title = "**\u001b]0;PWN_TITLE\u0007Plan\u001b[31m**";
		const body = [
			"SAFE_TEXT",
			"\u001b]52;c;PWN_CLIPBOARD\u0007",
			"\u001b[31mSGR_RED\u001b[0m",
			"BELL\u0007C0",
			"NUL\u0000/DEL\u007f",
		].join("\n");
		const component = new AssistantMessageComponent(assistant(1008, [thinking(`${title}\n\n${body}`)]), true);
		const raw = component.render(24).join("\n");

		assert.match(raw, /Plan/);
		assert.match(raw, /SAFE_TEXT/);
		assert.match(raw, /SGR_RED/);
		assert.match(raw, /BELLC0/);
		assert.match(raw, /NUL\/DEL/);
		for (const line of component.render(24)) assert.ok(visibleWidth(line) <= 24, JSON.stringify(stripTerminalSequences(line)));
		assert.doesNotMatch(raw, /\u001b\[31m|\u001b\[0m|\u0007C0|\u0000|\u007f|\u0008|\u009b/);
		assert.doesNotMatch(raw, /PWN_TITLE|PWN_CLIPBOARD/);
	} finally {
		runtime.controller.dispose();
	}
});

test("bounds displayed titles to the render width while keeping the full body available", () => {
	const runtime = createRuntime();
	try {
		const longTitle = `LONG_TITLE_${"X".repeat(5000)}`;
		const message = assistant(1009, [thinking(`**${longTitle}**\n\nFULL_BODY_LINE`)], { api: "anthropic-messages" });
		runtime.update(message, { type: "thinking_start", contentIndex: 0 });
		const component = new AssistantMessageComponent(message, true);
		const width = 20;
		const output = component.render(width);
		for (const line of output) assert.ok(visibleWidth(line) <= width, JSON.stringify(stripTerminalSequences(line)));
		const titleLines = output.map((line) => stripTerminalSequences(line)).filter((line) => line.includes("X"));
		assert.ok(titleLines.length <= 2, `title occupied ${titleLines.length} lines`);
		assert.match(rendered(component, width), /FULL_BODY_LINE/);
	} finally {
		runtime.controller.dispose();
	}
});

test("persists plain timing data, restores the branch record, and never fabricates duration", async () => {
	const runtime = createRuntime();
	try {
		const message = assistant(2000, [thinking("**Plan**\n\nBODY")]);
		runtime.update(message, { type: "thinking_start", contentIndex: 0 });
		await delay(12);
		runtime.end(message);

		assert.equal(runtime.entries.length, 1);
		const firstEntry = runtime.entries[0];
		assert.ok(firstEntry);
		const { customType, data } = firstEntry;
		assert.deepEqual(Object.keys(data as object).sort(), ["contentIndex", "durationMs", "messageTimestamp"]);
		assert.equal((data as any).messageTimestamp, 2000);
		assert.equal((data as any).contentIndex, 0);
		assert.ok((data as any).durationMs >= 1);
		assert.ok(JSON.stringify(data).length < 160);

		runtime.controller.restore([customEntry(customType, data)]);
		const restored = rendered(new AssistantMessageComponent(message, true));
		assert.match(restored, /Plan/);
		assert.match(restored, /Plan · \d+(?:ms|s|m)/);

		const unrelated = assistant(2001, [thinking("NO_DURATION_BODY")]);
		const unrelatedOutput = rendered(new AssistantMessageComponent(unrelated, true));
		assert.match(unrelatedOutput, /NO_DURATION_BODY/);
		assert.doesNotMatch(unrelatedOutput, /Thought for| \d+(?:ms|s|m)\b/);
	} finally {
		runtime.controller.dispose();
	}
});

test("restore keeps only valid current-branch records and caps history at 2048", () => {
	const runtime = createRuntime();
	try {
		const message = assistant(3000, [thinking("BODY")]);
		runtime.update(message, { type: "thinking_start", contentIndex: 0 });
		runtime.end(message);
		const firstEntry = runtime.entries[0];
		assert.ok(firstEntry);
		const { customType } = firstEntry;
		const entries = Array.from({ length: 2050 }, (_, index) => customEntry(customType, {
			messageTimestamp: 10_000 + index,
			contentIndex: 0,
			durationMs: 5000,
		}, `entry-${index}`));
		entries.push(customEntry(customType, { messageTimestamp: 99_999, contentIndex: 0, durationMs: -1 }, "invalid"));
		runtime.controller.restore(entries);

		const oldest = rendered(new AssistantMessageComponent(assistant(10_000, [thinking("OLDEST")]), true));
		assert.doesNotMatch(oldest, /Thought for/);
		const newest = rendered(new AssistantMessageComponent(assistant(12_049, [thinking("NEWEST")]), true));
		assert.match(newest, /Thought for 5s/);
		const invalid = rendered(new AssistantMessageComponent(assistant(99_999, [thinking("INVALID")]), true));
		assert.doesNotMatch(invalid, /Thought for/);
		assert.ok(runtime.renders > 0);
	} finally {
		runtime.controller.dispose();
	}
});

test("animation refreshes only while live, follows config changes, and stops on finish or dispose", (t) => {
	const runtime = createRuntime();
	t.mock.timers.enable({ apis: ["setInterval"] });
	try {
		const message = assistant(4000, [thinking("**Live**\n\nBODY")]);
		runtime.update(message, { type: "thinking_start", contentIndex: 0 });
		const activeBaseline = runtime.renders;
		t.mock.timers.tick(30);
		assert.equal(runtime.renders - activeBaseline, 3);

		runtime.config.animationIntervalMs = 20;
		runtime.controller.refresh();
		const refreshedBaseline = runtime.renders;
		t.mock.timers.tick(60);
		assert.equal(runtime.renders - refreshedBaseline, 3);

		runtime.end(message);
		const finishedBaseline = runtime.renders;
		t.mock.timers.tick(100);
		assert.equal(runtime.renders, finishedBaseline);

		const next = assistant(4001, [thinking("NEXT")]);
		runtime.update(next, { type: "thinking_start", contentIndex: 0 });
		runtime.controller.dispose();
		const disposedBaseline = runtime.renders;
		t.mock.timers.tick(100);
		assert.equal(runtime.renders, disposedBaseline);
	} finally {
		t.mock.timers.reset();
		runtime.controller.dispose();
	}
});

test("restore discards active timing at a branch boundary and stops animation", (t) => {
	const runtime = createRuntime();
	t.mock.timers.enable({ apis: ["setInterval"] });
	try {
		const message = assistant(6000, [thinking("**Branch plan**\n\nBODY")]);
		runtime.update(message, { type: "thinking_start", contentIndex: 0 });
		const component = new AssistantMessageComponent(message, true);
		const beforeRestore = runtime.renders;
		runtime.controller.restore([]);
		const afterRestore = runtime.renders;
		assert.ok(afterRestore > beforeRestore);

		t.mock.timers.tick(100);
		assert.equal(runtime.renders, afterRestore);
		assert.equal(runtime.entries.length, 0);
		const output = rendered(component);
		assert.match(output, /Branch plan/);
		assert.doesNotMatch(output, / · \d+(?:ms|s|m)\b/);
	} finally {
		runtime.controller.dispose();
		t.mock.timers.reset();
	}
});

test("agent_settled finalizes an active duration and stops animation", (t) => {
	const runtime = createRuntime();
	t.mock.timers.enable({ apis: ["setInterval"] });
	try {
		const message = assistant(6001, [thinking("**Settled plan**\n\nBODY")]);
		runtime.update(message, { type: "thinking_start", contentIndex: 0 });
		assert.equal(runtime.entries.length, 0);
		runtime.emit("agent_settled", { type: "agent_settled", aborted: false });
		assert.equal(runtime.entries.length, 1);
		const entry = runtime.entries[0];
		assert.ok(entry);
		const data = entry.data as any;
		assert.equal(data.messageTimestamp, 6001);
		assert.equal(data.contentIndex, 0);
		assert.ok(data.durationMs >= 1);

		const baseline = runtime.renders;
		t.mock.timers.tick(100);
		assert.equal(runtime.renders, baseline);
		assert.match(rendered(new AssistantMessageComponent(message, true)), /Settled plan · \d+(?:ms|s|m)/);
	} finally {
		runtime.controller.dispose();
		t.mock.timers.reset();
	}
});

test("wraps narrow CJK and emoji content without exceeding the render width", () => {
	const runtime = createRuntime();
	try {
		const message = assistant(5000, [thinking(`**很长的标题🙂标题**\n\n${("中文🙂ABC".repeat(30))}`)]);
		const component = new AssistantMessageComponent(message, true);
		for (const width of [12, 17, 24]) {
			for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(stripTerminalSequences(line))}`);
			click(component);
			for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `expanded width ${width}: ${JSON.stringify(stripTerminalSequences(line))}`);
			component.setHideThinkingBlock(true);
		}
	} finally {
		runtime.controller.dispose();
	}
});

test("dispose unsubscribes once and restores only its own prototype patch", () => {
	const prototype = AssistantMessageComponent.prototype as any;
	const base = prototype.updateContent;
	const baseSetHide = prototype.setHideThinkingBlock;
	const runtime = createRuntime();
	try {
		assert.notEqual(prototype.updateContent, base);
		assert.notEqual(prototype.setHideThinkingBlock, baseSetHide);
		assert.ok(runtime.handlerCount() >= 3);
		runtime.controller.dispose();
		runtime.controller.dispose();
		assert.equal(runtime.handlerCount(), 0);
		assert.equal(prototype.updateContent, base);
		assert.equal(prototype.setHideThinkingBlock, baseSetHide);
	} finally {
		prototype.updateContent = base;
		prototype.setHideThinkingBlock = baseSetHide;
		runtime.controller.dispose();
	}
});

test("leaves a later extension patch in place when disposed", () => {
	const prototype = AssistantMessageComponent.prototype as any;
	const base = prototype.updateContent;
	const runtime = createRuntime();
	const ours = prototype.updateContent;
	const foreign = function (this: unknown, ...args: unknown[]) { return ours.apply(this, args); };
	try {
		prototype.updateContent = foreign;
		runtime.controller.dispose();
		assert.equal(prototype.updateContent, foreign);
	} finally {
		prototype.updateContent = base;
		runtime.controller.dispose();
	}
});
