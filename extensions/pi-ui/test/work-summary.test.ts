import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, CustomMessageComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { setConfig } from "../src/config/config.ts";
import { harness } from "./harness.ts";

const assistantMessage = (content: any[], timestamp: number) => ({
	role: "assistant", content, timestamp, stopReason: "toolUse",
	api: "openai-responses", provider: "openai", model: "fixture",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
}) as any;

test("regular work summary clock preserves scrollback after a long file card", async (t) => {
	const h = await harness({ mode: "compact", tuiMode: "regular", rows: 24, columns: 100, widgetsAfterTranscript: true });
	const writes: string[] = [];
	const write = h.terminal.write;
	h.terminal.write = (chunk) => { writes.push(chunk); return write(chunk); };
	t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
	try {
		await h.emit("agent_start", { type: "agent_start" });
		const message = assistantMessage([
			{ type: "toolCall", name: "read", id: "inspect", arguments: { path: "source.ts" } },
			{ type: "toolCall", name: "write", id: "write", arguments: { path: "output.ts", content: "output" } },
		], Date.now());
		h.root.addChild(new AssistantMessageComponent(message, true));
		h.tool("read", "inspect", { path: "source.ts" }, { content: [{ type: "text", text: "source" }], isError: false });
		const body = Array.from({ length: 80 }, (_, i) => `stable file line ${i + 1}`).join("\n");
		const file = h.tool("write", "write", { path: "output.ts", content: body },
			{ content: [{ type: "text", text: "saved" }], isError: false });
		file.setExpanded(true);
		const initial = h.render();
		assert.ok(initial.length > h.terminal.rows, "the fixture really exceeds the regular viewport");
		writes.length = 0;
		for (let i = 0; i < 3; i++) {
			t.mock.timers.tick(1_000);
			const lines = h.render();
			assert.ok(lines.some((line) => /Running.*Read 1 file/.test(line)), lines.join("\n"));
		}
		assert.equal(writes.filter((chunk) => chunk.includes("\x1b[3J")).length, 0,
			"updating the current Work Summary must not clear the terminal's history");
	} finally { await h.close(); }
});

test("provisional text and an intermediate agent end do not settle the work summary", async (t) => {
	const h = await harness({ mode: "compact" });
	t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
	try {
		await h.emit("agent_start", { type: "agent_start" });
		h.root.addChild(new AssistantMessageComponent(assistantMessage([
			{ type: "toolCall", name: "read", id: "inspect", arguments: { path: "source.ts" } },
		], Date.now()), true));
		h.tool("read", "inspect", { path: "source.ts" }, { content: [{ type: "text", text: "source" }], isError: false });
		h.render();
		t.mock.timers.tick(2_000);
		const provisional = assistantMessage([{ type: "text", text: "Provisional response retained." }], Date.now());
		provisional.stopReason = "stop";
		h.root.addChild(new AssistantMessageComponent(provisional, true));
		await h.emit("agent_end", { type: "agent_end", messages: [provisional] });
		assert.match(h.render().join("\n"), /Running.*2s.*Read 1 file/);
		await h.emit("agent_start", { type: "agent_start" });
		t.mock.timers.tick(3_000);
		await h.emit("agent_settled", { type: "agent_settled" });
		const settled = h.render();
		assert.match(settled.join("\n"), /Provisional response retained/);
		assert.match(settled.join("\n"), /Ran for 5s, Read 1 file/);
		t.mock.timers.tick(20_000);
		assert.deepEqual(h.render(), settled, "settled summary stays static");
	} finally { await h.close(); }
});

test("work duration excludes explicit user waiting without adding parallel tool time", async (t) => {
	const h = await harness({ mode: "compact" });
	t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
	try {
		await h.emit("agent_start", { type: "agent_start" });
		h.root.addChild(new AssistantMessageComponent(assistantMessage([
			{ type: "toolCall", name: "read", id: "inspect", arguments: { path: "source.ts" } },
			{ type: "toolCall", name: "bash", id: "check", arguments: { command: "local check" } },
		], Date.now()), true));
		h.render();
		t.mock.timers.tick(1_000);
		await h.emit("ui_prompt_start", { type: "ui_prompt_start", reason: "ui_prompt", kind: "input", title: "Choose" });
		t.mock.timers.tick(10_000);
		assert.match(h.render().join("\n"), /Running\.\.\. · 1s, Read 1 file, Ran shell 1 time/);
		await h.emit("ui_prompt_end", { type: "ui_prompt_end", reason: "ui_prompt", kind: "input", title: "Choose" });
		t.mock.timers.tick(2_000);
		await h.emit("agent_settled", { type: "agent_settled" });
		assert.match(h.render().join("\n"), /Ran for 3s, Read 1 file, Ran shell 1 time/);
	} finally { await h.close(); }
});

test("style changes retain the active group's elapsed work instead of restarting its clock", async (t) => {
	const h = await harness({ mode: "compact" });
	t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
	try {
		await h.emit("agent_start", { type: "agent_start" });
		h.root.addChild(new AssistantMessageComponent(assistantMessage([
			{ type: "toolCall", name: "read", id: "inspect", arguments: { path: "source.ts" } },
		], Date.now()), true));
		h.render();
		t.mock.timers.tick(5_000);
		await h.commands.get("ccstyle").handler("off", h.ctx);
		t.mock.timers.tick(3_000);
		await h.commands.get("ccstyle").handler("compact", h.ctx);
		assert.match(h.render().join("\n"), /Running\.\.\. · 8s, Read 1 file/);
		await h.emit("agent_settled", { type: "agent_settled" });
		assert.match(h.render().join("\n"), /Ran for 8s, Read 1 file/);
	} finally { await h.close(); }
});

