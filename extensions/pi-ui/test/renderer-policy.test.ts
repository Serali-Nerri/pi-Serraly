import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { bindRendererPolicy, resolveRendererPolicy } from "../src/compat/policy.ts";
import { setConfig } from "../src/config/config.ts";
import { ToolGroupComponent } from "../src/compat/grouping.ts";
import { harness, strip } from "./harness.ts";

test("policy respects actual source, dedicated renderers and off/exclusion first", () => {
	let metadata: any[] = [{ name: "read", sourceInfo: { source: "builtin", path: "builtin:read" } }];
	const release = bindRendererPolicy(() => metadata);
	const dedicated = { name: "read", renderCall() {} };
	try {
		setConfig({});
		assert.equal(resolveRendererPolicy("read", dedicated).reason, "builtin");
		metadata = [{ name: "read", sourceInfo: { source: "local", path: "extension.ts" } }];
		assert.equal(resolveRendererPolicy("read", dedicated).managed, false, "same name does not make an override native");
		assert.equal(resolveRendererPolicy("unknown", { name: "unknown", renderResult() {} }).managed, false);
		assert.equal(resolveRendererPolicy("plain", { name: "plain" }).managed, true);
		setConfig({ excludeRenderers: ["plain"] });
		assert.equal(resolveRendererPolicy("plain", { name: "plain" }).reason, "excluded");
		setConfig({ mode: "off" });
		assert.equal(resolveRendererPolicy("read", dedicated).reason, "off");
	} finally { release(); setConfig({}); }
});

for (const mode of ["on", "compact"] as const) {
	test(`${mode} preserves Agent/StopAgent/dedicated/custom native cards outside aggregate/background/mouse`, async () => {
		const h = await harness({ mode });
		try {
			for (const [index, name] of ["Agent", "StopAgent", "custom_tool", "future"].entries()) {
				const renderer = (label: string) => () => new Text(label, 0, 0);
				const definition = {
					name, label: name, parameters: {}, description: "Original", exposure: "deferred",
					execute: async () => ({ content: [], details: undefined }),
					promptGuidelines: ["Do not change"], renderShell: "self",
					renderCall: renderer(`NATIVE_${name}`), renderResult: renderer(`RESULT_${name}`),
				};
				const assistant: any = new AssistantMessageComponent({
					role: "assistant", content: [{ type: "toolCall", id: `d${index}`, name, arguments: {} }],
					timestamp: 100 + index, stopReason: "toolUse", api: "openai-responses", provider: "fixture", model: "fixture",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
				}, false);
				h.root.addChild(assistant);
				const tool = h.tool(name, `d${index}`, {}, { content: [{ type: "text", text: "captured" }], details: undefined }, definition);
				assert.match(tool.render(80).map(strip).join("\n"), new RegExp(`NATIVE_${name}`));
				tool.setExpanded(true);
				assert.equal(tool.getRenderShell(), "self");
				assert.match(tool.render(80).map(strip).join("\n"), new RegExp(`RESULT_${name}`));
				assert.equal(tool.toolDefinition, definition);
				assert.deepEqual(definition.promptGuidelines, ["Do not change"]);
				assert.ok(h.root.children.includes(tool), "dedicated tool stays outside groups");
				assert.ok(!h.root.children.some((child) => child instanceof ToolGroupComponent && child.children.includes(tool)));
			}
			h.tool("read", "r", { path: "source.ts" }, { content: [{ type: "text", text: "body" }], details: undefined });
			assert.deepEqual(h.registered, []);
			assert.deepEqual(h.mutations, []);
		} finally { await h.close(); }
	});
}

test("configuration-only exclusion restores already mounted group children", async () => {
	const h = await harness();
	try {
		const first = h.tool("read", "one", { path: "one.ts" }, { content: [{ type: "text", text: "one" }] });
		h.tool("bash", "two", { command: "echo two" }, { content: [{ type: "text", text: "two" }] });
		assert.ok(h.root.children[0] instanceof ToolGroupComponent);
		setConfig({ excludeRenderers: ["read"] });
		await h.emit("session_tree");
		await h.flush();
		assert.ok(h.root.children.includes(first));
		assert.ok(!h.root.children.some((child) => child instanceof ToolGroupComponent && child.children.includes(first)));
	} finally { setConfig({}); await h.close(); }
});

for (const name of ["write", "edit"]) {
	test(`rendererless ${name} override inherits host renderers and stays outside managed groups`, async () => {
		const h = await harness();
		const definition = { name, label: "Custom file tool", description: "Alternate schema.", parameters: {} };
		const args = { file_path: "custom.txt", text: "custom body", content: "retained write content" };
		const result = { content: [{ type: "text", text: "ACK" }], details: { diff: "+1 retained edit diff" } };
		try {
			h.tool("read", `adjacent-read-${name}`, { path: "fixture.ts" }, { content: [{ type: "text", text: "read" }] });
			const override = h.tool(name, `override-${name}`, args, result, definition);
			override.setExpanded(true);
			const text = override.render(120).map(strip).join("\n");
			assert.match(text, /custom\.txt/);
			if (name === "write") assert.match(text, /retained write content/);
			else assert.match(text, /retained edit diff/);
			assert.doesNotMatch(text, /custom body/, "host merges the native renderer; it does not invent a generic Input pane");
			assert.ok(h.root.children.includes(override));
			assert.ok(!h.root.children.some((child) => child instanceof ToolGroupComponent && child.children.includes(override)));
			assert.deepEqual(args, { file_path: "custom.txt", text: "custom body", content: "retained write content" });
			assert.deepEqual(result, { content: [{ type: "text", text: "ACK" }], details: { diff: "+1 retained edit diff" } });
		} finally { await h.close(); }
	});
}
