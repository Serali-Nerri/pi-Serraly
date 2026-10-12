import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { harness } from "./harness.ts";

const message = (content: any[], timestamp: number) => ({
	role: "assistant", content, timestamp, stopReason: "toolUse",
	api: "openai-responses", provider: "fixture", model: "fixture",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
}) as any;

const result = (text: string, details?: unknown) => ({
	content: [{ type: "text", text }], isError: false, details,
});

function assertOrder(lines: string[], expected: string[]): void {
	let previous = -1;
	for (const text of expected) {
		const row = lines.findIndex((line) => line.includes(text));
		assert.ok(row > previous, `${text} must follow ${expected[expected.indexOf(text) - 1] ?? "the start"}:\n${lines.join("\n")}`);
		if (!text.endsWith(".ts") || text.startsWith("ORDER_READ_")) {
			assert.equal(lines.filter((line) => line.includes(text)).length, 1, `${text} appears once`);
		}
		previous = row;
	}
}

test("compact expansion restores interleaved process and file cards at their native transcript positions", async (t) => {
	const h = await harness({ mode: "compact", columns: 200, rows: 100 });
	t.mock.timers.enable({ apis: ["Date"], now: 1_900_000_000_000 });
	try {
		await h.emit("agent_start", { type: "agent_start" });
		const timestamp = Date.now();
		let next = 0;
		const assistant = (content: any[]) => {
			const component = new AssistantMessageComponent(message(content, timestamp + next++), true);
			h.root.addChild(component);
			return component;
		};
		assistant([
			{ type: "thinking", thinking: "ORDER_THINKING_FIRST" },
			{ type: "toolCall", name: "read", id: "read-first", arguments: { path: "ORDER_READ_FIRST.ts" } },
		]);
		h.tool("read", "read-first", { path: "ORDER_READ_FIRST.ts" }, result("read body one"));
		assistant([{ type: "text", text: "ORDER_PROGRESS_WRITE" }]);
		assistant([{ type: "toolCall", name: "write", id: "write", arguments: { path: "ORDER_WRITE.ts", content: "saved line" } }]);
		h.tool("write", "write", { path: "ORDER_WRITE.ts", content: "saved line" }, result("saved"));
		assistant([
			{ type: "thinking", thinking: "ORDER_THINKING_SECOND" },
			{ type: "toolCall", name: "read", id: "read-second", arguments: { path: "ORDER_READ_SECOND.ts" } },
		]);
		h.tool("read", "read-second", { path: "ORDER_READ_SECOND.ts" }, result("read body two"));
		assistant([{ type: "text", text: "ORDER_PROGRESS_EDIT" }]);
		assistant([{ type: "toolCall", name: "edit", id: "edit", arguments: { path: "ORDER_EDIT.ts", oldText: "old", newText: "new" } }]);
		h.tool("edit", "edit", { path: "ORDER_EDIT.ts", oldText: "old", newText: "new" },
			result("edited", { diff: "-1 old\n+1 new" }));
		assistant([{ type: "text", text: "ORDER_PROGRESS_PATCH" }]);
		const patchInput = "*** Begin Patch\n*** Update File: ORDER_PATCH.ts\n@@\n-old\n+new\n*** End Patch";
		assistant([{ type: "toolCall", name: "apply_patch", id: "patch", arguments: { input: patchInput } }]);
		const facts = { exists: true, bytes: 4, lines: 1, bom: false, endings: { lf: 1, crlf: 0, cr: 0 }, finalNewline: true };
		h.tool("apply_patch", "patch", { input: patchInput }, result("patched", {
			format: "apply_patch.v1",
			changes: [{ kind: "update", path: "ORDER_PATCH.ts", views: [{
				role: "file", before: facts, after: facts, added: 1, removed: 1,
				diff: "-1 old\n+1 new", availability: "complete", lineEndingsChanged: false,
			}] }],
		}), { name: "apply_patch", label: "apply_patch" });
		assistant([{ type: "thinking", thinking: "ORDER_THINKING_FINAL" }, { type: "text", text: "ORDER_FINAL_ANSWER" }]);
		await h.emit("agent_settled", { type: "agent_settled" });

		let lines = h.render();
		const summary = lines.find((line) => line.includes("Thought 3 times"))!;
		assert.match(summary, /Read 2 files, Used write 1 time, Used edit 1 time, Used apply_patch 1 time/);
		assertOrder(lines, ["ORDER_PROGRESS_WRITE", "ORDER_WRITE.ts", "ORDER_PROGRESS_EDIT",
			"ORDER_EDIT.ts", "ORDER_PROGRESS_PATCH", "ORDER_PATCH.ts", "ORDER_FINAL_ANSWER"]);
		assert.ok(!lines.some((line) => line.includes("ORDER_THINKING_FIRST")));
		assert.ok(!lines.some((line) => line.includes("ORDER_READ_SECOND.ts")));
		const fileCounts = new Map(["ORDER_WRITE.ts", "ORDER_EDIT.ts", "ORDER_PATCH.ts"]
			.map((path) => [path, lines.filter((line) => line.includes(path)).length]));

		const expected = ["ORDER_THINKING_FIRST", "ORDER_READ_FIRST.ts", "ORDER_PROGRESS_WRITE",
			"ORDER_WRITE.ts", "ORDER_THINKING_SECOND", "ORDER_READ_SECOND.ts", "ORDER_PROGRESS_EDIT",
			"ORDER_EDIT.ts", "ORDER_PROGRESS_PATCH", "ORDER_PATCH.ts", "ORDER_THINKING_FINAL", "ORDER_FINAL_ANSWER"];
		for (let toggle = 0; toggle < 3; toggle++) {
			const row = lines.findIndex((line) => line === summary);
			assert.ok(row >= 0, lines.join("\n"));
			t.mock.timers.tick(1_000);
			h.click(lines[row]!.indexOf("click to show more") + 1, row);
			lines = h.render();
			assertOrder(lines, expected);
			for (const [path, count] of fileCounts) {
				assert.equal(lines.filter((line) => line.includes(path)).length, count, `${path} retains its native card without duplicates`);
			}
			assert.ok(!lines.some((line) => line === summary));
			const thought = lines.findIndex((line) => line.includes("ORDER_THINKING_FIRST"));
			// Distinct body clicks are not the host's double-click word selection.
			t.mock.timers.tick(1_000);
			h.click(lines[thought]!.indexOf("ORDER_THINKING_FIRST") + 1, thought);
			lines = h.render();
			assert.equal(lines.filter((line) => line === summary).length, 1, `group collapse restores the same summary:\n${lines.join("\n")}`);
			assertOrder(lines, ["ORDER_PROGRESS_WRITE", "ORDER_WRITE.ts", "ORDER_PROGRESS_EDIT",
				"ORDER_EDIT.ts", "ORDER_PROGRESS_PATCH", "ORDER_PATCH.ts", "ORDER_FINAL_ANSWER"]);
		}
	} finally { await h.close(); }
});