test("a late transcript callback from a replaced UI cannot join the current work group", async (t) => {
	const first = await harness({ mode: "compact" });
	let current: Awaited<ReturnType<typeof harness>> | undefined;
	t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
	try {
		await first.emit("agent_start", { type: "agent_start" });
		const oldMessage = assistantMessage([
			{ type: "toolCall", name: "read", id: "old", arguments: { path: "old-project.ts" } },
		], Date.now());
		const oldAssistant = new AssistantMessageComponent(oldMessage, true);
		first.root.addChild(oldAssistant);
		first.render();
		t.mock.timers.tick(1_000);
		current = await harness({ mode: "compact" });
		await current.emit("agent_start", { type: "agent_start" });
		current.root.addChild(new AssistantMessageComponent(assistantMessage([
			{ type: "toolCall", name: "bash", id: "current", arguments: { command: "current-project-check" } },
		], Date.now()), true));
		current.render();
		oldAssistant.updateContent(oldMessage);
		const visible = current.render().join("\n");
		assert.match(visible, /Ran shell 1 time/);
		assert.doesNotMatch(visible, /Read 1 file|old-project/);
	} finally { await current?.close(); await first.close(); }
});

test("an expanded compact group uses the selected semantic background on its next paint", async () => {
	const h = await harness({ mode: "compact" });
	try {
		const group = new AssistantMessageComponent(assistantMessage([
			{ type: "toolCall", name: "read", id: "inspect", arguments: { path: "source.ts" } },
		], 100), true) as any;
		h.root.addChild(group);
		h.tool("read", "inspect", { path: "source.ts" }, { content: [{ type: "text", text: "source" }], isError: false });
		h.render();
		group.setExpanded(true);
		h.render();
		setConfig({ mode: "compact", expandedCardBackground: "toolPendingBg" });
		const painted = h.root.render(100).join("\n");
		assert.ok(painted.includes(h.ctx.ui.theme.getBgAnsi("toolPendingBg")),
			"the outer process card must use the selected host theme slot");
	} finally { await h.close(); }
});

test("compact process rows keep shared command and expression summaries in a wide viewport", async () => {
	const h = await harness({ mode: "compact", columns: 180 });
	try {
		// Bind public native-tool metadata; use Pi's real renderer without
		// executing PowerShell on this POSIX test host.
		for (const name of ["powershell", "find"]) h.toolMetadata.set(name, {
			name, sourceInfo: { path: `builtin:${name}`, source: "builtin", scope: "temporary", origin: "top-level" },
		} as any);
		const command = `Get-Item ${"workspace-".repeat(8)}wide-tail.log`;
		h.root.addChild(new AssistantMessageComponent(assistantMessage([
			{ type: "toolCall", name: "powershell", id: "shell", arguments: { command } },
			{ type: "toolCall", name: "find", id: "search", arguments: { pattern: "needle-scope", path: "project-src" } },
		], 100), true));
		h.tool("powershell", "shell", { command }, { content: [{ type: "text", text: "found" }] });
		h.tool("find", "search", { pattern: "needle-scope", path: "project-src" }, { content: [{ type: "text", text: "match" }] });
		const folded = h.render();
		const row = folded.findIndex((line) => line.includes("click to show more"));
		h.click(folded[row]!.indexOf("click to show more") + 1, row);
		const process = h.render().join("\n");
		assert.match(process, /PowerShell Get-Item .*wide-tail\.log/);
		assert.match(process, /Find "needle-scope" in project-src/);
	} finally { await h.close(); }
});

test("standalone notifications divide work groups and stay visible", async (t) => {
	const h = await harness({ mode: "compact" });
	t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
	try {
		await h.emit("agent_start", { type: "agent_start" });
		const addCall = (name: string, id: string) => {
			h.root.addChild(new AssistantMessageComponent(assistantMessage([
				{ type: "toolCall", name, id, arguments: { command: id } },
			], Date.now()), true));
		};
		addCall("bash", "first");
		t.mock.timers.tick(1_000);
		addCall("grep", "second");
		assert.match(h.render().join("\n"), /Ran shell 1 time, Used grep 1 time/);
		const notification: any = { role: "custom", customType: "test-notification", display: true,
			content: "STANDALONE NOTIFICATION", timestamp: Date.now() };
		await h.emit("message_start", { type: "message_start", message: notification });
		h.root.addChild(new CustomMessageComponent(notification));
		t.mock.timers.tick(1_000);
		addCall("find", "third");
		const visible = h.render();
		const summaries = visible.filter((line) => line.includes("click to show more"));
		assert.equal(summaries.length, 2, visible.join("\n"));
		assert.match(summaries[0]!, /Ran shell 1 time, Used grep 1 time/);
		assert.doesNotMatch(summaries[0]!, /Used find 1 time/);
		assert.match(summaries[1]!, /Running.*Used find 1 time/);
		assert.doesNotMatch(summaries[1]!, /Ran shell 1 time|Used grep 1 time/);
		assert.match(visible.join("\n"), /STANDALONE NOTIFICATION/);
	} finally { await h.close(); }
});

