import assert from "node:assert/strict";
import test from "node:test";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { harness, strip } from "./harness.ts";

const plain = (component: { render(width: number): string[] }) => component.render(120).map(strip).join("\n");

const renderers = (label: string) => ({
	renderShell: "self" as const,
	renderCall: (args: any) => new Text(`${label} input: ${args.query}`, 0, 0),
	renderResult: (result: any) => new Text(`${label} output: ${result.content[0].text}`, 0, 0),
});

test("rendererless bash override inherits native tail preview and expands all retained output", async () => {
	const h = await harness({ mode: "off" });
	try {
		const result = { content: [{ type: "text", text: Array.from({ length: 30 }, (_, index) => `retained line ${index + 1}`).join("\n") }], details: {} };
		const definition = { ...h.definitions.bash, renderCall: undefined, renderResult: undefined };
		const row = h.tool("bash", "native-bash", { command: "synthetic-only" }, result, definition);
		assert.match(plain(row), /earlier lines/);
		assert.match(plain(row), /retained line 30/);
		assert.doesNotMatch(plain(row), /retained line 1\b/);
		row.setExpanded(true);
		assert.match(plain(row), /retained line 1\b/);
		assert.match(plain(row), /retained line 30/);
	} finally { await h.close(); }
});

test("public resolvers compose in load order and can render an unknown historical tool", async () => {
	const h = await harness({ mode: "off", extensionFactories: [
		(pi) => pi.registerToolRenderer((name, next) => {
			const downstream = next();
			if (name !== "mcp__synthetic__history") return downstream;
			return { ...downstream, renderCall: (args: any) => new Text(`FIRST ${args.query}`, 0, 0) };
		}),
		(pi) => pi.registerToolRenderer((name, next) => name === "mcp__synthetic__history" ? renderers("SECOND") : next()),
	] });
	try {
		const row = h.tool("mcp__synthetic__history", "unconnected", { query: "retained request" },
			{ content: [{ type: "text", text: "retained response" }], details: {} });
		assert.match(plain(row), /FIRST retained request/);
		assert.doesNotMatch(plain(row), /SECOND input/);
		assert.match(plain(row), /SECOND output: retained response/);
	} finally { await h.close(); }
});

test("same-name custom renderer keeps its own argument semantics instead of builtin read semantics", async () => {
	const h = await harness({ extensionFactories: [(pi) => pi.registerTool({
		name: "read", label: "Custom read", description: "Synthetic override", exposure: "deferred",
		parameters: Type.Object({ query: Type.String() }),
		execute: async (_id, args) => ({ content: [{ type: "text", text: `answer to ${args.query}` }], details: {} }),
		...renderers("OVERRIDE"),
	})] });
	try {
		const args = { query: "not a path" };
		const result = await h.definitions.read.execute("override", args);
		const row = h.tool("read", "override", args, result);
		assert.match(plain(row), /OVERRIDE input: not a path/);
		assert.match(plain(row), /OVERRIDE output: answer to not a path/);
		assert.deepEqual(args, { query: "not a path" });
		assert.deepEqual(result, { content: [{ type: "text", text: "answer to not a path" }], details: {} });
	} finally { await h.close(); }
});

test("a truthy rendererless registered tool still allows an explicit generic renderer fallback", async () => {
	const h = await harness({ extensionFactories: [
		(pi) => pi.registerToolRenderer((name, next) => {
			const downstream = next();
			return name === "plain_probe" && !downstream?.renderCall && !downstream?.renderResult
				? renderers("FALLBACK") : downstream;
		}),
		(pi) => pi.registerTool({ name: "plain_probe", label: "Plain", description: "Synthetic rendererless tool",
			parameters: Type.Object({ query: Type.String() }), exposure: "deferred",
			execute: async (_id, args) => ({ content: [{ type: "text", text: `answer to ${args.query}` }], details: {} }),
		}),
	] });
	try {
		const args = { query: "original request" };
		const result = await h.definitions.plain_probe.execute("plain", args);
		const row = h.tool("plain_probe", "plain", args, result);
		assert.match(plain(row), /FALLBACK input: original request/);
		assert.match(plain(row), /FALLBACK output: answer to original request/);
		const info = h.pi.getAllTools().find((tool: any) => tool.name === "plain_probe");
		assert.equal(info.exposure, "deferred");
		assert.deepEqual(JSON.parse(JSON.stringify(info.parameters)), {
			type: "object", properties: { query: { type: "string" } }, required: ["query"],
		});
		assert.deepEqual(args, { query: "original request" });
		assert.deepEqual(result, { content: [{ type: "text", text: "answer to original request" }], details: {} });
	} finally { await h.close(); }
});