test("one message keeps process and file cards in recorded content order when expanded", async (t) => {
	const h = await harness({ mode: "compact", columns: 200, rows: 80 });
	t.mock.timers.enable({ apis: ["Date"], now: 1_900_000_200_000 });
	try {
		await h.emit("agent_start", { type: "agent_start" });
		const timestamp = Date.now();
		h.root.addChild(new AssistantMessageComponent(message([
			{ type: "thinking", thinking: "SAME_FIRST_THOUGHT" },
			{ type: "toolCall", name: "read", id: "same-read", arguments: { path: "SAME_READ.ts" } },
			{ type: "text", text: "SAME_PROGRESS" },
			{ type: "thinking", thinking: "SAME_SECOND_THOUGHT" },
			{ type: "toolCall", name: "write", id: "same-write", arguments: { path: "SAME_WRITE.ts", content: "saved line" } },
		], timestamp), true));
		h.tool("read", "same-read", { path: "SAME_READ.ts" }, result("same read body"));
		h.tool("write", "same-write", { path: "SAME_WRITE.ts", content: "saved line" }, result("saved"));
		await h.emit("agent_settled", { type: "agent_settled" });

		let lines = h.render();
		const summary = lines.find((line) => line.includes("Read 1 file") && line.includes("click to show more"));
		assert.ok(summary, lines.join("\n"));
		assert.ok(!lines.some((line) => line.includes("SAME_READ.ts")));
		assert.ok(lines.some((line) => line.includes("SAME_WRITE.ts")));

		const row = lines.findIndex((line) => line === summary);
		assert.ok(row >= 0, lines.join("\n"));
		t.mock.timers.tick(1_000);
		h.click(lines[row]!.indexOf("click to show more") + 1, row);
		lines = h.render();
		assertOrder(lines, ["SAME_FIRST_THOUGHT", "SAME_READ.ts", "SAME_PROGRESS",
			"SAME_SECOND_THOUGHT", "SAME_WRITE.ts"]);
		assert.equal(lines.filter((line) => line.includes("SAME_READ.ts")).length, 1);
	} finally { await h.close(); }
});