test("distinct work groups with equal assistant timestamps keep independent elapsed clocks", async (t) => {
	const h = await harness({ mode: "compact" });
	t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
	const timestamp = Date.now();
	try {
		await h.emit("agent_start", { type: "agent_start" });
		h.root.addChild(new AssistantMessageComponent(assistantMessage([
			{ type: "toolCall", name: "bash", id: "first", arguments: { command: "first" } },
		], timestamp), true));
		t.mock.timers.tick(1_000);
		await h.emit("message_start", { type: "message_start", message: {
			role: "custom", customType: "test-notification", display: true, content: "A new group",
		} });
		h.root.addChild(new AssistantMessageComponent(assistantMessage([
			{ type: "toolCall", name: "grep", id: "second", arguments: { pattern: "second" } },
		], timestamp), true));
		t.mock.timers.tick(2_000);
		const summaries = h.render().filter((line) => line.includes("click to show more"));
		assert.match(summaries[0]!, /Ran for 1s, Ran shell 1 time/);
		assert.match(summaries[1]!, /Running.*2s, Searched for 1 pattern/);
	} finally { await h.close(); }
});

test("settling and user waiting while styling is off freeze the retained work clock", async (t) => {
	const h = await harness({ mode: "compact" });
	t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
	try {
		await h.emit("agent_start", { type: "agent_start" });
		h.root.addChild(new AssistantMessageComponent(assistantMessage([
			{ type: "toolCall", name: "bash", id: "check", arguments: { command: "check" } },
		], Date.now()), true));
		h.render();
		t.mock.timers.tick(2_000);
		await h.commands.get("ccstyle").handler("off", h.ctx);
		await h.emit("ui_prompt_start", { type: "ui_prompt_start", reason: "ui_prompt", kind: "input", title: "Choose" });
		t.mock.timers.tick(10_000);
		await h.emit("ui_prompt_end", { type: "ui_prompt_end", reason: "ui_prompt", kind: "input", title: "Choose" });
		t.mock.timers.tick(1_000);
		await h.emit("agent_settled", { type: "agent_settled" });
		t.mock.timers.tick(20_000);
		await h.commands.get("ccstyle").handler("compact", h.ctx);
		const settled = h.render();
		assert.match(settled.join("\n"), /Ran for 3s, Ran shell 1 time/);
		assert.doesNotMatch(settled.join("\n"), /Running/);
		t.mock.timers.tick(20_000);
		assert.deepEqual(h.render(), settled);
	} finally { await h.close(); }
});

test("a sole thinking anchor retains its work clock through streaming prose and subsequent tools", async (t) => {
	const h = await harness({ mode: "compact" });
	t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
	try {
		await h.emit("agent_start", { type: "agent_start" });
		const message = assistantMessage([{ type: "thinking", thinking: "Inspecting the source." }], Date.now());
		await h.emit("message_start", { type: "message_start", message });
		const assistant = new AssistantMessageComponent(message, true);
		h.root.addChild(assistant);
		h.render();
		t.mock.timers.tick(1_000);
		const progress = { ...message, content: [...message.content, { type: "text", text: "Progress prose." }] };
		assistant.updateContent(progress, true);
		assert.match(h.render().join("\n"), /Progress prose/);
		t.mock.timers.tick(2_000);
		assistant.updateContent({ ...progress, content: [...progress.content,
			{ type: "toolCall", name: "read", id: "after-prose", arguments: { path: "source.ts" } },
		] }, true);
		h.tool("read", "after-prose", { path: "source.ts" }, { content: [{ type: "text", text: "source" }], isError: false });
		assert.match(h.render().join("\n"), /Running.*3s.*Read 1 file/);
		t.mock.timers.tick(3_000);
		await h.emit("agent_settled", { type: "agent_settled" });
		assert.match(h.render().join("\n"), /Ran for 6s, Thought 1 time, Read 1 file/);
	} finally { await h.close(); }
});

test("work begun and settled entirely in off mode retains its known elapsed duration", async (t) => {
	const h = await harness({ mode: "off" });
	t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
	try {
		await h.emit("agent_start", { type: "agent_start" });
		const addCall = (name: string, id: string) => h.root.addChild(new AssistantMessageComponent(assistantMessage([
			{ type: "toolCall", name, id, arguments: { command: id, path: "source.ts" } },
		], Date.now()), true));
		addCall("bash", "first");
		t.mock.timers.tick(1_000);
		await h.emit("ui_prompt_start", { type: "ui_prompt_start", reason: "ui_prompt", kind: "input", title: "Choose" });
		t.mock.timers.tick(10_000);
		await h.emit("ui_prompt_end", { type: "ui_prompt_end", reason: "ui_prompt", kind: "input", title: "Choose" });
		addCall("read", "second");
		t.mock.timers.tick(2_000);
		await h.emit("agent_settled", { type: "agent_settled" });
		t.mock.timers.tick(20_000);
		await h.commands.get("ccstyle").handler("compact", h.ctx);
		const summaries = h.render().filter((line) => /Ran shell 1 time|Read 1 file/.test(line));
		assert.equal(summaries.length, 1);
		assert.match(summaries[0]!, /Ran for 3s, Read 1 file, Ran shell 1 time/);
	} finally { await h.close(); }
});

