import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { setCapabilityOverrides, visibleWidth } from "@earendil-works/pi-tui";
import { setConfig, config, updateConfig } from "../src/config/config.ts";
import { ToolGroupComponent } from "../src/compat/grouping.ts";
import { FileResultView } from "../src/transcript/tool/files.ts";
import {
	displayPath,
	fitToolCallSummary,
	truncatePathToWidth,
} from "../src/transcript/tool/names.ts";
import { harness, strip } from "./harness.ts";

const result = (text: string, isError = false, details?: any) => ({ content: [{ type: "text", text }], isError, details });

test("only rendering commands are registered and native tools are untouched", async () => {
	const h = await harness();
	try {
		assert.deepEqual([...h.commands.keys()].sort(), ["ccstyle"]);
		assert.deepEqual(h.registered, []); assert.deepEqual(h.mutations, []);
		assert.equal(h.events.has("tool_result"), false);
		assert.equal(h.events.has("before_agent_start"), false);
		const definition = h.definitions.bash;
		const tool = h.tool("bash", "b", { command: "printf x" }, result("x"));
		assert.deepEqual(tool.toolDefinition.parameters, definition.parameters);
		assert.equal(tool.toolDefinition.execute, definition.execute);
		assert.doesNotMatch(JSON.stringify(definition.promptGuidelines), /Codex|10,000/);
	} finally { await h.close(); }
});

