import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
	Theme,
	type ContextUsage,
	type ExtensionAPI,
	type ExtensionContext,
	type ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import {
	type TUI,
	stripTerminalSequences,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { installFooter } from "../src/footer.js";

type FooterFactory = NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;
type FooterComponent = ReturnType<FooterFactory>;
type Handler = (event: unknown, ctx: ExtensionContext) => void;

function testTheme(): Theme {
	const fg = {
		accent: "#00d7ff",
		dim: "#666666",
		muted: "#999999",
		success: "#5fd75f",
		text: "#eeeeee",
		warning: "#ffd75f",
		thinkingXhigh: "#d787ff",
		searchMatchText: "#ffffff",
	};
	const bg = { selectedBg: "#333333" };
	return new Theme(
		fg as unknown as ConstructorParameters<typeof Theme>[0],
		bg as unknown as ConstructorParameters<typeof Theme>[1],
		"truecolor",
	);
}

function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0, cost = 0) {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function assistant(timestamp: number, input: number, output: number, cacheRead = 0, cacheWrite = 0, cost = 0) {
	return {
		role: "assistant",
		content: [{ type: "text", text: `answer ${timestamp}` }],
		provider: "test",
		model: "model-a",
		responseId: `response-${timestamp}`,
		stopReason: "stop",
		timestamp,
		usage: usage(input, output, cacheRead, cacheWrite, cost),
	};
}

interface HarnessOptions {
	cwd?: string;
	model?: ExtensionContext["model"] | null;
	thinkingLevel?: ExtensionContext["thinkingLevel"] | null;
	entries?: unknown[];
	sessionName?: string;
	contextUsage?: ContextUsage;
	statuses?: Map<string, string>;
}

function harness(t: TestContext, options: HarnessOptions = {}) {
	const theme = testTheme();
	const handlers = new Map<string, Set<Handler>>();
	let unsubscribed = 0;
	const pi = {
		on(event: string, handler: Handler) {
			let set = handlers.get(event);
			if (!set) handlers.set(event, (set = new Set()));
			set.add(handler);
			return () => {
				if (set!.delete(handler)) unsubscribed++;
			};
		},
	} as unknown as ExtensionAPI;

	let entries = options.entries ?? [];
	let sessionName = options.sessionName;
	let contextUsage = options.contextUsage;
	let stateEntryReads = 0;
	let stateContextReads = 0;
	const sessionEntries = () => {
		stateEntryReads++;
		return entries;
	};
	const sessionManager = {
		getEntries: sessionEntries,
		getBranch: () => [],
		getSessionName: () => sessionName,
	} as unknown as ExtensionContext["sessionManager"];

	const statuses = options.statuses ?? new Map<string, string>();
	let gitBranch: string | null = "main";
	const branchListeners = new Set<() => void>();
	let branchUnsubscribes = 0;
	const footerData: ReadonlyFooterDataProvider = {
		getGitBranch: () => gitBranch,
		getExtensionStatuses: () => statuses,
		getAvailableProviderCount: () => 1,
		onBranchChange(listener) {
			branchListeners.add(listener);
			return () => {
				if (branchListeners.delete(listener)) branchUnsubscribes++;
			};
		},
	};

	let renderRequests = 0;
	const tui = {
		requestRender() {
			renderRequests++;
		},
	} as unknown as TUI;
	let activeTui = tui;

	const setFooterCalls: Array<FooterFactory | undefined> = [];
	let current: FooterComponent | undefined;
	let other: FooterComponent | undefined;
	const ui = {
		setFooter(factory: FooterFactory | undefined) {
			setFooterCalls.push(factory);
			const previous = current;
			current = undefined;
			previous?.dispose?.();
			if (factory) current = factory(activeTui, theme, footerData);
		},
	} as unknown as ExtensionContext["ui"];

	const ctx = {
		ui,
		mode: "tui",
		hasUI: true,
		cwd: options.cwd ?? "/tmp/project",
		model: options.model === undefined
			? ({ provider: "test", id: "model-a", name: "Model A" } as ExtensionContext["model"])
			: options.model ?? undefined,
		thinkingLevel: options.thinkingLevel === undefined ? "high" : options.thinkingLevel ?? undefined,
		sessionManager,
		isIdle: () => true,
		getContextUsage: () => {
			stateContextReads++;
			return contextUsage;
		},
	} as unknown as ExtensionContext;

	const mounts: TUI[] = [];
	const cleanup = installFooter(pi, ctx, (mountedTui) => {
		mounts.push(mountedTui);
	});
	t.after(cleanup);

	const emit = (event: string, payload: unknown = {}, eventCtx: ExtensionContext = ctx) => {
		for (const handler of [...(handlers.get(event) ?? [])]) handler(payload, eventCtx);
	};
	const setEntries = (next: unknown[]) => {
		entries = next;
	};
	const setContextUsage = (next: ContextUsage | undefined) => {
		contextUsage = next;
	};
	const setGitBranch = (next: string | null) => {
		gitBranch = next;
		for (const listener of [...branchListeners]) listener();
	};
	const setSessionName = (next: string | undefined) => {
		sessionName = next;
	};
	const setOtherFooter = (component: FooterComponent) => {
		other = component;
		ui.setFooter(() => other!);
	};
	const remount = (nextTui: TUI = activeTui) => {
		activeTui = nextTui;
		const factory = setFooterCalls[0];
		assert.ok(factory);
		ui.setFooter(factory);
	};
	const plain = (width = 200) =>
		(current?.render(width) ?? []).map((line) => stripTerminalSequences(line)).join("\n");
	const lines = (width = 200) => current?.render(width) ?? [];

	return {
		ctx,
		ui,
		tui,
		theme,
		footerData,
		emit,
		setEntries,
		setContextUsage,
		setGitBranch,
		setSessionName,
		setOtherFooter,
		remount,
		cleanup,
		plain,
		lines,
		get current() {
			return current;
		},
		get mounted() {
			return mounts.at(-1);
		},
		get mounts() {
			return mounts;
		},
		get renderRequests() {
			return renderRequests;
		},
		get entryReads() {
			return stateEntryReads;
		},
		get contextReads() {
			return stateContextReads;
		},
		get unsubscribed() {
			return unsubscribed;
		},
		get branchUnsubscribes() {
			return branchUnsubscribes;
		},
		get setFooterCalls() {
			return setFooterCalls;
		},
	};
}

test("installs through setFooter, mounts the host TUI, and renders without scanning history", (t) => {
	const h = harness(t, {
		entries: [{ type: "message", message: assistant(1, 120, 30, 40, 10, 0.125) }],
		contextUsage: { tokens: 1_200, contextWindow: 10_000, percent: 12 },
		sessionName: "demo",
	});

	assert.equal(h.current !== undefined, true);
	assert.equal(h.mounted, h.tui);
	assert.equal(h.setFooterCalls.length, 1);
	assert.equal(h.entryReads, 1);
	const before = h.renderRequests;
	const text = h.plain();
	assert.match(text, /project/);
	assert.match(text, /main/);
	assert.match(text, /demo/);
	assert.match(text, /test\/model-a/);
	assert.match(text, /thinking high/);
	assert.match(text, /12\.0%/);
	assert.match(text, /↑120 ↓30 R40 W10 cache 23\.5%/);
	assert.match(text, /\$0\.125/);
	h.current?.render(80);
	assert.equal(h.entryReads, 1);
	assert.equal(h.renderRequests, before);
});

test("keeps cumulative usage and the latest request's cache rate without replaying finalizations", (t) => {
	const historical = assistant(1, 100, 10, 20, 5, 0.125);
	const h = harness(t, {
		entries: [{ type: "message", message: historical }],
		contextUsage: { tokens: 1_000, contextWindow: 10_000, percent: 10 },
	});
	assert.equal(h.contextReads, 1);
	const initial = h.plain();
	assert.match(initial, /↑100/);
	assert.match(initial, /↓10/);
	assert.equal(h.plain(), initial);
	assert.equal(h.contextReads, 1);

	h.setContextUsage({ tokens: 2_000, contextWindow: 10_000, percent: 20 });
	const contextReadsBefore = h.contextReads;
	const final = assistant(2, 499, 5, 501, 0, 0.25);
	h.emit("message_end", { message: final });
	assert.equal(h.contextReads, contextReadsBefore + 1);
	const once = h.plain();
	assert.match(once, /↑599/);
	assert.match(once, /↓15/);
	assert.match(once, /R521 W5 cache 50\.1%/);
	assert.match(once, /\$0\.375/);
	assert.match(once, /20\.0%/);

	h.emit("message_end", { message: final });
	h.emit("message_end", { message: { ...final, usage: { ...final.usage, cost: { ...final.usage.cost } } } });
	h.emit("message_end", { message: historical });
	assert.equal(h.plain(), once);
	assert.equal(h.entryReads, 1);

	h.emit("message_end", { message: assistant(3, 60, 0, 0, 40) });
	assert.match(h.plain(), /R521 W45 cache 0\.0%/);
	h.emit("message_end", { message: assistant(4, 0, 2) });
	assert.match(h.plain(), /R521 W45/);
	assert.doesNotMatch(h.plain(), /cache \S+%/);
});

test("keeps distinct assistants that share finalization metadata and usage", (t) => {
	const h = harness(t, { entries: [] });
	const first = {
		...assistant(10, 100, 10),
		content: [{ type: "text", text: "first" }],
	};
	const second = {
		...assistant(10, 100, 10),
		content: [{ type: "text", text: "other" }],
	};
	h.emit("message_end", { message: first });
	h.emit("message_end", { message: second });
	assert.match(h.plain(), /↑200/);
	assert.match(h.plain(), /↓20/);

	const duplicate = { ...second, content: [{ type: "text", text: "other" }] };
	h.emit("message_end", { message: duplicate });
	assert.match(h.plain(), /↑200/);
});

test("keeps whole-session usage, including off-branch entries, at tree and compaction boundaries", (t) => {
	const historical = { type: "message", message: assistant(1, 100, 10, 20, 5, 0.1) };
	const h = harness(t, {
		entries: [historical],
		contextUsage: { tokens: 1_000, contextWindow: 10_000, percent: 10 },
	});
	assert.equal(h.entryReads, 1);

	const entries = [
		historical,
		{ type: "message", message: assistant(2, 300, 30, 50, 10, 0.2) },
		{ type: "usage", kind: "session", provider: "test", model: "model-a", usage: usage(20, 2, 4, 6, 0.03) },
		{
			type: "message",
			message: { role: "toolResult", toolCallId: "call-1", content: [], timestamp: 3, usage: usage(10, 0, 1, 2, 0.01) },
		},
		{ type: "branch_summary", fromId: "old", summary: "summary", usage: usage(5, 1, 0, 0, 0.005) },
		{ type: "compaction", summary: "summary", firstKeptEntryId: "kept", tokensBefore: 1_000, usage: usage(1, 0, 0, 0, 0.001) },
	];
	h.setEntries(entries);
	h.emit("session_tree", { newLeafId: "new", oldLeafId: "old" });
	assert.equal(h.entryReads, 2);
	const rebuilt = h.plain();
	assert.match(rebuilt, /↑436 ↓43 R75 W23 cache 13\.9%/);
	assert.match(rebuilt, /\$0\.346/);
	assert.equal(h.entryReads, 2);

	h.setEntries([
		...entries,
		{ type: "compaction", summary: "next summary", usage: usage(7, 1, 0, 0, 0.01) },
	]);
	h.emit("session_compact", { compactionEntry: { type: "compaction" } });
	assert.equal(h.entryReads, 3);
	const compacted = h.plain();
	assert.match(compacted, /↑443 ↓44 R75 W23 cache 13\.9%/);
	assert.match(compacted, /\$0\.356/);
	assert.equal(h.entryReads, 3);
});

test("uses the event context at rebuild boundaries instead of retaining the install context", (t) => {
	const h = harness(t, { entries: [] });
	assert.equal(h.entryReads, 1);
	assert.equal(h.contextReads, 1);
	let alternateEntryReads = 0;
	let alternateContextReads = 0;
	const alternateUsage = { tokens: 5_000, contextWindow: 10_000, percent: 50 };
	const alternateCtx = {
		...h.ctx,
		sessionManager: {
			getEntries() {
				alternateEntryReads++;
				return [{ type: "message", message: assistant(9, 900, 90, 0, 0, 0.5) }];
			},
		},
		getContextUsage() {
			alternateContextReads++;
			return alternateUsage;
		},
	} as unknown as ExtensionContext;

	h.emit("session_tree", { newLeafId: "alternate", oldLeafId: null }, alternateCtx);
	assert.equal(h.entryReads, 1);
	assert.equal(h.contextReads, 1);
	assert.equal(alternateEntryReads, 1);
	assert.equal(alternateContextReads, 1);
	const text = h.plain();
	assert.match(text, /↑900/);
	assert.match(text, /50\.0%/);
});

test("shows one bounded activity timer, preserves final elapsed, and clears it at the next activity", (t) => {
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000 });
	const h = harness(t, { entries: [] });

	h.emit("before_agent_start", { prompt: "work" });
	assert.match(h.plain(), /working/);
	assert.match(h.plain(), /0s/);
	const requestsBeforeTick = h.renderRequests;
	t.mock.timers.tick(2_500);
	assert.ok(h.renderRequests > requestsBeforeTick);
	assert.match(h.plain(), /working/);
	assert.match(h.plain(), /2s/);

	h.emit("agent_start", {});
	const requestsAfterStart = h.renderRequests;
	t.mock.timers.tick(1_000);
	assert.equal(h.renderRequests, requestsAfterStart + 1);
	assert.match(h.plain(), /3s/);

	h.emit("tool_execution_start", { toolCallId: "tool-1", toolName: "read", args: {} });
	assert.match(h.plain(), /read/);
	h.emit("tool_execution_end", { toolCallId: "tool-1", toolName: "read", result: {}, isError: false });
	assert.doesNotMatch(h.plain(), /read/);
	h.emit("agent_end", { messages: [] });
	assert.match(h.plain(), /working/);

	h.setContextUsage({ tokens: 4_000, contextWindow: 10_000, percent: 40 });
	const requestsBeforeSettle = h.renderRequests;
	h.emit("agent_settled", { aborted: false });
	assert.ok(h.renderRequests > requestsBeforeSettle);
	const settled = h.plain();
	assert.match(settled, /done 3s/);
	assert.doesNotMatch(settled, /working/);
	assert.match(settled, /40\.0%/);
	const requestsAfterSettle = h.renderRequests;
	t.mock.timers.tick(10_000);
	assert.equal(h.renderRequests, requestsAfterSettle);
	assert.match(h.plain(), /done 3s/);

	h.emit("agent_start", {});
	assert.match(h.plain(), /working/);
	assert.doesNotMatch(h.plain(), /done/);
	h.cleanup();
	const requestsAfterCleanup = h.renderRequests;
	t.mock.timers.tick(5_000);
	assert.equal(h.renderRequests, requestsAfterCleanup);
});