test("a later thinking member keeps its group live when its prose becomes a tool call", async (t) => {
	const h = await harness({ mode: "compact" });
	t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
	try {
		await h.emit("agent_start", { type: "agent_start" });
		h.root.addChild(new AssistantMessageComponent(assistantMessage([
			{ type: "toolCall", name: "bash", id: "first", arguments: { command: "check" } },
		], Date.now()), true));
		const message = assistantMessage([{ type: "thinking", thinking: "Inspecting the source." }], Date.now());
		const assistant = new AssistantMessageComponent(message, true);
		h.root.addChild(assistant);
		t.mock.timers.tick(1_000);
		const progress = { ...message, content: [...message.content, { type: "text", text: "More progress." }] };
		assistant.updateContent(progress, true);
		assert.match(h.render().join("\n"), /More progress/);
		t.mock.timers.tick(2_000);
		assistant.updateContent({ ...progress, content: [...progress.content,
			{ type: "toolCall", name: "read", id: "after-prose", arguments: { path: "source.ts" } },
		] }, true);
		const summaries = h.render().filter((line) => /Ran shell 1 time|Read 1 file/.test(line));
		assert.equal(summaries.length, 1);
		assert.match(summaries[0]!, /Running.*3s, Thought 1 time, Read 1 file, Ran shell 1 time/);
	} finally { await h.close(); }
});

test("mode refresh preserves groups on both sides of a notification and the active duration", async (t) => {
	const h = await harness({ mode: "compact" });
	t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
	try {
		await h.emit("agent_start", { type: "agent_start" });
		h.root.addChild(new AssistantMessageComponent(assistantMessage([
			{ type: "toolCall", name: "bash", id: "first", arguments: { command: "first" } },
		], Date.now()), true));
		t.mock.timers.tick(1_000);
		const notification: any = { role: "custom", customType: "notification", display: true,
			content: "Independent boundary", timestamp: Date.now() };
		await h.emit("message_start", { type: "message_start", message: notification });
		h.root.addChild(new CustomMessageComponent(notification));
		h.root.addChild(new AssistantMessageComponent(assistantMessage([
			{ type: "toolCall", name: "grep", id: "second", arguments: { pattern: "second" } },
		], Date.now()), true));
		t.mock.timers.tick(2_000);
		h.render();
		await h.commands.get("ccstyle").handler("off", h.ctx);
		t.mock.timers.tick(1_000);
		await h.commands.get("ccstyle").handler("compact", h.ctx);
		const summaries = h.render().filter((line) => /Ran shell 1 time|Searched for 1 pattern/.test(line));
		assert.equal(summaries.length, 2);
		assert.match(summaries[0]!, /Ran for 1s, Ran shell 1 time/);
		assert.match(summaries[1]!, /Running.*3s, Searched for 1 pattern/);
	} finally { await h.close(); }
});

test("expanded thinking keeps final prose outside the process card before and after settlement", async (t) => {
	const h = await harness({ mode: "compact" });
	setConfig({ mode: "compact", expandedCardBackground: "toolPendingBg" });
	t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
	try {
		await h.emit("agent_start", { type: "agent_start" });
		const message = assistantMessage([{ type: "thinking", thinking: "Inspecting the source." }], Date.now());
		const assistant = new AssistantMessageComponent(message, true);
		h.root.addChild(assistant);
		const expand = () => {
			const lines = h.render();
			const row = lines.findIndex((line) => line.includes("click to show more"));
			assert.ok(row >= 0);
			h.click(lines[row]!.indexOf("click to show more") + 1, row);
		};
		expand();
		const final = { ...message, content: [...message.content, { type: "text", text: "Final answer stays native." }] };
		assistant.updateContent(final, true);
		const assertNativeAnswer = () => {
			assert.ok(h.render().some((line) => line.trim() === "Final answer stays native."));
			const painted = h.root.render(100).find((line) => line.includes("Final answer stays native."))!;
			assert.ok(!painted.includes(h.ctx.ui.theme.getBgAnsi("toolPendingBg")),
				"native final prose must not inherit the process card's selected background");
		};
		assertNativeAnswer();
		t.mock.timers.tick(3_000);
		await h.emit("agent_settled", { type: "agent_settled" });
		assertNativeAnswer();
		const lines = h.render();
		const row = lines.findIndex((line) => line.includes("Inspecting the source."));
		assert.ok(row >= 0);
		h.click(lines[row]!.indexOf("Inspecting") + 1, row);
		expand();
		assertNativeAnswer();
	} finally { await h.close(); }
});

test("an empty error response and automatic retry waiting do not settle the current work group", async (t) => {
	const h = await harness({ mode: "compact" });
	t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
	try {
		await h.emit("agent_start", { type: "agent_start" });
		h.root.addChild(new AssistantMessageComponent(assistantMessage([
			{ type: "toolCall", name: "bash", id: "first", arguments: { command: "check" } },
		], Date.now()), true));
		t.mock.timers.tick(1_000);
		const error = { ...assistantMessage([], Date.now()), stopReason: "error", errorMessage: "Retryable provider failure" };
		h.root.addChild(new AssistantMessageComponent(error, true));
		await h.emit("agent_end", { type: "agent_end", messages: [error] });
		t.mock.timers.tick(10_000);
		assert.match(h.render().join("\n"), /Running.*11s, Ran shell 1 time/);
		await h.emit("agent_start", { type: "agent_start" });
		h.root.addChild(new AssistantMessageComponent(assistantMessage([
			{ type: "toolCall", name: "read", id: "continued", arguments: { path: "source.ts" } },
		], Date.now()), true));
		t.mock.timers.tick(2_000);
		await h.emit("agent_settled", { type: "agent_settled" });
		assert.match(h.render().join("\n"), /Ran for 13s, Read 1 file, Ran shell 1 time/);
		assert.match(h.render().join("\n"), /Retryable provider failure/);
	} finally { await h.close(); }
});