test("an expanded group admits newly mounted streaming tools without moving prose or file cards", async (t) => {
	const h = await harness({ mode: "compact", columns: 200, rows: 60 });
	t.mock.timers.enable({ apis: ["Date"], now: 1_900_000_100_000 });
	try {
		await h.emit("agent_start", { type: "agent_start" });
		const timestamp = Date.now();
		h.root.addChild(new AssistantMessageComponent(message([
			{ type: "thinking", thinking: "LIVE_FIRST_THOUGHT" },
			{ type: "toolCall", name: "read", id: "first", arguments: { path: "LIVE_FIRST.ts" } },
			{ type: "toolCall", name: "write", id: "file", arguments: { path: "LIVE_FILE.ts", content: "saved line" } },
		], timestamp), true));
		h.tool("read", "first", { path: "LIVE_FIRST.ts" }, result("first captured output"));
		h.tool("write", "file", { path: "LIVE_FILE.ts", content: "saved line" }, result("saved"));
		let lines = h.render();
		let row = lines.findIndex((line) => line.includes("Read 1 file") && line.includes("click to show more"));
		assert.ok(row >= 0, lines.join("\n"));
		h.click(lines[row]!.indexOf("click to show more") + 1, row);

		const partial = message([{ type: "thinking", thinking: "LIVE_SECOND_THOUGHT" },
			{ type: "text", text: "LIVE_PROGRESS_INITIAL" }], timestamp + 1);
		const streaming = new AssistantMessageComponent(partial, true);
		h.root.addChild(streaming);
		const declared = { ...partial, content: [...partial.content,
			{ type: "toolCall", name: "read", id: "late", arguments: { path: "LIVE_LATE.ts" } }] };
		streaming.updateContent(declared, true);
		const late = h.tool("read", "late", { path: "LIVE_LATE.ts" }, result("late captured output"));
		lines = h.render();
		assertOrder(lines, ["LIVE_FIRST_THOUGHT", "LIVE_FIRST.ts", "LIVE_FILE.ts",
			"LIVE_SECOND_THOUGHT", "LIVE_PROGRESS_INITIAL", "LIVE_LATE.ts"]);
		assert.ok(!lines.some((line) => line.includes("Running...") && line.includes("click to show more")));

		const grown = { ...declared, content: [declared.content[0],
			{ type: "text", text: "LIVE_PROGRESS_GROWN" }, declared.content[2]] };
		streaming.updateContent(grown, true);
		lines = h.render();
		assert.ok(!lines.some((line) => line.includes("LIVE_PROGRESS_INITIAL")));
		assertOrder(lines, ["LIVE_FIRST_THOUGHT", "LIVE_FIRST.ts", "LIVE_FILE.ts",
			"LIVE_SECOND_THOUGHT", "LIVE_PROGRESS_GROWN", "LIVE_LATE.ts"]);
		row = lines.findIndex((line, index) => line.includes("1 line loaded") && lines[index - 1]?.includes("LIVE_LATE.ts"));
		assert.ok(row >= 0, lines.join("\n"));
		h.click(lines[row]!.indexOf("click to show more") + 1, row);
		lines = h.render();
		assert.ok(lines.some((line) => line.includes("late captured output")));
		assertOrder(lines, ["LIVE_FIRST_THOUGHT", "LIVE_FIRST.ts", "LIVE_FILE.ts",
			"LIVE_SECOND_THOUGHT", "LIVE_PROGRESS_GROWN", "LIVE_LATE.ts"]);
		late.updateResult(result("late captured output\nsettled output"));
		await h.emit("agent_settled", { type: "agent_settled" });
		lines = h.render();
		assert.ok(lines.some((line) => line.includes("settled output")));
		t.mock.timers.tick(1_000);
		row = lines.findIndex((line) => line.includes("LIVE_FIRST_THOUGHT"));
		h.click(lines[row]!.indexOf("LIVE_FIRST_THOUGHT") + 1, row);
		lines = h.render();
		assert.ok(!lines.some((line) => line.includes("LIVE_LATE.ts") || line.includes("late captured output")));
		assert.equal(lines.filter((line) => /Thought 2 times, Read 2 files, Used write 1 time/.test(line)).length, 1);
		assertOrder(lines, ["LIVE_FILE.ts", "LIVE_PROGRESS_GROWN"]);
	} finally { await h.close(); }
});

