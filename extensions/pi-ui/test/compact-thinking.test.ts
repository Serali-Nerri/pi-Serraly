// Adapted from pi-cc-extensions v0.8.69; see THIRD_PARTY_NOTICES.md.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import { UiScheduler } from "../src/scheduler.ts";
import {
	clearThinkingPreviewCache,
	installCompactThinking as createThinkingController,
	type CompactThinkingConfig,
	ThinkingPreviewBlock,
} from "../src/state/thinking-controller.ts";
import { animateCompactThinkingText } from "../src/compat/compact-mode.ts";
import { captureMethod } from "../src/compat/method-pipeline.ts";
import { COMPACT_THINKING_OWNER, patchRegistry } from "../src/compat/patch-keys.ts";

initTheme("dark");

const config = {
	useSummaryTitlesAsThinkingTitle: false,
	previewLines: 0,
	animationIntervalMs: 30,
};

test("collapsed thinking previews memoize complete output until invalidated", () => {
	const originalConfig = { ...config };
	const { pi } = runtime();
	const controller = installCompactThinking(pi, { ...originalConfig });
	controller.updateConfig({ ...originalConfig, previewLines: 1 });
	clearThinkingPreviewCache();
	try {
		const preview = new ThinkingPreviewBlock(
			"Thought",
			"alpha beta gamma delta epsilon zeta eta theta",
			0,
			1,
			(text) => text,
		);
		const first = preview.render(12);
		assert.ok(
			first.some((line) => line.includes("more")),
			"composed output includes its hint",
		);
		assert.strictEqual(preview.render(12), first, "same state reuses complete output");

		assert.notStrictEqual(preview.render(16), first, "width changes recompute output");
		const beforeConfigChange = preview.render(16);
		controller.updateConfig({ ...originalConfig, previewLines: 2 });
		assert.notStrictEqual(
			preview.render(16),
			beforeConfigChange,
			"preview-line changes recompute output",
		);

		const beforeHover = preview.render(16);
		preview.setHintHovered(true);
		assert.notStrictEqual(preview.render(16), beforeHover, "hover changes recompute output");

		const beforeInvalidation = preview.render(16);
		preview.invalidate();
		assert.notStrictEqual(preview.render(16), beforeInvalidation, "invalidation clears memo");
	} finally {
		controller.updateConfig(originalConfig);
		clearThinkingPreviewCache();
	}
});

test("compact summary reuses compact-thinking's sweep animation", () => {
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		italic: (text: string) => `<i>${text}</i>`,
		bold: (text: string) => `<b>${text}</b>`,
	} as any;
	const first = animateCompactThinkingText("Thinking...", theme, 0);
	const second = animateCompactThinkingText("Thinking...", theme, 1);
	assert.notEqual(first, second);
	assert.equal(first.replace(/<[^>]+>/g, ""), "Thinking...");
	assert.equal(second.replace(/<[^>]+>/g, ""), "Thinking...");
});

/** Test-only lifecycle: the controller receives a LOCAL router and scheduler. */
function installCompactThinking(pi: any, initialConfig: CompactThinkingConfig) {
	return createThinkingController(pi, initialConfig, pi.services);
}

function runtime() {
	const handlers = new Map<string, Function[]>();
	const scheduler = new UiScheduler();
	const pi = {
		on() { throw new Error("controller must not subscribe to Pi"); },
		appendEntry(_type?: string, _data?: unknown) {},
		tui: undefined as any,
		services: {
			scheduler,
			getTui: () => pi.tui,
			events: {
				on(name: string, handler: Function) {
					const list = handlers.get(name) ?? [];
					list.push(handler);
					handlers.set(name, list);
					return () => handlers.set(name, (handlers.get(name) ?? []).filter((candidate) => candidate !== handler));
				},
			},
		},
	};
	return {
		handlers, pi, scheduler,
		emit(name: string, event: any = {}, ctx: any = {}) {
			if (name === "session_start" && ctx.mode === "tui") scheduler.start(() => pi.tui?.requestRender());
			for (const handler of handlers.get(name) ?? []) handler(event, ctx);
			if (name === "session_shutdown") scheduler.dispose();
		},
	};
}

const tuiCtx = {
	mode: "tui",
	hasUI: true,
	sessionManager: { getBranch: () => [], getEntries: () => [] },
	ui: { theme: {}, setWidget() { throw new Error("no independent widget bridge"); }, requestRender() {} },
};

const headlessCtx = {
	mode: "print",
	hasUI: false,
	sessionManager: { getBranch: () => [], getEntries: () => [] },
	ui: { theme: {}, setWidget() { throw new Error("no independent widget bridge"); }, requestRender() {} },
};