test("replaying mixed process text received while off does not freeze its shared live clock", async (t) => {
	const h = await harness({ mode: "off" });
	t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
	try {
		await h.emit("agent_start", { type: "agent_start" });
		h.root.addChild(new AssistantMessageComponent(assistantMessage([
			{ type: "toolCall", name: "bash", id: "first", arguments: { command: "check" } },
		], Date.now()), true));
		t.mock.timers.tick(1_000);
		h.root.addChild(new AssistantMessageComponent(assistantMessage([
			{ type: "text", text: "Reading next." },
			{ type: "toolCall", name: "read", id: "next", arguments: { path: "source.ts" } },
		], Date.now()), true));
		t.mock.timers.tick(2_000);
		await h.commands.get("ccstyle").handler("compact", h.ctx);
		const summaries = h.render().filter((line) => /Ran shell 1 time|Read 1 file/.test(line));
		assert.equal(summaries.length, 1);
		assert.match(summaries[0]!, /Running.*3s, Read 1 file, Ran shell 1 time/);
	} finally { await h.close(); }
});

test("a closed group refreshed during user waiting never acquires another pause", async (t) => {
	const h = await harness({ mode: "compact" });
	t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
	try {
		await h.emit("agent_start", { type: "agent_start" });
		h.root.addChild(new AssistantMessageComponent(assistantMessage([
			{ type: "toolCall", name: "bash", id: "first", arguments: { command: "check" } },
		], Date.now()), true));
		t.mock.timers.tick(2_000);
		await h.emit("message_start", { type: "message_start", message: {
			role: "custom", display: true, customType: "notification", content: "Independent boundary",
		} });
		await h.emit("ui_prompt_start", { type: "ui_prompt_start", reason: "ui_prompt", kind: "input", title: "Choose" });
		await h.commands.get("ccstyle").handler("off", h.ctx);
		await h.commands.get("ccstyle").handler("compact", h.ctx);
		assert.match(h.render().join("\n"), /Ran for 2s, Ran shell 1 time/);
		t.mock.timers.tick(10_000);
		await h.emit("agent_settled", { type: "agent_settled" });
		assert.match(h.render().join("\n"), /Ran for 2s, Ran shell 1 time/);
	} finally { await h.close(); }
});

test("a cancelled run settles as cancelled work, not completed work", async (t) => {
	const h = await harness({ mode: "compact" });
	t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
	try {
		await h.emit("agent_start", { type: "agent_start" });
		h.root.addChild(new AssistantMessageComponent(assistantMessage([
			{ type: "toolCall", name: "bash", id: "check", arguments: { command: "local check" } },
		], Date.now()), true));
		h.render();
		t.mock.timers.tick(2_000);
		await h.emit("agent_settled", { type: "agent_settled", aborted: true });
		assert.match(h.render().join("\n"), /Cancelled after 2s, Ran shell 1 time/);
	} finally { await h.close(); }
});

test("work summaries count recorded objects and retain unclassified or argumentless calls", async () => {
	const h = await harness({ mode: "compact", columns: 300 });
	try {
		h.root.addChild(new AssistantMessageComponent(assistantMessage([
			{ type: "toolCall", name: "read", id: "r1", arguments: { path: "src/a.ts", offset: 1, limit: 4 } },
			{ type: "toolCall", name: "read", id: "r2", arguments: { path: "src/a.ts", offset: 5, limit: 8 } },
			{ type: "toolCall", name: "tools.read", id: "r3", arguments: { path: "./src/a.ts" } },
			{ type: "toolCall", name: "read", id: "r4", arguments: {} },
			{ type: "toolCall", name: "grep", id: "g1", arguments: { pattern: "needle", path: "src" } },
			{ type: "toolCall", name: "find", id: "g2", arguments: { pattern: "needle", path: "test" } },
			{ type: "toolCall", name: "find", id: "g3", arguments: { pattern: "*.ts" } },
			{ type: "toolCall", name: "grep", id: "g4", arguments: {} },
			{ type: "toolCall", name: "ls", id: "l1", arguments: { path: "src" } },
			{ type: "toolCall", name: "ls", id: "l2", arguments: { path: "src" } },
			{ type: "toolCall", name: "ls", id: "l3", arguments: { path: "./src" } },
			{ type: "toolCall", name: "ls", id: "l4", arguments: {} },
			{ type: "toolCall", name: "bash", id: "b1", arguments: { command: "read other.ts" } },
			{ type: "toolCall", name: "powershell", id: "b2", arguments: { command: "Get-Content other.ts" } },
			{ type: "toolCall", name: "write", id: "w1", arguments: { path: "out.ts", content: "result" } },
			{ type: "toolCall", name: "unknown", id: "u1", arguments: {} },
		], 100), true));
		const summary = h.render().find((line) => line.includes("click to show more"))!;
		assert.equal(summary.trim(), "Searched for 2 patterns, Read 2 files, Listed 2 directories, Ran shell 2 times, Used read 1 time, Used grep 1 time, Used ls 1 time, Used write 1 time, Used unknown 1 time • click to show more");
	} finally { await h.close(); }
});