for (const tuiMode of ["regular", "fullscreen"] as const) {
	test(`${tuiMode} navigation restores expanded history order while dedicated cards stay native`, async () => {
		const h = await harness({ mode: "compact", tuiMode, columns: 180, rows: 70, extensionFactories: [
			(pi) => pi.registerTool({
				name: "order_fixture", label: "Order fixture", description: "Native rendering boundary",
				parameters: Type.Object({}),
				async execute() { throw new Error("history rendering must not execute a tool"); },
				renderCall() { return new Text("NATIVE_DEDICATED_CALL", 0, 0); },
				renderResult() { return new Text("NATIVE_DEDICATED_RESULT", 0, 0); },
			}),
		] });
		try {
			const messages = [
				{ role: "user", content: "Replay task", timestamp: 90 },
				message([{ type: "thinking", thinking: "REPLAY_FIRST_THOUGHT" },
					{ type: "toolCall", name: "read", id: "first", arguments: { path: "REPLAY_FIRST.ts" } },
					{ type: "thinking", thinking: "REPLAY_SECOND_THOUGHT" },
					{ type: "text", text: "REPLAY_AFTER_FIRST" }], 100),
				message([{ type: "text", text: "REPLAY_WRITE_NOTE" },
					{ type: "toolCall", name: "write", id: "file", arguments: { path: "REPLAY_FILE.ts", content: "saved line" } }], 101),
				message([{ type: "thinking", thinking: "REPLAY_NATIVE_THOUGHT" },
					{ type: "toolCall", name: "order_fixture", id: "native", arguments: {} }], 102),
				message([{ type: "thinking", thinking: "REPLAY_LAST_THOUGHT" },
					{ type: "toolCall", name: "read", id: "last", arguments: { path: "REPLAY_LAST.ts" } }], 103),
				{ ...message([{ type: "text", text: "REPLAY_FINAL_ANSWER" }], 104), stopReason: "stop" },
			];
			h.ctx.sessionManager.buildSessionProjection = () => ({
				entries: [], messages, thinkingLevel: "off", model: null,
			});
			let expanded = true;
			h.ctx.ui.getToolsExpanded = () => expanded;
			let nativeLines: string[] | undefined;
			for (let navigation = 0; navigation < 3; navigation++) {
				h.root.clear();
				h.root.addChild(new UserMessageComponent("Replay task"));
				h.root.addChild(new AssistantMessageComponent(messages[1], true));
				h.tool("read", "first", { path: "REPLAY_FIRST.ts" }, result("first recorded body"));
				h.root.addChild(new AssistantMessageComponent(messages[2], true));
				h.tool("write", "file", { path: "REPLAY_FILE.ts", content: "saved line" }, result("saved"));
				h.root.addChild(new AssistantMessageComponent(messages[3], true));
				const dedicated = h.tool("order_fixture", "native", {}, result("retained native body"));
				nativeLines ??= dedicated.render(180);
				h.root.addChild(new AssistantMessageComponent(messages[4], true));
				h.tool("read", "last", { path: "REPLAY_LAST.ts" }, result("last recorded body"));
				h.root.addChild(new AssistantMessageComponent(messages[5], true));
				await h.emit("session_tree", { type: "session_tree" });
				const lines = h.render();
				assertOrder(lines, ["REPLAY_FIRST_THOUGHT", "REPLAY_FIRST.ts", "REPLAY_SECOND_THOUGHT",
					"REPLAY_AFTER_FIRST", "REPLAY_WRITE_NOTE", "REPLAY_FILE.ts", "REPLAY_NATIVE_THOUGHT",
					"NATIVE_DEDICATED_CALL", "NATIVE_DEDICATED_RESULT", "REPLAY_LAST_THOUGHT",
					"REPLAY_LAST.ts", "REPLAY_FINAL_ANSWER"]);
				assert.deepEqual(dedicated.render(180), nativeLines, "the group never takes over a dedicated renderer");
			}
			expanded = false;
			await h.emit("session_tree", { type: "session_tree" });
			const collapsed = h.render();
			assertOrder(collapsed, ["REPLAY_WRITE_NOTE", "REPLAY_FILE.ts", "NATIVE_DEDICATED_CALL",
				"NATIVE_DEDICATED_RESULT", "REPLAY_FINAL_ANSWER"]);
			assert.ok(!collapsed.some((line) => line.includes("REPLAY_LAST_THOUGHT") || line.includes("REPLAY_LAST.ts")));
			assert.equal(collapsed.filter((line) => line.includes("Read 1 file")).length, 2, "each historical group has one summary");
		} finally { await h.close(); }
	});
}
