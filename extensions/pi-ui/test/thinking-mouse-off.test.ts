import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent, BranchSummaryMessageComponent, CompactionSummaryMessageComponent,
	SkillInvocationMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Text, TuiMainScreen, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { setConfig } from "../src/config/config.ts";
import { resolveRendererPolicy } from "../src/compat/policy.ts";
import { setToolMouseTui } from "../src/overlays/mouse-state.ts";
import { ThinkingPreviewBlock } from "../src/transcript/thinking.ts";
import { setToolTuiFullscreen } from "../src/transcript/tool/show-more-hint.ts";
import { harness, strip } from "./harness.ts";

const action = "click to show more";
const thinking = Array.from({ length: 20 }, (_, index) => `THINKING_BODY_${index}`).join("\n");
function message(timestamp: number): AssistantMessage {
	return {
		role: "assistant", timestamp, content: [{ type: "thinking", thinking }],
		api: "openai-responses", provider: "fixture", model: "fixture", stopReason: "stop",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}
function thinkingBlock(assistant: any): ThinkingPreviewBlock {
	const block = assistant.contentContainer.children.find((child: unknown) => child instanceof ThinkingPreviewBlock);
	assert.ok(block instanceof ThinkingPreviewBlock, "hidden thinking mounts the independent preview, not a native MouseRegion");
	return block;
}
function target(lines: string[], text: string): { x: number; y: number } {
	const y = lines.findIndex((line) => line.includes(text));
	assert.ok(y >= 0, `missing ${text}:\n${lines.join("\n")}`);
	return { x: visibleWidth(lines[y]!.slice(0, lines[y]!.indexOf(text))), y };
}
function mouse(type: TuiMouseEvent["type"], x: number, y: number, height: number): TuiMouseEvent {
	return { type, button: type === "move" ? "none" : "left", x, y, screenX: x, screenY: y,
		width: 100, height, shift: false, alt: false, ctrl: false, clickCount: 1 };
}

test("fullscreen on → off: hidden Thinking keeps its title, hint hitbox, hover, expansion and collapse", async () => {
	const h = await harness({ mode: "on" });
	try {
		const assistant: any = new AssistantMessageComponent(message(1_001), true);
		assert.equal(assistant.hideThinkingBlock, true);
		h.root.addChild(assistant);
		assert.equal(thinkingBlock(assistant).expanded, false);
		assert.ok(h.render().some((line) => line.includes(action)));

		setConfig({ mode: "off" });
		await h.emit("session_tree");
		await h.flush();
		const block = thinkingBlock(assistant);
		assert.equal(h.tui.mode, "fullscreen");
		assert.equal(assistant.hideThinkingBlock, true, "tool/message styling must not reveal native thinking");
		let lines = h.render();
		let hint = target(lines, action);
		assert.match(lines[hint.y]!, /17 more lines/);
		assert.ok(!lines.some((line) => line.includes("THINKING_BODY_0")), "long thinking remains hidden");
		assert.ok(h.tui.previousScreen[hint.y].includes(h.ctx.ui.theme.fg("dim", action)));

		const title = target(lines, "Thought");
		h.click(title.x, title.y);
		lines = h.render();
		assert.ok(lines.some((line) => line.includes("THINKING_BODY_0")), "the title remains an independent off-mode action");
		const titleBody = target(lines, "THINKING_BODY_19");
		h.click(titleBody.x, titleBody.y);
		lines = h.render();
		hint = target(lines, action);

		// The adjacent prefix and closing ')' are outside the hint's cell hitbox.
		for (const x of [hint.x - 1, hint.x + visibleWidth(action)]) {
			h.pointer(x, hint.y, "move");
			h.render();
			assert.ok(h.tui.previousScreen[hint.y].includes(h.ctx.ui.theme.fg("dim", action)));
			h.click(x, hint.y);
			assert.equal(block.expanded, false, "clicks outside the hint must not expand Thinking");
		}
		h.pointer(hint.x, hint.y, "move");
		h.render();
		assert.ok(h.tui.previousScreen[hint.y].includes(h.ctx.ui.theme.fg("text", action)), "off-mode hover highlights the action");
		h.pointer(0, 0, "move");
		h.render();
		assert.ok(h.tui.previousScreen[hint.y].includes(h.ctx.ui.theme.fg("dim", action)), "leaving the hitbox clears hover");
		h.pointer(hint.x, hint.y, "move");
		h.click(hint.x, hint.y);
		assert.equal(block.expanded, true, "SGR press/release must expand through both off-mode gates");
		lines = h.render();
		assert.ok(!lines.some((line) => line.includes(action)));
		assert.ok(lines.some((line) => line.includes("THINKING_BODY_0")));
		const body = target(lines, "THINKING_BODY_19");
		h.click(body.x, body.y);
		assert.equal(block.expanded, false, "expanded Thinking collapses through the fullscreen dispatcher in off mode");
		lines = h.render();
		hint = target(lines, action);
		assert.ok(!lines.some((line) => line.includes("THINKING_BODY_0")));
		h.pointer(hint.x, hint.y, "move");
		h.render();
		assert.ok(h.tui.previousScreen[hint.y].includes(h.ctx.ui.theme.fg("text", action)), "re-collapsed Thinking stays interactive");
	} finally { await h.close(); }
});

test("off mode delegates an already-wrapped managed tool region to its native whole-body toggle", async () => {
	const h = await harness({ mode: "on" });
	try {
		const tool = h.tool("write", "off-fallback", { path: "fixture.txt", content: "body" },
			{ content: [{ type: "text", text: "written" }] });
		assert.equal(resolveRendererPolicy(tool).managed, true);
		// Keep the region constructed while styling was on: this exercises the live fallback,
		// not just a newly rebuilt off-mode native MouseRegion.
		const region = tool.createResultRegion(new Text("NATIVE_TOOL_BODY", 0, 0));
		h.root.clear();
		h.root.addChild(region);
		let body = target(h.render(), "NATIVE_TOOL_BODY");
		h.click(body.x, body.y);
		assert.equal(tool.expanded, false, "on-mode custom tool body must not invoke the native toggle");
		setConfig({ mode: "off" });
		assert.equal(resolveRendererPolicy(tool).reason, "off");
		body = target(h.render(), "NATIVE_TOOL_BODY");
		h.click(body.x, body.y);
		assert.equal(tool.expanded, true, "off-mode existing wrapper must delegate to the captured native handler");
		body = target(h.render(), "NATIVE_TOOL_BODY");
		h.click(body.x, body.y);
		assert.equal(tool.expanded, false, "native off-mode collapse remains intact");
	} finally { await h.close(); }
});

for (const mode of ["on", "off"] as const) {
	test(`${mode}: protected dedicated tools preserve native mouse handlers`, async () => {
		const h = await harness({ mode });
		try {
			for (const name of ["Agent", "StopAgent", "bg_run", "future"]) {
				h.root.clear();
				const definition = {
					name, label: name, description: "Fixture", parameters: {}, renderShell: "self",
					execute: async () => ({ content: [], details: undefined }),
					renderCall: () => new Text(`NATIVE_${name}`, 0, 0),
					renderResult: () => new Text(`NATIVE_RESULT_${name}`, 0, 0),
				};
				const tool = h.tool(name, `native-${name}`, {}, { content: [{ type: "text", text: "fixture" }] }, definition);
				assert.equal(resolveRendererPolicy(tool).managed, false);
				assert.equal(tool.toolDefinition, definition);
				const title = target(h.render(), `NATIVE_${name}`);
				h.click(title.x, title.y);
				assert.equal(tool.expanded, true, `${name}: native title click expands without a ccstyle hint`);
				const body = target(h.render(), `NATIVE_RESULT_${name}`);
				h.click(body.x, body.y);
				assert.equal(tool.expanded, false, `${name}: native result-body click collapses`);
			}
		} finally { await h.close(); }
	});

	test(`${mode}: visible assistant thinking keeps its native per-run mouse toggle`, async () => {
		const h = await harness({ mode });
		try {
			const assistant: any = new AssistantMessageComponent(message(2_001), false);
			h.root.addChild(assistant);
			const body = target(h.render(), "THINKING_BODY_0");
			h.click(body.x, body.y);
			assert.equal(assistant.thinkingVisibilityOverrides.get(0), true, "noncompact assistant delegates to its native MouseRegion");
			assert.equal(assistant.hideThinkingBlock, false, "native click changes only the per-run override");
			assert.ok(h.render().some((line) => line.includes(action)));
		} finally { await h.close(); }
	});
}

const summaries = [
	{ title: "[skill]", body: "NATIVE_SKILL_BODY", make: () => new SkillInvocationMessageComponent({
		name: "demo", location: "SKILL.md", content: "NATIVE_SKILL_BODY", userMessage: undefined,
	}) },
	{ title: "[compaction]", body: "NATIVE_COMPACTION_BODY", make: () => new CompactionSummaryMessageComponent({
		role: "compactionSummary", summary: "NATIVE_COMPACTION_BODY", tokensBefore: 1000, timestamp: 1,
	} as any) },
	{ title: "[branch]", body: "NATIVE_BRANCH_BODY", make: () => new BranchSummaryMessageComponent({
		role: "branchSummary", summary: "NATIVE_BRANCH_BODY", fromId: null, timestamp: 1,
	} as any) },
];
test("on → off: message cards keep native title and body toggles, not Thinking's exemption", async () => {
	const h = await harness({ mode: "on" });
	try {
		for (const summary of summaries) {
			h.root.clear();
			setConfig({ mode: "on" });
			const component: any = summary.make();
			h.root.addChild(component);
			assert.ok(h.render().some((line) => line.includes(action)));
			setConfig({ mode: "off" });
			await h.emit("session_tree");
			await h.flush();
			const lines = h.render();
			assert.ok(!lines.some((line) => line.includes(action)));
			const title = target(lines, summary.title);
			h.click(title.x, title.y);
			assert.equal(component.expanded, true, `${summary.title}: original MouseRegion still owns title clicks`);
			const body = target(h.render(), summary.body);
			h.click(body.x, body.y);
			assert.equal(component.expanded, false, `${summary.title}: original MouseRegion still owns body clicks`);
		}
	} finally { await h.close(); }
});

for (const mode of ["on", "off"] as const) {
	test(`regular terminal ${mode}: Thinking is not intercepted and native tool handlers still delegate`, async () => {
		const h = await harness({ mode: "on" });
		try {
			const assistant: any = new AssistantMessageComponent(message(3_001), true);
			const block = thinkingBlock(assistant);
			const tool = h.tool("write", "regular-fallback", { path: "fixture.txt", content: "body" },
				{ content: [{ type: "text", text: "written" }] });
			const region = tool.createResultRegion(new Text("REGULAR_NATIVE_BODY", 0, 0));
			const regular = new TuiMainScreen(h.terminal as any);
			assert.equal(regular.mode, "regular");
			setToolMouseTui(regular);
			setToolTuiFullscreen(false);
			setConfig({ mode });
			const collapsed = block.render(100).map(strip);
			assert.ok(!collapsed.some((line) => line.includes(action)), "regular terminal keeps its keyboard hint");
			block.setExpanded(true);
			const expanded = block.render(100).map(strip);
			const body = target(expanded, "THINKING_BODY_0");
			for (const type of ["move", "press", "click"] as const) {
				assert.equal((block as Component).handleMouse?.(mouse(type, body.x, body.y, expanded.length)), undefined,
					"fullscreen-only adapter must not consume regular-terminal mouse events");
				assert.equal(block.expanded, true, "regular mode must not intercept expanded Thinking to collapse it");
			}
			const nativeLines = region.render(100);
			assert.ok(region.handleMouse(mouse("click", 0, 0, nativeLines.length))?.handled);
			assert.equal(tool.expanded, true, "existing tool wrapper delegates to native even when styling is on in regular mode");
		} finally {
			setToolMouseTui(h.tui);
			setToolTuiFullscreen(true);
			await h.close();
		}
	});
}
