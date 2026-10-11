import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { AssistantMessageComponent, ToolExecutionComponent, VERSION } from "@earendil-works/pi-coding-agent";
import { convertMcpResult, createMcpToolDefinition } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/tools.js";
import { VisualLinePreview } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/visual-truncate.js";
import { config } from "../src/config/config.ts";
import { ToolGroupComponent } from "../src/compat/grouping.ts";
import { resolveRendererPolicy } from "../src/compat/policy.ts";
import { harness, strip, theme } from "./harness.ts";

// Test-only Pi 1.1.0 internal imports: this factory only builds a definition;
// conversion uses an injected, in-memory saver. Never construct createMcpExtension
// (config/credential discovery), connect a client, or execute the tool.
// Native instanceof checks must use coding-agent's own physical TUI closure.
const hostRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { Container, Text, visibleWidth } = await import(pathToFileURL(hostRequire.resolve("@earendil-works/pi-tui")).href) as
	typeof import("@earendil-works/pi-tui");
const widths = [40, 80, 120] as const;

function plain(lines: string[]): string {
	return lines.map((line) => strip(line).trim()).join("");
}

test("Pi 1.1.0 native MCP visual previews, notices and shell survive modes and exclusions", async () => {
	assert.equal(VERSION, "1.1.0", "internal renderer fixture is pinned to this host version");
	const name = "mcp__preview_fixture__long_line";
	const server = "preview_fixture";
	const toolName = "long_line";
	const fullOutputPath = "/synthetic/mcp.txt";
	let clientRequests = 0;
	const definition = createMcpToolDefinition({
		name, server, exposure: "direct", namespace: { name: "mcp__preview_fixture" }, timeoutMs: 1,
		tool: { name: toolName, description: "Synthetic long-line preview only.",
			inputSchema: { type: "object", properties: { query: { type: "string" } } } },
		getClient: async () => { clientRequests++; throw new Error("Rendering must never request an MCP client"); },
	});
	assert.equal(typeof definition.renderCall, "function");
	assert.equal(typeof definition.renderResult, "function");
	const originalDefinition = { ...definition };
	const args = { query: "界🙂👩‍💻".repeat(80) };
	const originalArgs = structuredClone(args);
	const json = (repeats: number) => JSON.stringify({ text: "界🙂👩‍💻".repeat(repeats), tail: "MCP_END" });
	const completeOutput = json(2_500);
	let savedOutputs = 0;
	const saveOutput = async (data: string | Uint8Array, extension: string) => {
		savedOutputs++;
		assert.equal(data, completeOutput);
		assert.equal(extension, ".txt");
		return fullOutputPath; // No file is written or read.
	};
	const results = await Promise.all([json(500), completeOutput].map((text) =>
		convertMcpResult(server, toolName, { content: [{ type: "text", text }] }, { saveOutput })));
	assert.equal(savedOutputs, 1);
	assert.equal(results[0].details.fullOutputPath, undefined);
	assert.equal(results[1].details.fullOutputPath, fullOutputPath);
	assert.match(results[1].content[0].type === "text" ? results[1].content[0].text : "", /Warning: truncated output/);
	const originalResults = structuredClone(results);

	// Capture genuine unpatched host output BEFORE harness installs the UI hooks.
	// Exact ANSI-line equality also detects background/padding interception.
	const nativeScreens = results.map((result, index) => {
		const native: any = new ToolExecutionComponent(name, `mcp-${index}`, args, { showImages: false },
			definition, { requestRender() {} } as any, process.cwd());
		native.markExecutionStarted();
		native.updateResult(result);
		const screens = new Map<string, string[]>();
		for (const expanded of [false, true]) {
			native.setExpanded(expanded);
			for (const width of widths) screens.set(`${expanded}:${width}`, native.render(width));
		}
		return screens;
	});

	const h = await harness();
	const originalExclusions = config.excludeRenderers;
	try {
		h.definitions[name] = definition;
		h.toolMetadata.set(name, {
			name, description: definition.description, parameters: definition.parameters, exposure: "direct",
			sourceInfo: { path: "builtin:mcp", source: "builtin", scope: "temporary", origin: "top-level" },
		});
		const assistant: any = new AssistantMessageComponent({
			role: "assistant", content: [
				{ type: "toolCall", id: "read-one", name: "read", arguments: { path: "one.ts" } },
				{ type: "toolCall", id: "read-two", name: "read", arguments: { path: "two.ts" } },
				...results.map((_, index) => ({ type: "toolCall", id: `mcp-${index}`, name, arguments: args })),
			], timestamp: 100, stopReason: "toolUse", api: "openai-responses", provider: "fixture", model: "fixture",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
		} as any, false);
		h.root.addChild(assistant);
		h.tool("read", "read-one", { path: "one.ts" }, { content: [{ type: "text", text: "one" }] });
		h.tool("read", "read-two", { path: "two.ts" }, { content: [{ type: "text", text: "two" }] });
		const components = results.map((result, index) => h.tool(name, `mcp-${index}`, args, result));

		for (const excluded of [false, true]) {
			config.excludeRenderers = excluded ? [name] : [];
			for (const mode of ["on", "compact", "off", "on"] as const) {
				await h.commands.get("ccstyle").handler(mode, h.ctx);
				assert.equal(config.mode, mode);
				if (mode === "on") {
					assert.ok(h.root.children.some((child) => child instanceof ToolGroupComponent),
						"managed read controls prove grouping is active");
				}
				if (mode === "compact") {
					const summary = plain(assistant.render(120));
					assert.match(summary, /read×2/, "managed controls enter the compact round");
					assert.doesNotMatch(summary, /mcp__|preview_fixture|long_line/, "MCP is not counted in the compact round");
				}
				for (const [index, component] of components.entries()) {
					assert.deepEqual(resolveRendererPolicy(component), {
						managed: false, groupable: false, compactable: false,
						reason: mode === "off" ? "off" : excluded ? "excluded" : "dedicated",
					});
					assert.equal(component.toolDefinition, definition);
					assert.equal(component.getCallRenderer(), definition.renderCall);
					assert.equal(component.getResultRenderer(), definition.renderResult);
					assert.equal(component.getRenderShell(), "default");
					assert.ok(h.root.children.includes(component), "MCP stays a standalone transcript row");
					assert.ok(!h.root.children.some((child) => child instanceof ToolGroupComponent && child.children.includes(component)));
					for (const expanded of [false, true]) {
						component.setExpanded(expanded);
						assert.ok(component.callRendererComponent instanceof Text, "native MCP call Text identity");
						assert.ok(component.resultRendererComponent instanceof Container, "native MCP result Container identity");
						assert.deepEqual([component.contentBox.paddingX, component.contentBox.paddingY], [1, 1]);
						assert.equal(component.contentBox.bgFn("boundary"), theme.bg("toolSuccessBg", "boundary"));
						const previews = component.resultRendererComponent.children.filter((child: unknown) => child instanceof VisualLinePreview);
						assert.equal(previews.length, expanded ? 0 : 1, "real native VisualLinePreview, not a generic fallback");
						// Revisiting 40 also exercises the native width-keyed preview cache.
						for (const width of [...widths, 40]) {
							const lines: string[] = component.render(width);
							assert.deepEqual(lines, nativeScreens[index].get(`${expanded}:${width}`),
								`${mode}, excluded=${excluded}, expanded=${expanded}, width=${width}: preserve the entire native shell`);
							assert.ok(lines.length > 0, "compact must not suppress this dedicated tool");
							assert.ok(lines.every((line) => visibleWidth(line) <= width), "CJK/emoji visual widths fit the host shell");
							const output = plain(lines);
							assert.match(output, /preview_fixture\/long_line/);
							if (expanded) {
								assert.match(output, /MCP_END/, "native expansion wraps all retained output, including the tail");
								assert.doesNotMatch(output, /\d+ more lines/);
							} else {
								const contentWidth = width - 2; // Native default Box padding, not UI padding.
								const text = results[index].content.map((block) => block.type === "text" ? block.text : "").join("\n").trim();
								const styled = text.split("\n").map((line) => theme.fg("toolOutput", line)).join("\n");
								const wrapped = new Text(styled, 0, 0).render(contentWidth);
								assert.ok(wrapped.length > 5, "even the single logical JSON line exceeds five visual lines");
								const preview: string[] = previews[0].render(contentWidth);
								assert.equal(preview.length, 6, "exactly five wrapped visual lines plus the clipped native hint");
								assert.deepEqual(preview.slice(0, 5), wrapped.slice(0, 5), "MCP keeps the START, not the tail");
								assert.match(strip(preview[5]), new RegExp(`\\(${wrapped.length - 5} more lines,`));
								assert.ok(preview.every((line) => visibleWidth(line) <= contentWidth));
								assert.equal(previews[0].render(contentWidth), preview, "native preview memoizes unchanged widths");
								assert.doesNotMatch(output, /MCP_END/, "collapsed long-line tail is hidden");
							}
							if (index === 1) {
								assert.match(output, /Warning: truncated output/, "model-facing truncation notice survives preview and expansion");
								assert.match(output, /Full output: \/synthetic\/mcp\.txt/, "native full-output notice survives clipping");
							}
						}
					}
					assert.equal(component.result, results[index], "rendering retains the original result object");
				}
			}
		}
		assert.deepEqual(results, originalResults);
		assert.deepEqual(args, originalArgs);
		assert.deepEqual(definition, originalDefinition);
		assert.deepEqual(h.registered, []);
		assert.deepEqual(h.mutations, []);
		assert.equal(clientRequests, 0);
		assert.equal(savedOutputs, 1, "rendering never saves or fetches output");
	} finally {
		config.excludeRenderers = originalExclusions;
		await h.close();
	}
});