test("keeps elapsed time visible when a narrow footer truncates tool names", (t) => {
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000 });
	const h = harness(t, { entries: [] });
	h.emit("before_agent_start", {});
	h.emit("tool_execution_start", { toolCallId: "tool-1", toolName: "very-long-工具-name", args: {} });
	const width = 18;
	const rendered = h.lines(width);
	const activity = stripTerminalSequences(rendered.at(-1) ?? "");
	assert.match(activity, /working/);
	assert.match(activity, /0s/);
	for (const line of rendered) assert.ok(visibleWidth(line) <= width);
});

test("remounts with the parent TUI, restarts an active timer, and leaves a replacement footer alone", (t) => {
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000 });
	const h = harness(t, { entries: [] });
	h.emit("before_agent_start", {});
	const nextTui = {
		requestRender() {
			h.tui.requestRender();
		},
	} as unknown as TUI;
	h.remount(nextTui);
	assert.equal(h.mounts.length, 2);
	assert.equal(h.mounts[1], nextTui);

	const requestsAfterReplacement = h.renderRequests;
	t.mock.timers.tick(1_000);
	assert.equal(h.renderRequests, requestsAfterReplacement + 1);

	const other: FooterComponent = {
		invalidate() {},
		dispose() {},
		render() {
			return ["other"];
		},
	};
	h.setOtherFooter(other);
	assert.equal(h.current, other);
	assert.equal(h.mounts.length, 2);

	h.cleanup();
	assert.equal(h.setFooterCalls.length, 3);
	assert.equal(h.current, other);
	assert.equal(h.branchUnsubscribes, 2);
	const requestsAfterCleanup = h.renderRequests;
	t.mock.timers.tick(1_000);
	assert.equal(h.renderRequests, requestsAfterCleanup);
	h.cleanup();
	assert.equal(h.setFooterCalls.length, 3);
});

