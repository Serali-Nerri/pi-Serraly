import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition, createPowerShellToolDefinition } from "@earendil-works/pi-coding-agent";
import { setConfig } from "../src/config/config.ts";
import { harness, strip } from "./harness.ts";

const result = { content: [{ type: "text", text: "done" }], isError: false };

test("wide tool summaries use available columns without default character preclipping", async () => {
	const h = await harness();
	try {
		const command = `echo ${"argument ".repeat(14)}WIDE_END`;
		const first = h.tool("bash", "wide-first", { command }, result);
		let lines = first.render(200).map(strip);
		assert.ok(lines.some((line: string) => line.includes("WIDE_END")), lines.join("\n"));
		assert.ok(lines.every((line: string) => visibleWidth(line) <= 176));
		h.tool("bash", "wide-second", { command: `${command} ${"extra ".repeat(20)}` }, result);
		lines = h.root.render(200).map(strip);
		assert.ok(lines.some((line: string) => line.includes("WIDE_END")), lines.join("\n"));
		const summaries = lines.filter((line: string) => /[├└] .*Bash /.test(line));
		assert.equal(summaries.length, 2);
		assert.ok(summaries.every((line: string) => visibleWidth(line) <= 176), summaries.join("\n"));

		setConfig({ inputClip: 40 });
		first.invalidate();
		lines = h.root.render(200).map(strip);
		assert.ok(!lines.some((line: string) => line.includes("WIDE_END")), "explicit positive limits still shorten both summaries");
	} finally { await h.close(); }
});

test("single and grouped eligible tools retain the same command or search meaning", async () => {
	const h = await harness();
	try {
		for (const definition of [createPowerShellToolDefinition(process.cwd()), createGrepToolDefinition(process.cwd()), createFindToolDefinition(process.cwd())]) {
			h.definitions[definition.name] = definition;
			h.toolMetadata.set(definition.name, { name: definition.name, description: definition.description, parameters: definition.parameters, exposure: "direct",
				sourceInfo: { path: `builtin:${definition.name}`, source: "builtin", scope: "temporary", origin: "top-level" } });
		}
		for (const [name, args, expected] of [
			["powershell", { command: "Get-ChildItem -Path src" }, "PowerShell Get-ChildItem -Path src"],
			["grep", { pattern: "needle.*", path: "src" }, 'Grep "needle.*" in src'],
			["find", { pattern: "**/*.ts", path: "extensions" }, 'Find "**/*.ts" in extensions'],
		] as const) {
			h.root.clear();
			const first = h.tool(name, `${name}-first`, args, result);
			assert.ok(first.render(120).map(strip).some((line: string) => line.includes(expected)), `${name} single: ${first.render(120).map(strip).join("\n")}`);
			h.tool(name, `${name}-second`, args, result);
			const grouped = h.root.render(120).map(strip);
			assert.equal(grouped.filter((line: string) => line.includes(expected)).length, 2, grouped.join("\n"));
		}
	} finally { await h.close(); }
});


test("the style panel makes zero adaptive summaries discoverable and saves the choice", async () => {
	const h = await harness();
	try {
		setConfig({ inputClip: 160 });
		const panel = h.commands.get("ccstyle").handler("panel", h.ctx);
		assert.ok(h.overlay);
		for (let page = 0; page < 3; page++) h.overlay!.handleInput!("\t");
		assert.match(h.overlay!.render(100).map(strip).join("\n"), /0 = auto/);
		h.overlay!.handleInput!("\r");
		h.overlay!.handleInput!("\x05"); h.overlay!.handleInput!("\x15");
		h.overlay!.handleInput!("0"); h.overlay!.handleInput!("\r");
		assert.match(h.overlay!.render(100).map(strip).join("\n"), /Summary characters.*\s0/);
		h.overlay!.handleInput!("\x1b");
		await panel;
		const status = h.commands.get("ccstyle").handler("status", h.ctx);
		await status;
		assert.ok(h.notices.some(({ message }) => message.includes("inputClip=0")));
		const call = h.tool("bash", "panel-auto", { command: `echo ${"argument ".repeat(14)}AUTO_END` }, result);
		assert.match(call.render(200).map(strip).join("\n"), /AUTO_END/);
	} finally { h.overlay?.handleInput?.("\x1b"); await h.close(); }
});


test("single and grouped path summaries preserve filenames, graphemes and path separators", async () => {
	const h = await harness();
	try {
		const ls = createLsToolDefinition(process.cwd());
		h.definitions.ls = ls;
		h.toolMetadata.set("ls", { name: "ls", description: ls.description, parameters: ls.parameters, exposure: "direct",
			sourceInfo: { path: "builtin:ls", source: "builtin", scope: "temporary", origin: "top-level" } });
		const filename = "資料-résumé-👩‍💻.ts";
		for (const name of ["read", "ls"]) {
			for (const path of [`${process.cwd()}/${"parent/".repeat(20)}${filename}`, `C:\\project\\${"parent\\".repeat(20)}${filename}`]) {
				h.root.clear();
				const first = h.tool(name, `${name}-path-one`, { path }, result);
				const single = first.render(60).map(strip);
				const title = single.find((line: string) => line.includes(filename));
				assert.ok(title, single.join("\n"));
				assert.ok(title.includes(path.includes("C:") ? `\\${filename}` : `/${filename}`));
				h.tool(name, `${name}-path-two`, { path }, result);
				const grouped = h.root.render(60).map(strip);
				assert.equal(grouped.filter((line: string) => line.includes(filename)).length, 2, grouped.join("\n"));
				assert.ok(grouped.filter((line: string) => /[├└]/.test(line)).every((line: string) => visibleWidth(line) <= 48));
			}
		}
	} finally { await h.close(); }
});

test("explicit character limits never leave a broken command grapheme", async () => {
	const h = await harness();
	setConfig({ inputClip: 8 });
	try {
		for (const grapheme of ["😀", "é", "👩‍💻"]) {
			h.root.clear();
			const tool = h.tool("bash", "grapheme-clip", { command: `123456${grapheme}TAIL` }, result);
			const lines = tool.render(200).map(strip);
			assert.ok(lines.some((line: string) => line.includes("Bash 123456…")), lines.join("\n"));
		}
	} finally { await h.close(); }
});
