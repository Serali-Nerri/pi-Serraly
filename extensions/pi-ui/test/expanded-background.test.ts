import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { SkillInvocationMessageComponent } from "@earendil-works/pi-coding-agent";
import { Spacer, setCapabilityOverrides } from "@earendil-works/pi-tui";
import { updateConfig } from "../src/config/config.ts";
import { ToolGroupComponent } from "../src/compat/grouping.ts";
import { ThinkingPreviewBlock } from "../src/transcript/thinking.ts";
import { harness } from "./harness.ts";

const result = { content: [{ type: "text", text: "BODY" }], isError: false };

test("saved semantic backgrounds update existing expanded tools, groups, messages and Thinking on repaint", async () => {
	const h = await harness();
	try {
		const tool = h.tool("bash", "background-tool", { command: "echo fixture" }, result);
		tool.setExpanded(true);
		h.root.addChild(new Spacer(4));
		h.tool("bash", "background-group-one", { command: "echo one" }, result);
		h.tool("bash", "background-group-two", { command: "echo two" }, result);
		const group = h.root.children.find((child) => child instanceof ToolGroupComponent) as ToolGroupComponent;
		assert.ok(group);
		group.setExpanded(true);
		const message = new SkillInvocationMessageComponent({ name: "fixture", location: "SKILL.md", content: "MESSAGE_BODY", userMessage: undefined });
		message.setExpanded(true);
		h.root.addChild(message);
		const thinking = new ThinkingPreviewBlock("Thought", "THINKING_BODY", 1, 900, (text) => text, h.ctx.ui.theme);
		thinking.setExpanded(true);
		h.root.addChild(thinking);
		const views = [tool, group, message, thinking];
		for (const view of views) assert.ok(view.render(100).join("\n").includes(h.ctx.ui.theme.getBgAnsi("userMessageBg")));

		updateConfig({ expandedCardBackground: "toolPendingBg" });
		for (const view of views) {
			assert.ok(view.render(100).join("\n").includes(h.ctx.ui.theme.getBgAnsi("toolPendingBg")), `${view.constructor.name} uses the saved token without recreation`);
		}
		updateConfig({ expandedCardBackground: "invalid-token" } as never);
		for (const view of views) assert.ok(view.render(100).join("\n").includes(h.ctx.ui.theme.getBgAnsi("userMessageBg")));
	} finally { await h.close(); }
});

test("the settings panel exposes and saves a semantic expanded background", async () => {
	const h = await harness();
	try {
		const tool = h.tool("bash", "panel-background", { command: "echo fixture" }, result);
		tool.setExpanded(true);
		const panel = h.commands.get("ccstyle").handler("panel", h.ctx);
		assert.ok(h.overlay);
		for (let page = 0; page < 3; page++) h.overlay!.handleInput!("\t");
		assert.match(h.overlay!.render(100).join("\n"), /Expanded card background/);
		for (let row = 0; row < 3; row++) h.overlay!.handleInput!("\x1b[B");
		h.overlay!.handleInput!("\r");
		assert.match(h.overlay!.render(100).join("\n"), /toolPendingBg/);
		h.overlay!.handleInput!("\x1b");
		await panel;
		assert.ok(tool.render(100).join("\n").includes(h.ctx.ui.theme.getBgAnsi("toolPendingBg")));
		await h.commands.get("ccstyle").handler("status", h.ctx);
		assert.ok(h.notices.some(({ message }) => message.includes("expandedCardBackground=toolPendingBg")));
	} finally { h.overlay?.handleInput?.("\x1b"); await h.close(); }
});


test("expanded file and patch outer backgrounds preserve diff change semantics", async () => {
	const h = await harness();
	setCapabilityOverrides({ trueColor: true });
	try {
		updateConfig({ expandedCardBackground: "toolPendingBg" });
		const patch = JSON.parse(readFileSync(new URL("./fixtures/apply-patch-v1.json", import.meta.url), "utf8"));
		const views = [
			h.tool("write", "bg-write", { path: "fixture.ts", content: "WRITE_BODY" }, result),
			h.tool("edit", "bg-edit", { path: "fixture.ts", oldText: "old", newText: "new" }, { ...result, details: { diff: "-1 old\n+1 new" } }),
			h.tool("apply_patch", "bg-patch", { input: "captured input" }, { ...result, details: patch }, { name: "apply_patch", label: "apply_patch" }),
		];
		for (const tool of views) {
			tool.setExpanded(true);
			const lines = tool.render(100);
			assert.ok(lines.join("\n").includes(h.ctx.ui.theme.getBgAnsi("toolPendingBg")), `${tool.toolName} has the chosen outer background`);
			if (tool.toolName !== "write") {
				assert.match(lines.join("\n"), /\x1b\[48;2;95;0;0m/);
				assert.match(lines.join("\n"), /\x1b\[48;2;0;95;0m/);
			}
		}
	} finally { setCapabilityOverrides({}); await h.close(); }
});