test("streaming Thinking entries count once and identical timestamps do not merge entries", async () => {
	const h = await harness({ mode: "compact", columns: 180 });
	try {
		const component = new AssistantMessageComponent(assistantMessage([
			{ type: "thinking", thinking: "First observation" },
			{ type: "thinking", thinking: "  " },
		], 100), true);
		h.root.addChild(component);
		assert.match(h.render().join("\n"), /Thought 1 time • click to show more/);
		component.updateContent(assistantMessage([
			{ type: "thinking", thinking: "First observation, extended while streaming" },
			{ type: "thinking", thinking: "Second observation" },
		], 100), true);
		component.updateContent(assistantMessage([
			{ type: "thinking", thinking: "First observation, finished" },
			{ type: "thinking", thinking: "Second observation, finished" },
		], 100), false);
		h.root.addChild(new AssistantMessageComponent(assistantMessage([
			{ type: "thinking", thinking: "Different message at the exact same timestamp" },
			{ type: "toolCall", name: "read", id: "read", arguments: { path: "source.ts" } },
		], 100), true));
		const summaries = h.render().filter((line) => line.includes("click to show more"));
		assert.equal(summaries.length, 1);
		assert.match(summaries[0]!, /Thought 3 times, Read 1 file/);
	} finally { await h.close(); }
});

test("Thinking counts stay current as prose streams and restore from the mixed saved message", async () => {
	const h = await harness({ mode: "compact", columns: 180 });
	try {
		const initial = assistantMessage([{ type: "thinking", thinking: "First recorded thought" }], 100);
		const component = new AssistantMessageComponent(initial, true);
		h.root.addChild(component);
		const final = assistantMessage([
			{ type: "thinking", thinking: "First recorded thought, extended" },
			{ type: "thinking", thinking: "Second recorded thought" },
			{ type: "text", text: "Answer outside the process card." },
		], 100);
		component.updateContent(final, true);
		component.updateContent(final, false);
		const assertSummary = () => {
			const lines = h.render();
			assert.equal(lines.filter((line) => line.includes("click to show more")).length, 1, lines.join("\n"));
			assert.match(lines.join("\n"), /Thought 2 times • click to show more/);
			assert.equal(lines.filter((line) => line.trim() === "Answer outside the process card.").length, 1);
		};
		assertSummary();
		h.ctx.sessionManager.buildSessionProjection = () => ({ messages: [final] });
		h.root.clear();
		h.root.addChild(new AssistantMessageComponent(final, true));
		await h.emit("session_start", { type: "session_start" });
		assertSummary();
		const lines = h.render();
		const row = lines.findIndex((line) => line.includes("click to show more"));
		h.click(lines[row]!.indexOf("click to show more") + 1, row);
		const expanded = h.render().join("\n");
		assert.match(expanded, /Second recorded thought/);
		assert.equal(expanded.split("Answer outside the process card.").length - 1, 1);
	} finally { await h.close(); }
});

test("replacing Thinking with prose removes stale counts without resetting the work clock", async (t) => {
	const h = await harness({ mode: "compact", columns: 180 });
	t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
	try {
		await h.emit("agent_start", { type: "agent_start" });
		const timestamp = Date.now();
		const component = new AssistantMessageComponent(assistantMessage([
			{ type: "thinking", thinking: "An earlier stream fragment" },
		], timestamp), true);
		h.root.addChild(component);
		assert.match(h.render().join("\n"), /Thought 1 time/);
		t.mock.timers.tick(2_000);
		component.updateContent(assistantMessage([
			{ type: "text", text: "Only the current recorded prose remains." },
		], timestamp), true);
		let lines = h.render();
		assert.match(lines.join("\n"), /Running.*2s/);
		assert.doesNotMatch(lines.join("\n"), /Thought|earlier stream fragment/);
		assert.equal(lines.filter((line) => line.includes("click to show more")).length, 1);
		await h.emit("agent_settled", { type: "agent_settled", aborted: false });
		lines = h.render();
		assert.match(lines.join("\n"), /Ran for 2s/);
		assert.doesNotMatch(lines.join("\n"), /Thought|earlier stream fragment/);
		assert.equal(lines.filter((line) => line.trim() === "Only the current recorded prose remains.").length, 1);
	} finally { await h.close(); }
});

test("replayed user messages separate work groups with coincident message timestamps", async () => {
	const h = await harness({ mode: "compact", columns: 180 });
	try {
		const replay = () => {
			h.root.clear();
			h.root.addChild(new AssistantMessageComponent(assistantMessage([
				{ type: "toolCall", name: "read", id: "before", arguments: { path: "before.ts" } },
			], 100), true));
			h.root.addChild(new UserMessageComponent("Now inspect the next request."));
			h.root.addChild(new AssistantMessageComponent(assistantMessage([
				{ type: "toolCall", name: "bash", id: "after", arguments: { command: "local-check" } },
			], 100), true));
		};
		for (let i = 0; i < 2; i++) {
			replay();
			const lines = h.render();
			const summaries = lines.filter((line) => line.includes("click to show more"));
			assert.equal(summaries.length, 2, lines.join("\n"));
			assert.match(summaries[0]!, /Read 1 file/);
			assert.doesNotMatch(summaries[0]!, /Ran shell/);
			assert.match(summaries[1]!, /Ran shell 1 time/);
			assert.doesNotMatch(summaries[1]!, /Read/);
			assert.ok(lines.findIndex((line) => line.includes("Read 1 file")) < lines.findIndex((line) => line.includes("Now inspect")));
		}
	} finally { await h.close(); }
});