test("write and edit preserve local colors, lines, headers and full long previews", async () => {
	const h = await harness();
	setCapabilityOverrides({ trueColor: true });
	try {
		const write = h.tool("write", "w", { path: "out.ts", content: Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n") }, result("ok"));
		const edit = h.tool("edit", "e", { path: "in.ts", oldText: "old", newText: "new" }, result("ok", false, { diff: "-1 old\n+1 new" }));
		const text = write.render(100).map(strip).join("\n");
		assert.match(text, /● write \(out.ts\)/); assert.match(text, /Wrote 100 lines to out.ts/);
		assert.match(text, /10 line 10/); assert.doesNotMatch(text, /11 line 11/);
		const diff = edit.render(100).join("\n");
		assert.match(diff, /\x1b\[48;2;95;0;0m/); assert.match(diff, /\x1b\[48;2;0;95;0m/);
		assert.match(strip(diff), /Added 1 line, removed 1 line/);
		write.setExpanded(true);
		assert.doesNotMatch(write.render(100).map(strip).join("\n"), /81 line 81/);
		assert.ok(write.resultRendererComponent instanceof FileResultView);
		assert.match(write.resultRendererComponent.fullPreview.content.render(100).map(strip).join("\n"), /100 line 100/);
		for (const width of [1, 2, 8, 16, 40, 80]) {
			assert.ok(write.render(width).every((line: string) => visibleWidth(line) <= width));
			assert.ok(edit.render(width).every((line: string) => visibleWidth(line) <= width));
		}
		setCapabilityOverrides({ trueColor: false }); write.invalidate(); edit.invalidate();
		assert.doesNotMatch(edit.render(100).join("\n"), /\x1b\[48;2;/);
	} finally { setCapabilityOverrides({}); await h.close(); }
});

test("edit previews wrap long diff lines with continuation rows instead of clipping", async () => {
	const h = await harness();
	setCapabilityOverrides({ trueColor: true });
	try {
		const long = "const value = " + "abcdefghij".repeat(12) + "; END_MARKER";
		const edit = h.tool("edit", "e-wrap", { path: "in.ts", oldText: "old", newText: "new" },
			result("ok", false, { diff: `-1 ${long}\n+1 ${long}\n 2 keep` }));
		const width = 80;
		const lines = edit.render(width);
		const text = lines.map(strip).join("\n");
		assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
		assert.match(text, /END_MARKER/, "the whole long line stays visible inside the card");
		assert.doesNotMatch(text, /…/, "wrapping does not leave a width ellipsis behind");
		assert.doesNotMatch(text, /click to show more/, "a wrapped line within the row budget needs no overlay hint");
		const wrapped = lines.filter((line: string) => /\x1b\[48;2;(?:95;0;0|0;95;0)m/.test(line));
		assert.ok(wrapped.length >= 4, "long +/- rows wrap onto continuation rows");
		assert.ok(wrapped.some((line: string) => strip(line).startsWith("         + ")), "continuation rows keep the sign marker");
		assert.ok(wrapped.some((line: string) => strip(line).startsWith("         - ")), "continuation rows keep the sign marker");
		for (const narrow of [1, 2, 8, 16, 40]) {
			assert.ok(edit.render(narrow).every((line: string) => visibleWidth(line) <= narrow));
		}
	} finally { setCapabilityOverrides({}); await h.close(); }
});

test("write previews wrap long lines with aligned continuation rows instead of clipping", async () => {
	const h = await harness();
	setCapabilityOverrides({ trueColor: true });
	try {
		const long = "const value = " + "abcdefghij".repeat(12) + "; END_MARKER";
		const write = h.tool("write", "w-wrap", { path: "out.ts", content: `first\n${long}\nlast` }, result("ok"));
		const width = 80;
		const lines = write.render(width);
		const plain = lines.map(strip);
		assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
		assert.match(plain.join("\n"), /END_MARKER/, "the whole long line stays visible inside the card");
		assert.doesNotMatch(plain.join("\n"), /…/, "wrapping does not leave a width ellipsis behind");
		assert.doesNotMatch(plain.join("\n"), /click to show more/, "a wrapped line within the row budget needs no overlay hint");
		assert.ok(plain.filter((line: string) => line.includes("abcdefghij")).length >= 2, "the long line wraps onto continuation rows");
		assert.ok(plain.some((line: string) => /^ {8}\S/.test(line)), "continuation rows keep a blank line-number gutter");
		assert.ok(plain.some((line: string) => /^ {6}\d+ const value/.test(line)), "the first chunk keeps its line number");
		for (const narrow of [1, 2, 8, 16, 40]) {
			assert.ok(write.render(narrow).every((line: string) => visibleWidth(line) <= narrow));
		}
	} finally { setCapabilityOverrides({}); await h.close(); }
});

test("read details include the captured body and complete errors", async () => {
	const h = await harness();
	try {
		const read = h.tool("read", "r", { path: "a.ts", offset: 10, limit: 2 }, result("first body\nsecond body"));
		read.setExpanded(true);
		assert.match(read.render(100).map(strip).join("\n"), /second body/);
		const failure = h.tool("edit", "e", { path: "a", oldText: "", newText: "" }, result("Error: first\nsecond diagnostic", true));
		assert.match(failure.resultRendererComponent.fullPreview.content.render(100).map(strip).join("\n"), /second diagnostic/);
	} finally { await h.close(); }
});

test("adjacent tools group with persistent failure counts and file edits stay separate", async () => {
	const h = await harness();
	try {
		h.tool("read", "r", { path: "a" }, result("a"));
		h.tool("bash", "b", { command: "false" }, result("Command exited with code 1", true));
		const edit = h.tool("edit", "e", { path: "a", oldText: "", newText: "" }, result("ok", false, { diff: "+1 new" }));
		const group = h.root.children.find((c) => c instanceof ToolGroupComponent) as ToolGroupComponent;
		assert.ok(group); assert.equal(group.children.length, 2);
		assert.match(group.render(100).map(strip).join("\n"), /1 done.*1 failed/);
		assert.ok(h.root.children.includes(edit));
		group.setExpanded(true);
		assert.match(group.render(100).map(strip).join("\n"), /Command exited with code 1/);
	} finally { await h.close(); }
});

test("fullscreen uses hint expansion, single-click collapse and native selection", async () => {
	const h = await harness();
	try {
		const read = h.tool("read", "r", { path: "a" }, result("first body\nsecond body"));
		let lines = h.render();
		let row = lines.findIndex((line) => line.includes("click to show more"));
		assert.ok(row >= 0, lines.join("\n"));
		h.click(1, row); assert.equal(read.expanded, false);
		h.click(lines[row]!.indexOf("click to show more"), row);
		assert.equal(read.expanded, true);
		lines = h.render(); row = lines.findIndex((line) => line.includes("first body"));
		const col = lines[row]!.indexOf("first body");
		h.pointer(col, row); h.pointer(col + 4, row, "drag"); h.pointer(col + 4, row, "release");
		assert.equal(read.expanded, true);
		h.click(col, row);
		assert.equal(read.expanded, false);
	} finally { await h.close(); }
});

test("fullscreen group headers toggle expansion on successive single clicks", async () => {
	const h = await harness();
	try {
		h.tool("read", "r", { path: "source.ts" }, result("body"));
		h.tool("bash", "b", { command: "pwd" }, result("workspace"));
		const group = h.root.children[0] as ToolGroupComponent;
		for (let i = 0; i < 2; i++) {
			let lines = h.render();
			let row = lines.findIndex((line) => line.includes("click to show more"));
			h.click(lines[row]!.indexOf("click to show more"), row);
			assert.equal(group.expanded, true);
			lines = h.render();
			row = lines.findIndex((line) => line.includes("Multiple Tools:"));
			assert.match(lines[row]!, /click to collapse/);
			h.click(lines[row]!.indexOf(i === 0 ? "Multiple Tools:" : "click to collapse"), row);
			assert.equal(group.expanded, false, "the next single click must close the group");
			assert.ok(group.children.every((child: any) => !child.expanded));
		}
	} finally { await h.close(); }
});

test("fullscreen file tool headers collapse after a single click", async () => {
	const h = await harness();
	try {
		for (const name of ["write", "edit"] as const) {
			const args = { path: `${name}.ts`, content: Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"), oldText: "old", newText: "new" };
			const diff = Array.from({ length: 20 }, (_, index) => `+${index + 1} line ${index + 1}`).join("\n");
			const tool = h.tool(name, name, args, result("ok", false, { diff }));
			let lines = h.render();
			let row = lines.findIndex((line) => line.includes("click to show more"));
			h.click(lines[row]!.indexOf("click to show more"), row);
			assert.equal(tool.expanded, true);
			lines = h.render();
			row = lines.findIndex((line) => line.includes(`${name} (${name}.ts)`));
			h.click(lines[row]!.indexOf(name), row);
			assert.equal(tool.expanded, false);
			h.root.removeChild(tool);
		}
	} finally { await h.close(); }
});

test("long file hint opens an overlay without changing its captured contents", async () => {
	const h = await harness();
	try {
		const content = Array.from({ length: 120 }, (_, index) => `line ${index + 1}`).join("\n") + "\nFINAL_MARKER";
		const write = h.tool("write", "w", { path: "snapshot.ts", content }, result("ok"));
		let lines = h.render(); let row = lines.findIndex((line) => line.includes("click to show more"));
		h.click(lines[row]!.indexOf("click to show more"), row); assert.equal(write.expanded, true);
		h.tui.scrollToBottom();
		lines = h.render(); row = lines.findIndex((line) => line.includes("click to show more"));
		h.click(lines[row]!.indexOf("click to show more"), row);
		assert.ok(h.overlay);
		h.overlay!.render(100); h.overlay!.handleInput?.("\x1b[F");
		assert.match(h.overlay!.render(100).map(strip).join("\n"), /FINAL_MARKER/);
		h.overlay!.handleInput?.("\x1b");
	} finally { await h.close(); }
});

test("file hints retain hover across renderer rebuilds and clear on pointer leave", async () => {
	const h = await harness();
	setCapabilityOverrides({ trueColor: true });
	try {
		const write = h.tool("write", "hover-file", { path: "long.ts", content: Array.from({ length: 120 }, (_, index) => `line ${index + 1}`).join("\n") }, result("ok"));
		write.setExpanded(true);
		const lines = h.render();
		const row = lines.findIndex((line) => line.includes("click to show more"));
		const col = lines[row]!.indexOf("click to show more");
		const hint = () => write.render(100).find((line: string) => line.includes("click to show more"));
		assert.match(hint(), /\x1b\[38;2;127;127;127m/);
		h.pointer(col, row, "move"); h.render();
		assert.match(hint(), /\x1b\[38;2;242;242;242m/);
		const component = write.resultRendererComponent;
		h.pointer(col + 1, row, "move"); h.render();
		assert.equal(write.resultRendererComponent, component, "moving within a hint should not rebuild the renderer");
		h.pointer(0, 0, "move"); h.render();
		assert.match(hint(), /\x1b\[38;2;127;127;127m/);
	} finally { setCapabilityOverrides({}); await h.close(); }
});

test("renderer exclusions, native mode, and replacement shutdown preserve ownership", async () => {
	const first = await harness();
	let second: Awaited<ReturnType<typeof harness>> | undefined;
	try {
		const original = { name: "custom", label: "custom", renderCall: () => ({ render: () => ["DEDICATED"], invalidate() {} }) };
		setConfig({ excludeRenderers: ["custom"] });
		const custom = first.tool("custom", "c", {}, result("value"), original);
		assert.match(custom.render(100).map(strip).join("\n"), /DEDICATED/);
		second = await harness();
		await first.close();
		const tool = second.tool("write", "w", { path: "b", content: "hello" }, result("ok"));
		assert.match(tool.render(100).map(strip).join("\n"), /write \(b\)/);
		setConfig({ mode: "off" }); tool.invalidate();
		assert.doesNotMatch(tool.render(100).map(strip).join("\n"), /write \(b\)/);
	} finally { await second?.close(); await first.close(); }
});

test("headless instances do not change TUI prototype ownership", async () => {
	const parent = await harness();
	const original = (ToolExecutionComponent.prototype as any).getCallRenderer;
	const child = await harness({ headless: true });
	try {
		await child.close();
		assert.equal((ToolExecutionComponent.prototype as any).getCallRenderer, original);
	} finally { await parent.close(); }
});

test("config persistence is isolated from upstream configuration", async () => {
	const dir = await mkdtemp(join(tmpdir(), "claude-style-config-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = dir;
		updateConfig({ mode: "compact", fileExpandedMaxLines: 200 });
		const saved = JSON.parse(await readFile(join(dir, "claude-style-tools.json"), "utf8"));
		assert.equal(saved.fileExpandedMaxLines, 200);
		assert.equal(saved.enableSessionReference, undefined);
		await assert.rejects(readFile(join(dir, "claude-code-style.json")));
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		setConfig({}); await rm(dir, { recursive: true, force: true });
	}
});

const message = (content: any[], timestamp: number) => ({ role: "assistant", content, timestamp,
	api: "openai-responses", provider: "openai", model: "test", stopReason: "toolUse",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
}) as any;

test("fullscreen preserves native assistant hyperlink activation", async () => {
	const h = await harness();
	setCapabilityOverrides({ hyperlinks: true });
	try {
		const opened: string[] = [];
		h.tui.openUrl = (url: string) => opened.push(url);
		const response = message([{ type: "text", text: "See [Reference](https://example.com/reference)." }], 200);
		response.stopReason = "stop";
		h.root.addChild(new AssistantMessageComponent(response, false));
		const lines = h.render();
		const row = lines.findIndex((line) => line.includes("Reference"));
		assert.ok(row >= 0);
		h.click(lines[row]!.indexOf("Reference"), row);
		assert.deepEqual(opened, ["https://example.com/reference"]);
	} finally { setCapabilityOverrides({}); await h.close(); }
});

test("compact rounds retain file styling and support nested native mouse input", async () => {
	const h = await harness({ mode: "compact" });
	try {
		const first = message([{ type: "thinking", thinking: "Inspect the implementation" },
			{ type: "toolCall", id: "r", name: "read", arguments: { path: "source.ts" } }], 100);
		const assistant = new AssistantMessageComponent(first, true) as any;
		h.root.addChild(assistant);
		h.tool("read", "r", { path: "source.ts" }, result("NESTED_BODY\nsecond line"));
		const write = h.tool("write", "w", { path: "output.ts", content: "const done = true;" }, result("ok"));
		let lines = h.render();
		assert.match(lines.join("\n"), /Read 1 file/);
		assert.match(lines.join("\n"), /write \(output.ts\)/);
		let row = lines.findIndex((line) => line.includes("Read 1 file"));
		h.click(lines[row]!.indexOf("click to show more"), row);
		assert.equal(assistant.expanded, true); assert.equal(write.expanded, false);
		lines = h.render();
		assert.match(lines.join("\n"), /source.ts/);
		row = lines.findIndex((line) => line.includes("click to show more"));
		assert.ok(row >= 0, lines.join("\n"));
		h.click(lines[row]!.indexOf("click to show more"), row);
		h.render();
		assert.equal(assistant.expanded, true, "opening a child must retain the round");
		const finalMessage = message([{ type: "text", text: "Final response" }], 102);
		finalMessage.stopReason = "stop";
		h.root.addChild(new AssistantMessageComponent(finalMessage, true));
		assert.match(h.render().join("\n"), /Final response/);
	} finally { await h.close(); }
});

test("compact child details collapse on a single click without closing the round", async () => {
	const h = await harness({ mode: "compact" });
	try {
		const response = message([{ type: "thinking", thinking: "Inspect the source" },
			{ type: "toolCall", id: "r", name: "read", arguments: { path: "source.ts" } }], 300);
		const assistant = new AssistantMessageComponent(response, true) as any;
		h.root.addChild(assistant);
		const read = h.tool("read", "r", { path: "source.ts" }, result("NESTED_BODY"));
		let lines = h.render();
		let row = lines.findIndex((line) => line.includes("Read 1 file"));
		h.click(lines[row]!.indexOf("click to show more"), row);
		lines = h.render();
		row = lines.findIndex((line) => line.includes("1 line loaded"));
		h.click(lines[row]!.indexOf("click to show more"), row);
		assert.equal(read.expanded, true);
		lines = h.render();
		row = lines.findIndex((line) => line.includes("NESTED_BODY"));
		assert.ok(row >= 0, lines.join("\n"));
		h.click(lines[row]!.indexOf("NESTED_BODY"), row);
		assert.equal(read.expanded, false);
		assert.equal(assistant.expanded, true);
		lines = h.render();
		row = lines.findIndex((line) => line.includes("Inspect the source"));
		h.click(lines[row]!.indexOf("Inspect the source"), row);
		assert.equal(assistant.expanded, false);
	} finally { await h.close(); }
});

test("fullscreen group children open details and scrolling keeps the native setting", async () => {
	const h = await harness();
	try {
		h.tui.setWheelScrollLines(7);
		let configWrites = 0;
		const nativeSetWheel = h.tui.setWheelScrollLines.bind(h.tui);
		h.tui.setWheelScrollLines = (lines: number) => { configWrites++; nativeSetWheel(lines); };
		for (let i = 0; i < 8; i++) h.tool("read", `r${i}`, { path: `file${i}` }, result(`body${i}\nmore`));
		let lines = h.render();
		const group = h.root.children[0] as ToolGroupComponent;
		let row = lines.findIndex((line) => line.includes("click to show more"));
		h.click(lines[row]!.indexOf("click to show more"), row);
		assert.equal(group.expanded, true);
		lines = h.render();
		assert.equal(configWrites, 0, "UI never overwrites the host's wheel setting");
		h.tui.scrollToTop(); lines = h.render();
		assert.match(lines.join("\n"), /body0/);
		h.tui.handleViewportInput("\x1b[<65;10;10M"); h.render();
		assert.equal(h.tui.viewportTop, 7);
		row = h.render().findIndex((line) => line.includes("body"));
		h.click(10, row); h.click(10, row);
		assert.equal(group.expanded, false);
	} finally { await h.close(); }
});

test("tool details retain complete available output beyond the compact sanitizer budget", async () => {
	const h = await harness();
	try {
		const bash = h.tool("bash", "b", { command: "x".repeat(9000) + "COMMAND_TAIL" }, result("a".repeat(18000) + "RESULT_TAIL"));
		bash.setExpanded(true);
		assert.match(bash.resultRendererComponent.getOutputBody(), /RESULT_TAIL$/);
		assert.match(bash.resultRendererComponent.getInputBody(), /COMMAND_TAIL$/);
	} finally { await h.close(); }
});

test("narrow fullscreen groups retain their actionable hint after scrolling", async () => {
	const h = await harness();
	try {
		h.terminal.columns = 44;
		h.tool("read", "r", { path: "a-very-long-component-name.ts" }, result("one\ntwo"));
		h.tool("bash", "b", { command: "npm run a-long-command" }, result("one\ntwo"));
		const lines = h.render();
		const row = lines.findIndex((line) => line.includes("click to show more"));
		assert.ok(row >= 0, lines.join("\n"));
		h.click(lines[row]!.indexOf("click to show more"), row);
		assert.equal((h.root.children[0] as ToolGroupComponent).expanded, true);
	} finally { await h.close(); }
});

test("literal show-more text in tool output preserves drag selection", async () => {
	const h = await harness();
	try {
		const read = h.tool("read", "r", { path: "a" }, result("literal click to show more\nlast line"));
		read.setExpanded(true);
		const lines = h.render(); const row = lines.findIndex((line) => line.includes("literal click"));
		const col = lines[row]!.indexOf("click");
		h.pointer(col, row); h.pointer(col + 5, row, "drag"); h.pointer(col + 5, row, "release");
		assert.equal(read.expanded, true);
		assert.equal(h.overlay, undefined);
	} finally { await h.close(); }
});

test("display paths relativize inside cwd and keep filenames when narrowed", () => {
	const cwd = process.cwd();
	const longPath = join(cwd, "extensions", "very-long-feature-name", "nested", "target-file.ts");
	const relative = join("extensions", "very-long-feature-name", "nested", "target-file.ts");
	assert.equal(displayPath(longPath, cwd), relative);
	assert.equal(displayPath("/elsewhere/target-file.ts", cwd), "/elsewhere/target-file.ts");
	assert.equal(displayPath(longPath), longPath);
	const narrowed = truncatePathToWidth(relative, 24);
	assert.match(narrowed, /…[\\/]target-file\.ts$/);
	assert.ok(visibleWidth(narrowed) <= 24);
	const fitted = fitToolCallSummary(
		{ main: `Read ${relative}`, detail: "", path: { prefix: "Read", value: relative } },
		24,
	);
	assert.match(fitted, /^Read .*…[\\/]target-file\.ts$/);
	assert.ok(visibleWidth(fitted) <= 24);
	const fallback = fitToolCallSummary({ main: "Bash echo hello world", detail: "" }, 12);
	assert.match(fallback, /^Bash echo .*…$/);
	assert.ok(visibleWidth(fallback) <= 12);
});

test("collapsed groups preserve filenames for long cwd paths", async () => {
	const h = await harness();
	try {
		const longPath = join(
			process.cwd(),
			"extensions",
			"very-long-feature-name",
			"nested-renderer-implementation",
			"target-file.ts",
		);
		h.tool("read", "long-read", { path: longPath }, result("body"));
		h.tool("bash", "separator", { command: "echo ok" }, result("ok"));
		const group = h.root.children.find((c) => c instanceof ToolGroupComponent) as ToolGroupComponent;
		assert.ok(group);
		const readLine = group.render(48).map(strip).find((line) => line.includes("Read"));
		assert.match(readLine!, /Read extensions.*…[\\/]target-file\.ts$/);
		assert.doesNotMatch(
			readLine!,
			new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		);
	} finally { await h.close(); }
});

test("default tool call lines preserve filenames for long cwd paths", async () => {
	const h = await harness();
	try {
		const longPath = join(
			process.cwd(),
			"extensions",
			"very-long-feature-name",
			"nested-renderer-implementation",
			"target-file.ts",
		);
		const read = h.tool("read", "long-read", { path: longPath }, result("body"));
		const readLine = read.render(55).map(strip).find((line: string) => line.includes("Read"));
		assert.match(readLine!, /Read extensions.*…[\\/]target-file\.ts$/);
		assert.doesNotMatch(
			readLine!,
			new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		);
	} finally { await h.close(); }
});

test("mounted transcript survives mode changes and compaction rebuild events", async () => {
	const h = await harness();
	try {
		h.tool("read", "r", { path: "a" }, result("value"));
		h.tool("bash", "b", { command: "pwd" }, result("workspace"));
		assert.ok(h.root.children.some((c) => c instanceof ToolGroupComponent));
		setConfig({ mode: "off" }); await h.emit("session_tree");
		assert.equal(h.root.children.some((c) => c instanceof ToolGroupComponent), false);
		setConfig({ mode: "on" }); await h.emit("session_compact");
		await h.flush();
		assert.ok(h.root.children.some((c) => c instanceof ToolGroupComponent));
		assert.match(h.render().join("\n"), /2 done/);
	} finally { await h.close(); }
});