test("cleanup restores the native footer once, releases events, and never clears a stale frame", (t) => {
	const h = harness(t, { entries: [] });
	const component = h.current;
	assert.ok(component);
	assert.equal(h.mounts.length, 1);
	h.setGitBranch("feature");
	assert.equal(h.renderRequests, 1);

	h.cleanup();
	assert.equal(h.setFooterCalls.length, 2);
	assert.equal(h.setFooterCalls[1], undefined);
	assert.equal(h.current, undefined);
	assert.deepEqual(component.render(80), []);
	assert.equal(h.unsubscribed, 11);
	assert.equal(h.branchUnsubscribes, 1);
	const requestsAfterCleanup = h.renderRequests;
	h.emit("message_end", { message: assistant(1, 1, 1) });
	h.emit("agent_start", {});
	h.setGitBranch("other");
	assert.equal(h.renderRequests, requestsAfterCleanup);
	h.cleanup();
	assert.equal(h.setFooterCalls.length, 2);
	assert.equal(h.unsubscribed, 11);
});

test("updates model, thinking, session, Git, context, and extension statuses without rereading history", (t) => {
	const statuses = new Map<string, string>([["alpha", "first"]]);
	const h = harness(t, {
		entries: [],
		statuses,
		contextUsage: { tokens: 1_000, contextWindow: 10_000, percent: 10 },
	});
	h.setContextUsage({ tokens: 2_500, contextWindow: 10_000, percent: 25 });
	h.emit("model_select", { model: { provider: "vendor", id: "m2" }, previousModel: undefined, source: "test" });
	h.emit("thinking_level_select", { level: "low", previousLevel: "high" });
	h.emit("session_info_changed", { name: "New Session" });
	h.setGitBranch("dev");
	statuses.set("late", "late status");

	const text = h.plain();
	assert.match(text, /vendor\/m2/);
	assert.match(text, /thinking low/);
	assert.match(text, /New Session/);
	assert.match(text, /git:dev/);
	assert.match(text, /25\.0%/);
	assert.match(text, /first/);
	assert.match(text, /late status/);
	assert.doesNotMatch(text, /test\/model-a/);
	assert.doesNotMatch(text, /thinking high/);
	assert.equal(h.entryReads, 1);
	assert.equal(h.contextReads, 2);
});

