import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import { harness, strip } from "./harness.ts";

function answer(text: string): AssistantMessageComponent {
	const message: AssistantMessage = {
		role: "assistant", content: [{ type: "text", text }], timestamp: Date.now(), stopReason: "stop",
		api: "openai-responses", provider: "openai", model: "fixture",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
	return new AssistantMessageComponent(message, false);
}

test("completion appears below the final answer only after the whole main activity settles", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 0, 2, 14, 29, 50).getTime() });
	const h = await harness();
	try {
		await h.emit("agent_start", { type: "agent_start" });
		t.mock.timers.tick(2_000);
		h.root.addChild(answer("Provisional response."));
		await h.emit("agent_end", { type: "agent_end", messages: [] });
		assert.doesNotMatch(h.render().join("\n"), /\d{2}:\d{2}:\d{2}/);
		await h.emit("agent_start", { type: "agent_start" });
		t.mock.timers.tick(136_000);
		h.root.addChild(answer("Final response."));
		await h.emit("agent_settled", { type: "agent_settled", aborted: false });
		const lines = h.render();
		const completion = lines.findIndex((line) => line.includes("14:32:08"));
		assert.equal(lines[completion]!.trim(), "Worked for 2m 18s · 14:32:08");
		assert.ok(completion > lines.findIndex((line) => line.includes("Final response.")));
		assert.equal(lines.filter((line) => line.includes("14:32:08")).length, 1);
		t.mock.timers.tick(60_000);
		await h.emit("agent_settled", { type: "agent_settled", aborted: false });
		assert.deepEqual(h.render(), lines, "the completed record stays frozen and is not duplicated");
		t.mock.timers.setTime(new Date(2026, 0, 3, 1, 0, 0).getTime());
		assert.ok(h.render().some((line) => line.trim() === "Worked for 2m 18s · 2026-01-02 14:32:08"));
	} finally { await h.close(); }
});

test("work time excludes overlapping user prompts without summing parallel tool times", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 0, 2, 14, 0, 0).getTime() });
	const h = await harness({ mode: "compact" });
	try {
		await h.emit("agent_start", { type: "agent_start" });
		for (const toolCallId of ["one", "two"]) {
			await h.emit("tool_execution_start", { type: "tool_execution_start", toolCallId, toolName: "bash", args: {} });
		}
		t.mock.timers.tick(1_000);
		await h.emit("ui_prompt_start", { type: "ui_prompt_start", kind: "input", title: "First" });
		t.mock.timers.tick(10_000);
		await h.emit("ui_prompt_start", { type: "ui_prompt_start", kind: "confirm", title: "Second" });
		t.mock.timers.tick(5_000);
		await h.emit("ui_prompt_end", { type: "ui_prompt_end", kind: "input", title: "First" });
		t.mock.timers.tick(5_000);
		await h.emit("ui_prompt_end", { type: "ui_prompt_end", kind: "confirm", title: "Second" });
		t.mock.timers.tick(2_000);
		await h.emit("agent_settled", { type: "agent_settled", aborted: false });
		assert.ok(h.render().some((line) => line.trim() === "Worked for 3s · 14:00:23"));
	} finally { await h.close(); }
});

for (const mode of ["on", "compact", "off"] as const) {
	for (const tuiMode of ["regular", "fullscreen"] as const) {
		test(`${mode}/${tuiMode}: timing stays right-aligned below the activity on resize, including manual stops`, async (t) => {
			t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 0, 2, 23, 59, 58).getTime() });
			const h = await harness({ mode, tuiMode });
			try {
				await h.emit("agent_start", { type: "agent_start" });
				t.mock.timers.tick(1_000);
				await h.emit("ui_prompt_start", { type: "ui_prompt_start", kind: "input", title: "Waiting" });
				t.mock.timers.tick(3_000);
				await h.emit("agent_settled", { type: "agent_settled", aborted: true });
				assert.ok(h.render().some((line) => line.trim() === "Worked for 1s · 00:00:02"));
				for (const [columns, expected] of [
					[32, "        Worked for 1s · 00:00:02"],
					[12, "Worked for …"],
					[1, "…"],
					[100, " ".repeat(76) + "Worked for 1s · 00:00:02"],
				] as const) {
					h.terminal.columns = columns;
					const lines = h.render();
					for (const line of lines) assert.ok(visibleWidth(line) <= columns, line);
					assert.ok(h.root.render(columns).map(strip).includes(expected),
						`timing must end at the content area's right edge at ${columns} columns`);
					if (columns === 100) assert.ok(lines.some((line) => line.trim() === "Worked for 1s · 00:00:02"));
				}
			} finally { await h.close(); }
		});
	}
}

test("navigation and session replacement discard unfinished work instead of fabricating completions", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 0, 2, 14, 0, 0).getTime() });
	const h = await harness();
	try {
		for (const boundary of ["session_tree", "session_start", "session_shutdown"]) {
			await h.emit("agent_start", { type: "agent_start" });
			t.mock.timers.tick(1_000);
			await h.emit(boundary);
			await h.emit("agent_settled", { type: "agent_settled", aborted: false });
			assert.doesNotMatch(h.render().join("\n"), /\d{2}:\d{2}:\d{2}/);
			assert.equal(h.entries.filter((entry) => entry.customType === "pi-ui-activity-completion").length, 0);
		}
	} finally { await h.close(); }
});

test("headless sessions do not write presentation-only completion metadata", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 0, 2, 14, 0, 0).getTime() });
	const h = await harness({ headless: true });
	try {
		await h.emit("agent_start", { type: "agent_start" });
		t.mock.timers.tick(1_000);
		await h.emit("agent_settled", { type: "agent_settled", aborted: false });
		assert.equal(h.entries.filter((entry) => entry.customType === "pi-ui-activity-completion").length, 0);
	} finally { await h.close(); }
});