test("compact thinking patches the runtime component with ccstyle config", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const { emit, pi } = runtime();
	process.env.PI_CODING_AGENT_DIR = dir;
	const original = AssistantMessageComponent.prototype.updateContent;
	try {
		installCompactThinking(pi, config);
		// Lazy: prototype stays original until a TUI session starts.
		assert.equal(AssistantMessageComponent.prototype.updateContent, original);
		emit("session_start", {}, tuiCtx);
		assert.notEqual(AssistantMessageComponent.prototype.updateContent, original);
		assert.equal(
			existsSync(join(dir, "compact-thinking.json")),
			false,
			"activate must not leave compact-thinking.json behind",
		);
	} finally {
		emit("session_shutdown", {}, tuiCtx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("reload keeps the replacement compact-thinking prototype patch", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-reload-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const original = AssistantMessageComponent.prototype.updateContent;
	const first = runtime();
	const second = runtime();
	try {
		installCompactThinking(first.pi, config);
		first.emit("session_start", {}, tuiCtx);
		const firstPatch = AssistantMessageComponent.prototype.updateContent;

		installCompactThinking(second.pi, config);
		second.emit("session_start", {}, tuiCtx);
		const replacementPatch = AssistantMessageComponent.prototype.updateContent;
		assert.notEqual(replacementPatch, firstPatch);
		first.emit("session_shutdown", {}, tuiCtx);
		assert.equal(AssistantMessageComponent.prototype.updateContent, replacementPatch);

		second.emit("session_shutdown", {}, tuiCtx);
		assert.equal(AssistantMessageComponent.prototype.updateContent, original);
	} finally {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("headless subagent runtime does not steal the parent thinking patch", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-isolate-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const original = AssistantMessageComponent.prototype.updateContent;
	const parent = runtime();
	const nested = runtime();
	try {
		installCompactThinking(parent.pi, config);
		parent.emit("session_start", {}, tuiCtx);
		const parentPatch = AssistantMessageComponent.prototype.updateContent;
		assert.notEqual(parentPatch, original);

		installCompactThinking(nested.pi, config);
		nested.emit("session_start", {}, headlessCtx);
		assert.equal(
			AssistantMessageComponent.prototype.updateContent,
			parentPatch,
			"headless install must not replace the parent prototype patch",
		);

		nested.emit("session_shutdown", {}, headlessCtx);
		assert.equal(
			AssistantMessageComponent.prototype.updateContent,
			parentPatch,
			"headless shutdown must not tear down the parent patch",
		);
	} finally {
		parent.emit("session_shutdown", {}, tuiCtx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

const renderText = (component: any, width = 120): string[] =>
	component
		.render(width)
		.map((line: string) =>
			line
				.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
				.replace(/\x1b\][^\x07]*\x07/g, "")
				.trim(),
		)
		.filter((line: string) => line);

function thinkingMessage(timestamp: number, withAgent = true) {
	return {
		role: "assistant",
		timestamp,
		content: [
			{
				type: "thinking",
				thinking: "plan",
				thinkingSignature: { kind: "agent_summary", title: "Plan", body: "..." },
			},
			...(withAgent ? [{ type: "toolCall", name: "Agent", arguments: {} }] : []),
		],
	} as unknown as AssistantMessage;
}

function themeCtx(sessionManager: any = { getBranch: () => [], getEntries: () => [] }) {
	return {
		mode: "tui",
		hasUI: true,
		sessionManager,
		ui: {
			theme: { fg: (_c: string, t: string) => t, italic: (t: string) => t, bold: (t: string) => t },
			setWidget() {},
			requestRender() {},
		},
	};
}

/** External host seam: streaming updates are built only when the component paints. */
function deferredAssistantHost(): () => void {
	const prototype = AssistantMessageComponent.prototype as any;
	const descriptors = Object.getOwnPropertyDescriptors(prototype);
	const update = prototype.updateContent;
	const render = prototype.render;
	const pending = new WeakSet<object>();
	Object.defineProperties(prototype, {
		buildContent: { configurable: true, writable: true, value(this: any, message: AssistantMessage) {
			pending.delete(this);
			update.call(this, message, this.isStreaming);
		} },
		updateContent: { configurable: true, writable: true, value(this: any, message: AssistantMessage, streaming = this.isStreaming) {
			this.lastMessage = message;
			this.isStreaming = streaming;
			if (streaming) pending.add(this);
			else this.buildContent(message);
		} },
		render: { configurable: true, writable: true, value(this: any, width: number) {
			if (pending.has(this) && this.lastMessage) this.buildContent(this.lastMessage);
			return render.call(this, width);
		} },
	});
	return () => {
		for (const name of ["buildContent", "updateContent", "render"]) {
			if (descriptors[name]) Object.defineProperty(prototype, name, descriptors[name]);
			else delete prototype[name];
		}
	};
}

test("deferred host paints animated thinking and elapsed time without new deltas, then retains the final duration", (t) => {
	const restore = deferredAssistantHost();
	const host = runtime();
	const ctx = themeCtx();
	ctx.ui.theme = {
		fg: (color: string, text: string) => `\x1b[${color === "text" ? 97 : 90}m${text}\x1b[39m`,
		italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	};
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
	const controller = installCompactThinking(host.pi, { ...config, previewLines: 1, animationIntervalMs: 90 });
	try {
		host.emit("session_start", {}, ctx);
		const message = { ...thinkingMessage(10_000, false), content: [{ type: "thinking", thinking: "" }] } as AssistantMessage;
		const component = new AssistantMessageComponent(undefined, true);
		component.updateContent(message, true);
		host.emit("message_update", { message, assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }, ctx);
		assert.match(renderText(component).join("\n"), /Thinking\.\.\. · 1ms/);
		const label = () => component.render(100).join("\n").split(" · ")[0];
		const first = label();
		t.mock.timers.tick(90);
		assert.notEqual(label(), first, "the painted label's styling moves even with no provider delta");
		assert.match(renderText(component).join("\n"), /Thinking\.\.\. · 90ms/);
		t.mock.timers.tick(2_000);
		assert.match(renderText(component).join("\n"), /Thinking\.\.\. · 2s/);

		const superseded = { ...message, content: [{ type: "thinking", thinking: "Superseded reasoning" }] } as AssistantMessage;
		const latest = { ...message, content: [{ type: "thinking", thinking: "Latest retained reasoning" }] } as AssistantMessage;
		component.updateContent(superseded, true);
		component.updateContent(latest, true);
		assert.match(renderText(component).join("\n"), /Latest retained reasoning/);
		assert.doesNotMatch(renderText(component).join("\n"), /Superseded reasoning/);
		host.emit("message_end", { message: latest }, ctx);
		assert.match(renderText(component).join("\n"), /Thought for 2s/);
		assert.doesNotMatch(renderText(component).join("\n"), /Thinking\.\.\./);
		assert.deepEqual(message.content, [{ type: "thinking", thinking: "" }], "the empty-run placeholder never alters the message");
		assert.deepEqual(latest.content, [{ type: "thinking", thinking: "Latest retained reasoning" }]);
	} finally {
		controller.dispose();
		host.scheduler.dispose();
		restore();
		t.mock.timers.reset();
	}
});

test("deferred thinking survives owner replacement and releases only its own builder patch", (t) => {
	const restore = deferredAssistantHost();
	const prototype = AssistantMessageComponent.prototype as any;
	const nativeBuild = prototype.buildContent;
	const first = runtime(), second = runtime();
	const ctx = themeCtx();
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
	const oldController = installCompactThinking(first.pi, { ...config, animationIntervalMs: 90 });
	let newController: ReturnType<typeof installCompactThinking> | undefined;
	try {
		first.emit("session_start", {}, ctx);
		newController = installCompactThinking(second.pi, { ...config, animationIntervalMs: 90 });
		second.emit("session_start", {}, ctx);
		first.emit("session_shutdown", {}, ctx);
		const message = thinkingMessage(10_000, false);
		const component = new AssistantMessageComponent(undefined, true);
		component.updateContent(message, true);
		second.emit("message_update", { message, assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }, ctx);
		assert.match(renderText(component).join("\n"), /Thinking\.\.\. · 1ms/);
		t.mock.timers.tick(90);
		assert.match(renderText(component).join("\n"), /Thinking\.\.\. · 90ms/,
			"the stale owner's shutdown cannot stop its replacement");
		second.emit("session_shutdown", {}, ctx);
		assert.equal(prototype.buildContent, nativeBuild, "shutdown restores the selected host builder");
		assert.equal(second.scheduler.pendingJobs, 0, "shutdown releases animation work");

		// Another extension may replace the builder after us. Cleanup must neither
		// invoke that foreign method nor overwrite it to restore our captured one.
		second.emit("session_start", {}, ctx);
		const foreignBuild = () => { throw new Error("shutdown re-entered a foreign content builder"); };
		prototype.buildContent = foreignBuild;
		second.emit("session_shutdown", {}, ctx);
		assert.equal(prototype.buildContent, foreignBuild);
		assert.equal(second.scheduler.pendingJobs, 0);
	} finally {
		newController?.dispose();
		oldController.dispose();
		first.scheduler.dispose();
		second.scheduler.dispose();
		restore();
		t.mock.timers.reset();
	}
});

test("session tree restores durations from all entries so old messages keep Thought for", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-restore-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const { emit, pi } = runtime();
	let durationEntry: any = {
		type: "custom",
		customType: "claude-style-tools-thinking-duration",
		data: { messageTimestamp: 0, contentIndex: 0, durationMs: 1234 },
	};
	const sessionManager = {
		// getBranch mirrors the leaf path after compaction: it no longer contains
		// the finished message's duration entry. getEntries still has it.
		getBranch: () => [] as any[],
		getEntries: () => [durationEntry],
	};
	const uiCtx = themeCtx(sessionManager);
	try {
		installCompactThinking(pi, config);
		emit("session_start", {}, uiCtx);

		const oldTs = Date.now() - 60_000;
		durationEntry.data.messageTimestamp = oldTs;
		const msg = thinkingMessage(oldTs, false);
		emit("message_update", {
			message: msg,
			assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
		});
		emit("message_update", {
			message: msg,
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 },
		});
		await new Promise((resolve) => setTimeout(resolve, 60));
		emit("message_update", {
			message: msg,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 },
		});

		// Navigate to another branch that no longer includes this message. Ordinary
		// compaction keeps historical entries in getBranch(); getEntries() also
		// covers older messages still mounted from an abandoned branch.
		emit("session_tree", {}, uiCtx);

		// scrolling back re-renders the old message in a fresh component
		const old = new AssistantMessageComponent(msg, true);
		old.updateContent(msg);
		const lines = renderText(old);
		assert.ok(
			lines.some((line) => line.startsWith("Thought for")),
			`old message keeps its duration after branch navigation, got: ${lines[0]}`,
		);
		assert.ok(!lines.some((line) => line.includes("Thinking...")), "no bare Thinking... fallback");
	} finally {
		emit("session_shutdown", {}, uiCtx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("compact summary keeps the shared animation alive until the next assistant message", async () => {
	const { emit, pi } = runtime();
	const uiCtx = themeCtx();
	const controller = installCompactThinking(pi, config);
	try {
		emit("session_start", {}, uiCtx);
		const message = {
			...thinkingMessage(Date.now(), false),
			content: [
				{ type: "thinking", thinking: "plan" },
				{ type: "toolCall", name: "bash", args: {} },
			],
		};
		emit("message_update", {
			message,
			assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
		});
		controller.setCompactSummaryActive?.(true);
		emit("message_update", {
			message,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 },
		});
		assert.equal(controller.isMessageThinkingActive?.(message.timestamp), false);
		const runningFrame = controller.getThinkingAnimationFrame?.() ?? 0;
		await new Promise((resolve) => setTimeout(resolve, 70));
		assert.ok((controller.getThinkingAnimationFrame?.() ?? 0) > runningFrame);

		controller.setCompactSummaryActive?.(false);
		const stoppedFrame = controller.getThinkingAnimationFrame?.() ?? 0;
		await new Promise((resolve) => setTimeout(resolve, 70));
		assert.equal(controller.getThinkingAnimationFrame?.(), stoppedFrame);
	} finally {
		emit("session_shutdown", {}, uiCtx);
	}
});

test("Agent tool call finishes parent thinking before the subagent runs", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-agent-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const { emit, pi } = runtime();
	const uiCtx = themeCtx();
	try {
		const controller = installCompactThinking(pi, config);
		emit("session_start", {}, uiCtx);

		const ts = Date.now();
		const msg = thinkingMessage(ts, true); // thinking + Agent toolCall
		emit("message_update", {
			message: msg,
			assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
		});
		emit("message_update", {
			message: msg,
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 },
		});
		const live = new AssistantMessageComponent(msg, true);
		live.updateContent(msg);
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.equal(controller.isMessageThinkingActive?.(ts), true);
		assert.ok((controller.getThinkingAnimationFrame?.() ?? 0) > 0);
		assert.ok((controller.getMessageThinkingDurationMs?.(ts) ?? 0) > 0);

		// The parent's thinking ends as soon as the Agent tool call begins.
		emit("message_update", {
			message: msg,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 },
		});
		assert.equal(controller.isMessageThinkingActive?.(ts), false);
		const duration = controller.getMessageThinkingDurationMs?.(ts);
		const frame = controller.getThinkingAnimationFrame?.();
		assert.ok(duration && duration > 0);
		assert.ok(
			renderText(live).some((line) => line.startsWith("Thought for")),
			"the mounted message updates immediately, without waiting for tool completion",
		);

		// Later deltas and real agent-loop boundaries must not restart the ticker.
		emit("message_update", {
			message: msg,
			assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1 },
		});
		emit("message_end", { message: msg }, uiCtx);
		emit("tool_execution_start", { toolName: "Agent", toolCallId: "c1", args: {} }, uiCtx);
		const nested = runtime();
		installCompactThinking(nested.pi, config);
		nested.emit("session_start", {}, headlessCtx);

		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.equal(controller.isMessageThinkingActive?.(ts), false);
		assert.equal(controller.getMessageThinkingDurationMs?.(ts), duration);
		assert.equal(controller.getThinkingAnimationFrame?.(), frame);
		const midAgent = new AssistantMessageComponent(msg, true);
		midAgent.updateContent(msg);
		assert.ok(
			renderText(midAgent).some((line) => line.startsWith("Thought for")),
			"new renders during Agent execution show completed thinking",
		);

		emit(
			"tool_execution_end",
			{ toolName: "Agent", toolCallId: "c1", result: {}, isError: false },
			uiCtx,
		);
		assert.equal(controller.getMessageThinkingDurationMs?.(ts), duration);
		nested.emit("session_shutdown", {}, headlessCtx);
	} finally {
		emit("session_shutdown", {}, uiCtx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("message end and tool execution start also finish Agent thinking without a toolcall update", () => {
	const { emit, pi } = runtime();
	const uiCtx = themeCtx();
	const controller = installCompactThinking(pi, config);
	try {
		emit("session_start", {}, uiCtx);
		for (const [index, boundary] of ["message_end", "tool_execution_start"].entries()) {
			const msg = thinkingMessage(Date.now() + index, true);
			emit("message_update", {
				message: msg,
				assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
			});
			assert.equal(controller.isMessageThinkingActive?.(msg.timestamp), true);
			if (boundary === "message_end") emit(boundary, { message: msg }, uiCtx);
			else emit(boundary, { toolName: "Agents", toolCallId: "c2", args: {} }, uiCtx);
			assert.equal(controller.isMessageThinkingActive?.(msg.timestamp), false, boundary);
			assert.ok((controller.getMessageThinkingDurationMs?.(msg.timestamp) ?? 0) > 0);
		}
	} finally {
		emit("session_shutdown", {}, uiCtx);
	}
});

test("reload/resume rebuild: mounted-tree scan re-renders rebuilt components", async () => {
	initTheme("dark");
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-rescan-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const { Container } = await import("@earendil-works/pi-tui");
	const parent = new Container() as any;
	const tui = {
		mode: "regular",
		getMountedRoots: () => [parent],
		requestRender() {},
	};
	const entries: any[] = [];
	const sessionManager = { getBranch: () => entries, getEntries: () => entries };
	const ctx = {
		mode: "tui",
		hasUI: true,
		sessionManager,
		ui: {
			theme: { fg: (_c: string, t: string) => t, italic: (t: string) => t },
			setWidget(_key: string, factory: any) {
				if (typeof factory === "function") factory(tui);
			},
			requestRender() {},
		},
	} as any;
	const first = runtime();
	first.pi.tui = tui;
	first.pi.appendEntry = (_type: string, data: unknown) =>
		entries.push({ type: "custom", customType: "claude-style-tools-thinking-duration", data });
	try {
		installCompactThinking(first.pi, config);
		first.emit("session_start", {}, ctx);

		// live run: thinking then toolcall records the duration entry
		const ts = Date.now();
		const msg = thinkingMessage(ts, false);
		first.emit(
			"message_update",
			{ message: msg, assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
			ctx,
		);
		await new Promise((resolve) => setTimeout(resolve, 30));
		first.emit(
			"message_update",
			{ message: msg, assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 } },
			ctx,
		);

		first.emit("session_shutdown", { reason: "reload" }, ctx);

		// pi rebuildChatFromMessages: fresh components with the restored ORIGINAL prototype
		parent.clear();
		const rebuilt = new AssistantMessageComponent(msg, true) as any;
		parent.addChild(rebuilt);
		assert.ok(
			renderText(rebuilt).some((line) => line.startsWith("Thinking...")),
			"native rebuild shows the bare Thinking... label",
		);

		// new extension instance: session_start scans the mounted tree and re-renders
		const second = runtime();
		second.pi.tui = tui;
		installCompactThinking(second.pi, config);
		second.emit("session_start", { reason: "reload" }, ctx);
		const lines = renderText(rebuilt);
		assert.ok(
			lines.some((line) => line.startsWith("Thought for")),
			`rebuilt component recovers its duration, got: ${JSON.stringify(lines)}`,
		);
		assert.ok(
			!lines.some((line) => line.includes("Thinking...")),
			`no bare Thinking... fallback after reload, got: ${JSON.stringify(lines)}`,
		);

		second.emit("session_shutdown", {}, ctx);
	} finally {
		first.emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("completed run without duration never falls back to the loading label", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-fallback-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const { emit, pi } = runtime();
	const ctx = {
		mode: "tui",
		hasUI: true,
		sessionManager: { getBranch: () => [], getEntries: () => [] },
		ui: {
			theme: { fg: (_c: string, t: string) => t, italic: (t: string) => t },
			setWidget(_key: string, factory: any) {
				if (typeof factory === "function") factory({ requestRender() {} });
			},
			requestRender() {},
		},
	} as any;
	try {
		installCompactThinking(pi, { ...config, useSummaryTitlesAsThinkingTitle: true });
		emit("session_start", {}, ctx);
		// completed run with no duration entry: summary title preferred, then "Thought"
		const withSummary = {
			...thinkingMessage(Date.now(), false),
			api: "openai-responses",
			content: [
				{
					type: "thinking",
					thinking: "**Fallback**\n\nUnstructured reasoning",
					thinkingSignature: JSON.stringify({
						type: "reasoning",
						summary: [{ type: "summary_text", text: "**Plan**\n\nFirst do A" }],
					}),
				},
				{ type: "toolCall", name: "bash", args: {}, id: "c1" },
			],
		} as any;
		const component = new AssistantMessageComponent(withSummary, true) as any;
		component.updateContent(withSummary);
		const withSummaryLines = renderText(component);
		assert.ok(
			withSummaryLines.some((line) => line.includes("Plan")),
			`summary title shown for completed run, got: ${JSON.stringify(withSummaryLines)}`,
		);
		assert.ok(!withSummaryLines.some((line) => line.includes("Fallback")), "structured signature takes precedence over fallback text");
		assert.ok(
			!withSummaryLines.some((line) => line.includes("Thinking...")),
			"no loading label for a completed run",
		);

		const plain = thinkingMessage(Date.now(), false);
		const plainComponent = new AssistantMessageComponent(plain, true) as any;
		plainComponent.updateContent(plain);
		const plainLines = renderText(plainComponent);
		assert.ok(
			plainLines.some((line) => line.includes("Thought")),
			`neutral fallback for run without title or duration, got: ${JSON.stringify(plainLines)}`,
		);
		assert.ok(
			!plainLines.some((line) => line.includes("Thinking...")),
			"no loading label fallback",
		);
	} finally {
		emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

function previewMessage(thinking: string) {
	return {
		role: "assistant",
		timestamp: Date.now(),
		content: [{ type: "thinking", thinking }],
	} as unknown as AssistantMessage;
}

test("thinking preview counts wrapped hidden lines and does not restyle from cache", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-preview-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const { emit, pi } = runtime();
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		italic: (text: string) => text,
		bold: (text: string) => text,
	};
	const ctx = {
		mode: "tui",
		hasUI: true,
		sessionManager: { getBranch: () => [], getEntries: () => [] },
		ui: {
			theme,
			setWidget() {},
			requestRender() {},
		},
	} as any;
	const width = 80;
	const previewLines = 3;
	const body = "x".repeat(4000);
	try {
		installCompactThinking(pi, {
			useSummaryTitlesAsThinkingTitle: false,
			previewLines,
			animationIntervalMs: 30,
		});
		emit("session_start", {}, ctx);

		const msg = previewMessage(body);
		const first = new AssistantMessageComponent(msg, true) as any;
		first.updateContent(msg);
		const firstLines = first.render(width) as string[];
		const firstPlain = firstLines.map((line: string) => line.trim()).filter(Boolean);
		const hint = firstPlain.find((line: string) => /Thought/.test(line) && /more lines/.test(line));
		assert.ok(hint, `expected hidden-line hint after Thought, got: ${JSON.stringify(firstPlain)}`);
		assert.match(hint, /<dim> • \(\d+ more lines/);
		const bodyToken = "thinkingText";
		assert.ok(
			!firstPlain.some(
				(line: string) => new RegExp(`^<${bodyToken}>x+`).test(line) && /more line/.test(line),
			),
			"preview body must not carry the more-line hint",
		);
		const hidden = Number(/\((\d+) more lines/.exec(hint)?.[1]);
		// Raw newline count of the discarded prefix is 0; wrapped count is ~width-based.
		assert.ok(
			hidden > 20,
			`hidden lines should follow wrap width, not raw newlines, got ${hidden}`,
		);
		assert.ok(
			firstPlain.filter((line: string) => new RegExp(`^<${bodyToken}>x+`).test(line)).length <=
				previewLines,
			"preview body stays capped at previewLines",
		);
		assert.ok(
			firstPlain.every((line: string) => !/^x{80,}/.test(line)),
			"full unwrapped paragraph must not leak into the preview",
		);

		theme.fg = (color: string, text: string) => `[${color}]${text}[/${color}]`;
		const second = new AssistantMessageComponent(msg, true) as any;
		second.updateContent(msg);
		const secondPlain = (second.render(width) as string[])
			.map((line: string) => line.trim())
			.filter(Boolean);
		assert.ok(
			secondPlain.some((line: string) => line.includes(`[${bodyToken}]`)),
			"theme change must restyle preview body, not reuse cached ANSI",
		);
		assert.ok(
			secondPlain.some((line: string) => /\[dim\] • \(\d+ more lines/.test(line)),
			"more-line hint uses the dim token after theme change",
		);
		assert.ok(
			secondPlain.every(
				(line: string) => !line.includes("<thinkingText>") && !line.includes("<dim>"),
			),
			"cached wrap must not keep the previous theme's markup",
		);
	} finally {
		emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("previewLines 0 still offers click to show more and expands the body", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-preview-zero-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const { emit, pi } = runtime();
	const ctx = themeCtx();
	const body = Array.from({ length: 8 }, (_, i) => `line-${i}`).join("\n");
	try {
		installCompactThinking(pi, {
			useSummaryTitlesAsThinkingTitle: false,
			previewLines: 0,
			animationIntervalMs: 30,
		});
		emit("session_start", {}, ctx);
		const msg = previewMessage(body);
		const component = new AssistantMessageComponent(msg, true) as any;
		component.updateContent(msg);
		const collapsed = renderText(component);
		assert.ok(
			collapsed.some((line) => /Thought.*click to show more/.test(line)),
			`expected click hint with no preview body, got: ${JSON.stringify(collapsed)}`,
		);
		assert.ok(
			!collapsed.some((line) => /^line-\d+$/.test(line)),
			"previewLines 0 hides the thinking body",
		);

		thinkingBlockOf(component).setExpanded(true);
		const expanded = renderText(component);
		assert.ok(!expanded.some((line) => line.includes("click to show more")));
		assert.ok(expanded.some((line) => line.includes("line-0")));
		assert.ok(expanded.some((line) => line.includes("line-7")));
	} finally {
		emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

function thinkingBlockOf(component: any): ThinkingPreviewBlock {
	const block = component.contentContainer?.children?.find(
		(child: unknown) => child instanceof ThinkingPreviewBlock,
	);
	assert.ok(block instanceof ThinkingPreviewBlock, "assistant mounts a thinking preview block");
	return block;
}

test("thinking preview expands the full body and keeps that state across updateContent", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-preview-expand-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const { emit, pi } = runtime();
	const ctx = themeCtx();
	(ctx.ui.theme as any).bg = (_slot: string, text: string) => `<bg>${text}</bg>`;
	const previewLines = 3;
	const body = Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n");
	try {
		installCompactThinking(pi, {
			useSummaryTitlesAsThinkingTitle: false,
			previewLines,
			animationIntervalMs: 30,
		});
		emit("session_start", {}, ctx);
		const msg = previewMessage(body);
		const component = new AssistantMessageComponent(msg, true) as any;
		component.updateContent(msg);
		const collapsed = renderText(component);
		assert.ok(collapsed.some((line) => /more lines.*click to show more/.test(line)));
		assert.ok(
			collapsed.every((line) => !line.includes("<bg>")),
			"collapsed preview is not wrapped in a card",
		);
		assert.equal(
			collapsed.filter((line) => /^line-\d+$/.test(line)).length,
			previewLines,
			"collapsed body stays capped",
		);

		const block = thinkingBlockOf(component);
		block.setExpanded(true);
		const rawExpanded = component.render(120) as string[];
		assert.ok(
			rawExpanded.some((line) => line.includes("<bg>")),
			"expanded thinking is wrapped in the userMessageBg card",
		);
		const expanded = renderText(component);
		assert.ok(!expanded.some((line) => line.includes("more line")));
		assert.ok(expanded.some((line) => line.includes("line-0")));
		assert.ok(expanded.some((line) => line.includes("line-19")));
		assert.ok(
			expanded.filter((line) => /line-\d+/.test(line)).length > previewLines,
			"expanded body shows more than the preview window",
		);

		component.updateContent(msg);
		assert.equal(thinkingBlockOf(component).expanded, true);
		assert.ok(renderText(component).some((line) => line.includes("line-0")));

		thinkingBlockOf(component).setExpanded(false);
		const recollapsed = renderText(component);
		assert.ok(recollapsed.some((line) => /more lines.*click to show more/.test(line)));
		assert.equal(recollapsed.filter((line) => /^line-\d+$/.test(line)).length, previewLines);
	} finally {
		emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("factory, headless events and dispose never create a thinking timer or widget bridge", () => {
	const host = runtime();
	const original = AssistantMessageComponent.prototype.updateContent;
	const controller = installCompactThinking(host.pi, config);
	assert.equal(host.scheduler.pendingJobs, 0);
	assert.equal(AssistantMessageComponent.prototype.updateContent, original);
	host.emit("session_start", {}, headlessCtx);
	host.emit("message_update", { message: thinkingMessage(100, false), assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }, headlessCtx);
	controller.setCompactSummaryActive(true);
	assert.equal(host.scheduler.pendingJobs, 0);
	assert.equal(controller.isMessageThinkingActive(100), false);
	controller.dispose();
	controller.dispose();
	assert.ok([...host.handlers.values()].every((handlers) => handlers.length === 0));
	host.emit("session_start", {}, tuiCtx);
	assert.equal(AssistantMessageComponent.prototype.updateContent, original);
});

test("duration index restores all branches at start, tree and compaction", () => {
	const host = runtime();
	const entries = [
		{ type: "custom", customType: "claude-style-tools-thinking-duration", data: { messageTimestamp: 10, contentIndex: 0, durationMs: 1_200 } },
		{ type: "custom", customType: "claude-style-tools-thinking-duration", data: { messageTimestamp: 10, contentIndex: 2, durationMs: 300 } },
		{ type: "custom", customType: "claude-style-tools-thinking-duration", data: { messageTimestamp: 20, contentIndex: 0, durationMs: 800 } },
		{ type: "custom", customType: "other-extension", data: { messageTimestamp: 20, contentIndex: 0, durationMs: 99_999 } },
		{ type: "custom", customType: "claude-style-tools-thinking-duration", data: { messageTimestamp: 20, contentIndex: 1, durationMs: -100 } },
	];
	const ctx = themeCtx({ getEntries: () => entries, getBranch() { throw new Error("display durations must not query branch"); } });
	const controller = installCompactThinking(host.pi, config);
	try {
		host.emit("session_start", {}, ctx);
		for (const boundary of ["session_start", "session_tree", "session_compact"]) {
			if (boundary !== "session_start") host.emit(boundary, {}, ctx);
			assert.equal(controller.getMessageThinkingDurationMs(10), 1_500);
			assert.equal(controller.getMessageThinkingDurationMs(20), 800);
		}
	} finally { controller.dispose(); host.scheduler.dispose(); }
});

test("empty reasoning animates immediately and a contiguous Responses run retains its start", async () => {
	const host = runtime();
	const controller = installCompactThinking(host.pi, { ...config, useSummaryTitlesAsThinkingTitle: true });
	const ctx = themeCtx();
	const persisted: any[] = [];
	host.pi.appendEntry = (customType, data) => { persisted.push({ customType, data }); };
	try {
		host.emit("session_start", {}, ctx);
		const message = { ...thinkingMessage(400, false), api: "openai-responses", content: [{ type: "thinking", thinking: "" }] } as AssistantMessage;
		const component = new AssistantMessageComponent(message, true);
		host.emit("message_update", { message, assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }, ctx);
		assert.match(renderText(component).join("\n"), /Thinking\.\.\./);
		const initialHeight = component.render(100).length;
		await new Promise((resolve) => setTimeout(resolve, 45));
		assert.ok(controller.getThinkingAnimationFrame() > 0);
		assert.equal(host.scheduler.pendingJobs, 1);
		const continued = { ...message, content: [
			{ type: "thinking", thinking: "**First**\nFirst body" },
			{ type: "thinking", thinking: "**Newest**\nNewest body", thinkingSignature: JSON.stringify({ type: "reasoning", summary: [{ type: "summary_text", text: "**Old title**\nOld body" }] }) },
		] } as AssistantMessage;
		host.emit("message_update", { message, assistantMessageEvent: { type: "thinking_end", contentIndex: 0 } }, ctx);
		assert.equal(controller.isMessageThinkingActive(400), true);
		const before = controller.getMessageThinkingDurationMs(400)!;
		host.emit("message_update", { message: continued, assistantMessageEvent: { type: "thinking_start", contentIndex: 1 } }, ctx);
		assert.ok(controller.getMessageThinkingDurationMs(400)! >= before);
		component.updateContent(continued, true);
		const lines = renderText(component).join("\n");
		assert.match(lines, /Newest/);
		assert.doesNotMatch(lines, /Old title/);
		assert.equal(component.render(100).length, initialHeight, "zero preview lines preserve leading spacer and heading height");
		host.emit("message_update", { message: continued, assistantMessageEvent: { type: "text_start", contentIndex: 2 } }, ctx);
		assert.equal(host.scheduler.pendingJobs, 0);
		assert.equal(persisted.length, 1);
		assert.equal(persisted[0].customType, "claude-style-tools-thinking-duration");
		assert.deepEqual(Object.keys(persisted[0].data).sort(), ["contentIndex", "durationMs", "messageTimestamp"]);
		assert.equal(persisted[0].data.contentIndex, 1);
		assert.ok(persisted[0].data.durationMs >= before);
	} finally { controller.dispose(); host.scheduler.dispose(); }
});

test("shutdown finalizes mounted thinking without repainting a throwing foreign wrapper", () => {
	const host = runtime();
	const next = runtime();
	const ctx = themeCtx();
	const prototype = AssistantMessageComponent.prototype;
	const original = prototype.updateContent;
	const message = thinkingMessage(700, false);
	const nativeHidden = new AssistantMessageComponent(message, true).render(100);
	const nativeVisible = new AssistantMessageComponent(message, false).render(100);
	const persisted: any[] = [];
	host.pi.appendEntry = (customType, data) => { persisted.push({ customType, data }); };
	const controller = installCompactThinking(host.pi, config);
	const replacement = installCompactThinking(next.pi, config);
	let foreignCalls = 0;
	let renderRequests = 0;
	try {
		host.emit("session_start", {}, ctx);
		const capturedPipeline = prototype.updateContent;
		const capturedStep = captureMethod(prototype, "updateContent") as typeof original;
		const owner = patchRegistry.get<{ stop(): void }>(COMPACT_THINKING_OWNER)!;
		const shutdown = host.handlers.get("session_shutdown")![0];
		const mounted = new AssistantMessageComponent(message, true);
		host.pi.tui = { getMountedRoots: () => [mounted], requestRender() { renderRequests++; } };
		host.emit("message_update", { message, assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }, ctx);
		assert.equal(controller.isMessageThinkingActive(message.timestamp), true);
		thinkingBlockOf(mounted);
		assert.equal(host.scheduler.pendingJobs, 1);

		let throwOnUpdate = true;
		const foreign: typeof original = function (this: InstanceType<typeof AssistantMessageComponent>, ...args) {
			foreignCalls++;
			if (throwOnUpdate) throw new Error("foreign final repaint failed");
			return capturedPipeline.apply(this, args);
		};
		prototype.updateContent = foreign;
		const requestsBeforeShutdown = renderRequests;
		// Invoke the routed handler directly: lifecycle scheduler disposal must
		// not hide a failure to cancel the controller's own animation job.
		assert.doesNotThrow(() => shutdown({}, ctx));
		assert.equal(foreignCalls, 0, "shutdown never calls the throwing final repaint");
		assert.equal(renderRequests, requestsBeforeShutdown, "shutdown never requests a repaint");
		assert.equal(prototype.updateContent, foreign, "foreign prototype ownership survives");
		assert.equal(patchRegistry.get(COMPACT_THINKING_OWNER), undefined);
		assert.equal(Object.hasOwn(globalThis, COMPACT_THINKING_OWNER), false, "owner slot is deleted");
		assert.equal(host.scheduler.pendingJobs, 0);
		assert.equal(controller.isMessageThinkingActive(message.timestamp), false);
		assert.equal(controller.getMessageThinkingDurationMs(message.timestamp), undefined, "shutdown drops the duration index");
		assert.equal(persisted.length, 1);
		assert.equal(persisted[0].customType, "claude-style-tools-thinking-duration");
		assert.equal(persisted[0].data.messageTimestamp, message.timestamp);
		assert.equal(persisted[0].data.contentIndex, 0);
		assert.ok(persisted[0].data.durationMs >= 1);

		assert.equal(capturedPipeline.call(mounted, message), undefined);
		assert.deepEqual(mounted.render(100), nativeHidden, "captured dispatcher now produces native hidden reasoning");
		assert.equal(capturedStep.call(mounted, message), undefined);
		assert.deepEqual(mounted.render(100), nativeHidden, "captured step is also inert");
		throwOnUpdate = false;
		mounted.updateContent(message);
		assert.deepEqual(mounted.render(100), nativeHidden, "foreign wrapper delegates to the inert pipeline");
		assert.equal(foreignCalls, 1);
		assert.deepEqual(new AssistantMessageComponent(message, false).render(100), nativeVisible);

		shutdown({}, ctx);
		owner.stop();
		controller.dispose();
		controller.dispose();
		assert.ok([...host.handlers.values()].every((handlers) => handlers.length === 0));
		assert.equal(persisted.length, 1, "repeated shutdown never persists twice");
		assert.equal(host.scheduler.pendingJobs, 0);

		next.emit("session_start", {}, ctx);
		const replacementPipeline = prototype.updateContent;
		const replacementOwner = patchRegistry.get(COMPACT_THINKING_OWNER);
		assert.notEqual(replacementPipeline, foreign);
		shutdown({}, ctx);
		owner.stop();
		host.emit("session_shutdown", {}, ctx);
		assert.equal(prototype.updateContent, replacementPipeline, "late old shutdown preserves the new step");
		assert.equal(patchRegistry.get(COMPACT_THINKING_OWNER), replacementOwner);
		replacement.dispose();
		assert.equal(prototype.updateContent, foreign);
		assert.equal(patchRegistry.get(COMPACT_THINKING_OWNER), undefined);
	} finally {
		try { controller.dispose(); }
		finally {
			try { replacement.dispose(); }
			finally {
				host.scheduler.dispose();
				next.scheduler.dispose();
				prototype.updateContent = original;
			}
		}
	}
});

for (const failure of ["persistence", "finalization", "shutdown hook repaint"] as const) {
	test(`dispose releases thinking resources despite ${failure} failure`, (t) => {
		const host = runtime();
		const ctx = themeCtx();
		const prototype = AssistantMessageComponent.prototype;
		const original = prototype.updateContent;
		const message = thinkingMessage(800, false);
		const native = new AssistantMessageComponent(message, true).render(100);
		const controller = installCompactThinking(host.pi, config);
		const error = new Error(`${failure} failed`);
		let appendCalls = 0;
		host.pi.appendEntry = () => {
			appendCalls++;
			if (failure === "persistence") throw error;
		};
		try {
			host.emit("session_start", {}, ctx);
			const capturedPipeline = prototype.updateContent;
			const owner = patchRegistry.get<{ stop(): void }>(COMPACT_THINKING_OWNER)!;
			const shutdown = host.handlers.get("session_shutdown")![0];
			const mounted = new AssistantMessageComponent(message, true);
			host.emit("message_update", { message, assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }, ctx);
			controller.setCompactSummaryActive(true);
			thinkingBlockOf(mounted).setExpanded(true);
			assert.equal(host.scheduler.pendingJobs, 1);
			const foreign: typeof original = function (this: InstanceType<typeof AssistantMessageComponent>, ...args) {
				if (failure === "shutdown hook repaint") throw error;
				return capturedPipeline.apply(this, args);
			};
			prototype.updateContent = foreign;
			if (failure === "shutdown hook repaint") controller.onBeforeShutdown(() => mounted.updateContent(message));
			if (failure === "finalization") t.mock.method(Date, "now", () => { throw error; });

			if (failure === "persistence") assert.doesNotThrow(() => controller.dispose());
			else assert.throws(() => controller.dispose(), (caught) => caught === error);
			t.mock.restoreAll();
			assert.equal(appendCalls, failure === "finalization" ? 0 : 1);
			assert.equal(prototype.updateContent, foreign);
			assert.equal(patchRegistry.get(COMPACT_THINKING_OWNER), undefined);
			assert.equal(Object.hasOwn(globalThis, COMPACT_THINKING_OWNER), false);
			assert.equal(host.scheduler.pendingJobs, 0, "even compact-summary animation is cancelled");
			assert.equal(controller.isMessageThinkingActive(message.timestamp), false);
			assert.equal(controller.getMessageThinkingDurationMs(message.timestamp), undefined);
			assert.ok([...host.handlers.values()].every((handlers) => handlers.length === 0), "dispose unsubscribes even when stop throws");
			capturedPipeline.call(mounted, message);
			assert.deepEqual(mounted.render(100), native);
			assert.doesNotThrow(() => shutdown({}, ctx));
			assert.doesNotThrow(() => owner.stop());
			assert.doesNotThrow(() => controller.dispose());
			assert.equal(appendCalls, failure === "finalization" ? 0 : 1, "failed shutdown cannot finalize twice");
		} finally {
			t.mock.restoreAll();
			try { controller.dispose(); }
			finally { host.scheduler.dispose(); prototype.updateContent = original; }
		}
	});
}

test("visible reasoning and Pi 1.3.0 per-run overrides retain the native Markdown renderer", () => {
	const host = runtime();
	const ctx = themeCtx();
	const message = { ...thinkingMessage(500, false), content: [
		{ type: "thinking", thinking: "**Reason one**\nFull first reasoning" },
		{ type: "text", text: "Answer" },
		{ type: "thinking", thinking: "Second reasoning" },
	], stopReason: "length" } as AssistantMessage;
	const native = new AssistantMessageComponent(message, false);
	const nativeLines = native.render(100);
	const controller = installCompactThinking(host.pi, config);
	try {
		host.emit("session_start", {}, ctx);
		const visible = new AssistantMessageComponent(message, false);
		assert.deepEqual(visible.render(100), nativeLines);
		const mixed = new AssistantMessageComponent(message, true) as any;
		assert.equal(mixed.contentContainer.children.filter((child: unknown) => child instanceof ThinkingPreviewBlock).length, 2);
		mixed.thinkingVisibilityOverrides.set(0, false);
		mixed.updateContent(message);
		assert.equal(mixed.contentContainer.children.filter((child: unknown) => child instanceof ThinkingPreviewBlock).length, 1);
		assert.match(renderText(mixed).join("\n"), /Full first reasoning/);
		assert.match(renderText(mixed).join("\n"), /Response was truncated before completion/);
		mixed.setHideThinkingBlock(false);
		assert.deepEqual(mixed.render(100), nativeLines, "global thinking toggle returns to exact host output");
	} finally { controller.dispose(); host.scheduler.dispose(); }
});