test("tolerates missing model/context and keeps Unicode, narrow widths, and sanitized statuses intact", (t) => {
	const statuses = new Map<string, string>([
		["z", "\u001b[31mred\u0007next\u001b[0m"],
		["a", "安全状态"],
	]);
	const h = harness(t, {
		cwd: "/tmp/项目-very-long-directory",
		model: null,
		thinkingLevel: null,
		entries: [],
		statuses,
		sessionName: "会话-α",
	});
	h.setGitBranch("功能/分支");
	const width = 18;
	const rendered = h.lines(width);
	assert.ok(rendered.length >= 3);
	for (const line of rendered) {
		assert.ok(visibleWidth(line) <= width, `line exceeds ${width}: ${JSON.stringify(line)}`);
	}
	const text = h.plain(width);
	assert.match(text, /no-model/);
	assert.doesNotMatch(text, /thinking/);
	assert.doesNotMatch(text, /\bctx\b/);
	assert.match(text, /安全/);
	assert.match(text, /red/);
	assert.doesNotMatch(text, /\u0007/);
	assert.equal(h.entryReads, 1);
	assert.equal(h.contextReads, 1);
});

test("keeps bounded dedupe state while preserving all unique usage totals", (t) => {
	const h = harness(t, { entries: [] });
	for (let index = 0; index < 600; index++) {
		h.emit("message_end", { message: assistant(index, 1, 0) });
	}
	assert.match(h.plain(), /↑600/);

	const last = assistant(999, 1, 0);
	h.emit("message_end", { message: last });
	h.emit("message_end", { message: last });
	assert.match(h.plain(), /↑601/);
	assert.equal(h.entryReads, 1);
});
