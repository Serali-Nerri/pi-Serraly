import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, CustomMessageComponent } from "@earendil-works/pi-coding-agent";
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
			assert.ok(lines.some((line) => /Running.*read×1/.test(line)), lines.join("\n"));
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
		assert.match(h.render().join("\n"), /Running.*2s.*read×1/);
		await h.emit("agent_start", { type: "agent_start" });
		t.mock.timers.tick(3_000);
		await h.emit("agent_settled", { type: "agent_settled" });
		const settled = h.render();
		assert.match(settled.join("\n"), /Provisional response retained/);
		assert.match(settled.join("\n"), /Ran for 5s, read×1/);
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
		assert.match(h.render().join("\n"), /Running\.\.\. · 1s, read×1, bash×1/);
		await h.emit("ui_prompt_end", { type: "ui_prompt_end", reason: "ui_prompt", kind: "input", title: "Choose" });
		t.mock.timers.tick(2_000);
		await h.emit("agent_settled", { type: "agent_settled" });
		assert.match(h.render().join("\n"), /Ran for 3s, read×1, bash×1/);
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
		assert.match(h.render().join("\n"), /Running\.\.\. · 8s, read×1/);
		await h.emit("agent_settled", { type: "agent_settled" });
		assert.match(h.render().join("\n"), /Ran for 8s, read×1/);
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
		assert.match(visible, /bash×1/);
		assert.doesNotMatch(visible, /read×1|old-project/);
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

test("request background stays in the current group while standalone notifications divide groups", async (t) => {
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
		const background: any = { role: "custom", customType: "session-reference", display: true,
			content: "REQUEST BACKGROUND", details: { requestBackground: true }, timestamp: Date.now() };
		await h.emit("message_start", { type: "message_start", message: background });
		h.root.addChild(new CustomMessageComponent(background));
		addCall("grep", "second");
		assert.match(h.render().join("\n"), /bash×1, grep×1/);
		const notification: any = { role: "custom", customType: "test-notification", display: true,
			content: "STANDALONE NOTIFICATION", timestamp: Date.now() };
		await h.emit("message_start", { type: "message_start", message: notification });
		h.root.addChild(new CustomMessageComponent(notification));
		t.mock.timers.tick(1_000);
		addCall("find", "third");
		const visible = h.render();
		const summaries = visible.filter((line) => line.includes("click to show more"));
		assert.equal(summaries.length, 2, visible.join("\n"));
		assert.match(summaries[0]!, /bash×1, grep×1/);
		assert.doesNotMatch(summaries[0]!, /find×1/);
		assert.match(summaries[1]!, /Running.*find×1/);
		assert.doesNotMatch(summaries[1]!, /bash×1|grep×1/);
		assert.match(visible.join("\n"), /REQUEST BACKGROUND/);
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
		assert.match(summaries[0]!, /Ran for 1s, bash×1/);
		assert.match(summaries[1]!, /Running.*2s, grep×1/);
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
		assert.match(settled.join("\n"), /Ran for 3s, bash×1/);
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
		assert.match(h.render().join("\n"), /Running.*3s.*read×1/);
		t.mock.timers.tick(3_000);
		await h.emit("agent_settled", { type: "agent_settled" });
		assert.match(h.render().join("\n"), /Ran for 6s, read×1/);
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
		const summaries = h.render().filter((line) => /bash×1|read×1/.test(line));
		assert.equal(summaries.length, 1);
		assert.match(summaries[0]!, /Ran for 3s, bash×1, read×1/);
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
		const summaries = h.render().filter((line) => /bash×1|read×1/.test(line));
		assert.equal(summaries.length, 1);
		assert.match(summaries[0]!, /Running.*3s, bash×1, read×1/);
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
		const summaries = h.render().filter((line) => /bash×1|grep×1/.test(line));
		assert.equal(summaries.length, 2);
		assert.match(summaries[0]!, /Ran for 1s, bash×1/);
		assert.match(summaries[1]!, /Running.*3s, grep×1/);
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
		assert.match(h.render().join("\n"), /Running.*11s, bash×1/);
		await h.emit("agent_start", { type: "agent_start" });
		h.root.addChild(new AssistantMessageComponent(assistantMessage([
			{ type: "toolCall", name: "read", id: "continued", arguments: { path: "source.ts" } },
		], Date.now()), true));
		t.mock.timers.tick(2_000);
		await h.emit("agent_settled", { type: "agent_settled" });
		assert.match(h.render().join("\n"), /Ran for 13s, bash×1, read×1/);
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
		const summaries = h.render().filter((line) => /bash×1|read×1/.test(line));
		assert.equal(summaries.length, 1);
		assert.match(summaries[0]!, /Running.*3s, bash×1, read×1/);
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
		assert.match(h.render().join("\n"), /Ran for 2s, bash×1/);
		t.mock.timers.tick(10_000);
		await h.emit("agent_settled", { type: "agent_settled" });
		assert.match(h.render().join("\n"), /Ran for 2s, bash×1/);
	} finally { await h.close(); }
});