test("expanding a child in a multi-assistant work group retains all process members", async () => {
	const h = await harness({ mode: "compact", columns: 180, rows: 48 });
	try {
		for (const [id, path] of [["alpha", "alpha.ts"], ["beta", "beta.ts"]]) {
			h.root.addChild(new AssistantMessageComponent(assistantMessage([
				{ type: "toolCall", name: "read", id, arguments: { path } },
			], 100), true));
			h.tool("read", id!, { path }, { content: [{ type: "text", text: `${id} output body` }], isError: false });
		}
		let lines = h.render();
		let row = lines.findIndex((line) => line.includes("Read 2 files"));
		h.click(lines[row]!.indexOf("click to show more") + 1, row);
		lines = h.render();
		assert.match(lines.join("\n"), /alpha\.ts/);
		assert.match(lines.join("\n"), /beta\.ts/);
		row = lines.findIndex((line) => line.includes("1 line loaded") && line.includes("click to show more"));
		assert.ok(row >= 0, lines.join("\n"));
		h.click(lines[row]!.indexOf("click to show more") + 1, row);
		lines = h.render();
		assert.match(lines.join("\n"), /alpha output body/);
		assert.match(lines.join("\n"), /beta\.ts/);
		assert.doesNotMatch(lines.join("\n"), /Read 2 files • click to show more/);
	} finally { await h.close(); }
});

test("public nested observations deduplicate final records and update the parent's earlier group", async () => {
	const h = await harness({ mode: "compact", columns: 250 });
	try {
		const first = assistantMessage([
			{ type: "toolCall", name: "codemode", id: "script", arguments: { code: "recorded script" } },
			{ type: "toolCall", name: "read", id: "top", arguments: { path: "shared.ts" } },
		], 100);
		h.root.addChild(new AssistantMessageComponent(first, true));
		await h.emit("tool_execution_start", { type: "tool_execution_start", toolCallId: "late",
			toolName: "read", args: { path: "late.ts" }, parentToolCallId: "nested-shell" });
		assert.match(h.render().join("\n"), /Read 1 file, Used codemode 1 time/);
		const calls = [
			{ toolCallId: "nested-read", toolName: "read", args: { path: "shared.ts", offset: 80 }, parentToolCallId: "script" },
			{ toolCallId: "nested-search", toolName: "find", args: { pattern: "needle", path: "src" }, parentToolCallId: "script" },
			{ toolCallId: "nested-shell", toolName: "bash", args: { command: "local-check" }, parentToolCallId: "script" },
		];
		for (const call of calls) {
			await h.emit("tool_execution_start", { type: "tool_execution_start", ...call });
			await h.emit("tool_execution_update", { type: "tool_execution_update", ...call, partialResult: { content: [] } });
			await h.emit("tool_execution_end", { type: "tool_execution_end", ...call, result: { content: [] }, isError: true });
		}
		const expectedLive = /Searched for 1 pattern, Read 2 files, Ran shell 1 time, Used codemode 1 time/;
		assert.match(h.render().join("\n"), expectedLive);
		h.ctx.sessionManager.buildSessionProjection = () => ({ messages: [first] });
		await h.commands.get("ccstyle").handler("off", h.ctx);
		await h.commands.get("ccstyle").handler("compact", h.ctx);
		assert.match(h.render().join("\n"), expectedLive);
		await h.emit("message_start", { type: "message_start", message: { role: "user", content: "Next request" } });
		h.root.addChild(new UserMessageComponent("Next request"));
		h.root.addChild(new AssistantMessageComponent(assistantMessage([
			{ type: "toolCall", name: "read", id: "next", arguments: { path: "next.ts" } },
		], 100), true));
		await h.emit("tool_execution_start", { type: "tool_execution_start", toolCallId: "late",
			toolName: "read", args: { path: "late.ts" }, parentToolCallId: "nested-shell" });
		const result = { role: "toolResult", toolCallId: "script", toolName: "codemode", content: [], timestamp: 101, isError: true,
			nestedCalls: { complete: false, calls: [
				...calls.map((call) => ({ id: call.toolCallId, name: call.toolName, arguments: call.args, status: "error" })),
				{ id: "argumentless", name: "ls", argumentsBytes: 40000, status: "unfinished" },
			] } };
		await h.emit("message_end", { type: "message_end", message: result });
		await h.emit("message_end", { type: "message_end", message: result });
		const summaries = h.render().filter((line) => line.includes("click to show more"));
		assert.equal(summaries.length, 2);
		assert.match(summaries[0]!, /Searched for 1 pattern, Read 2 files, Ran shell 1 time, Used codemode 1 time, Used ls 1 time, partial records/);
		assert.match(summaries[1]!, /Read 1 file/);
		assert.doesNotMatch(summaries[1]!, /Searched|shell|codemode|partial/);
		assert.doesNotMatch(summaries.join("\n"), /success|failed|error/i);
	} finally { await h.close(); }
});

test("saved nested records restore after navigation and reload without duplicated operations", async () => {
	const h = await harness({ mode: "compact", columns: 250 });
	try {
		const message = assistantMessage([
			{ type: "toolCall", name: "codemode", id: "saved-parent", arguments: { code: "saved script" } },
			{ type: "toolCall", name: "read", id: "saved-top", arguments: { path: "same.ts" } },
		], 100);
		const result = { role: "toolResult", toolCallId: "saved-parent", toolName: "codemode", content: [], timestamp: 101, isError: false,
			nestedCalls: { complete: false, calls: [
				{ id: "saved-read", name: "tools.read", arguments: { path: "same.ts", limit: 5 }, status: "ok" },
				{ id: "saved-grep", name: "grep", arguments: { pattern: "needle", path: "src" }, status: "error" },
				{ id: "saved-find", name: "find", arguments: { pattern: "needle", path: "test" }, status: "ok" },
				{ id: "saved-edit", name: "edit", arguments: { path: "same.ts" }, status: "ok" },
				{ id: "saved-omitted", name: "read", argumentsBytes: 40000, status: "unfinished" },
			] } };
		h.ctx.sessionManager.buildSessionProjection = () => ({ messages: [message, result] });
		h.root.addChild(new AssistantMessageComponent(message, true));
		await h.emit("session_tree", { type: "session_tree" });
		const expected = "Searched for 1 pattern, Read 1 file, Used codemode 1 time, Used edit 1 time, Used read 1 time, partial records";
		const assertRestored = () => {
			const summaries = h.render().filter((line) => line.includes("click to show more"));
			assert.equal(summaries.length, 1);
			assert.ok(summaries[0]!.includes(expected), summaries.join("\n"));
		};
		assertRestored();
		await h.emit("session_tree", { type: "session_tree" });
		assertRestored();
		await h.emit("session_start", { type: "session_start" });
		assertRestored();
		await h.commands.get("ccstyle").handler("off", h.ctx);
		await h.commands.get("ccstyle").handler("compact", h.ctx);
		assertRestored();
	} finally { await h.close(); }
});

test("navigation replaces saved nested records and removes absent operations and partial markers", async () => {
	const h = await harness({ mode: "compact", columns: 250 });
	try {
		const message = assistantMessage([
			{ type: "toolCall", name: "codemode", id: "branch-parent", arguments: { code: "saved script" } },
		], 100);
		const result = { role: "toolResult", toolCallId: "branch-parent", toolName: "codemode", content: [], timestamp: 101, isError: false,
			nestedCalls: { complete: false, calls: [
				{ id: "branch-read", name: "read", arguments: { path: "old.ts" }, status: "ok" },
				{ id: "branch-shell", name: "bash", arguments: { command: "old-check" }, status: "ok" },
			] } };
		h.root.addChild(new AssistantMessageComponent(message, true));
		h.ctx.sessionManager.buildSessionProjection = () => ({ messages: [message, result] });
		await h.emit("session_tree", { type: "session_tree" });
		assert.match(h.render().join("\n"), /Read 1 file, Ran shell 1 time, Used codemode 1 time, partial records/);
		const selectedResult = { ...result, nestedCalls: { complete: true, calls: [
			{ id: "selected-pattern", name: "find", arguments: { pattern: "*.ts" }, status: "ok" },
		] } };
		h.ctx.sessionManager.buildSessionProjection = () => ({ messages: [message, selectedResult] });
		await h.emit("session_tree", { type: "session_tree" });
		let lines = h.render().join("\n");
		assert.match(lines, /Searched for 1 pattern, Used codemode 1 time/);
		assert.doesNotMatch(lines, /Read 1 file|Ran shell|partial records/);
		h.ctx.sessionManager.buildSessionProjection = () => ({ messages: [message] });
		await h.emit("session_tree", { type: "session_tree" });
		lines = h.render().join("\n");
		assert.match(lines, /Used codemode 1 time/);
		assert.doesNotMatch(lines, /Searched|Read|Ran shell|partial records/);
	} finally { await h.close(); }
});

test("the semantic tail stays a single width-safe line with recorded tool names and resizing", async () => {
	const h = await harness({ mode: "compact", columns: 180 });
	try {
		const name = "custom\t界🙂\ncontinued\x1b[31m";
		h.root.addChild(new AssistantMessageComponent(assistantMessage([
			{ type: "toolCall", name, id: "named-call", arguments: {} },
			{ type: "toolCall", name: "read", id: "known-path", arguments: { path: "wide/界🙂.ts" } },
		], 100), true));
		const wide = h.render();
		const tails = wide.filter((line) => line.includes("click to show more"));
		assert.equal(tails.length, 1);
		assert.equal(tails[0]!.trim(), "Read 1 file, Used custom 界🙂 continued 1 time • click to show more");
		for (const columns of [80, 40, 18, 8]) {
			h.terminal.columns = columns;
			const lines = h.render();
			for (const line of lines) {
				assert.doesNotMatch(line, /[\n\r\t]/);
				assert.ok(visibleWidth(line) <= columns, `${visibleWidth(line)} cells exceeds ${columns}: ${line}`);
			}
			const visibleTails = lines.filter((line) => line.includes("click to show more"));
			assert.equal(visibleTails.length, columns >= 40 ? 1 : 0);
		}
	} finally { await h.close(); }
});
