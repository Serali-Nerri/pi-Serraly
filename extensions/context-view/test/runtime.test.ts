import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getConfigFilePath } from "../src/config.ts";
import { test } from "node:test";
import { deferredSchemaMarker, host, strip } from "./fixtures/host.ts";
import { wheelEvent } from "./fixtures/mouse.ts";
import contextView from "../src/index.ts";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { Type } from "typebox";

/** Navigate the publicly rendered rows, never a private view model. */
function preview(h: Awaited<ReturnType<typeof host>>, label: string) {
	const view = h.overlays.at(-1)!;
	view.handleInput?.("\x1b[H");
	for (let step = 0; step < 50; step++) {
		if (h.text().split("\n").some((line) => line.includes("›") && line.includes(label))) {
			view.handleInput?.("\r");
			return h.text();
		}
		view.handleInput?.("\x1b[B");
	}
	assert.fail(`No public row: ${label}`);
}

function back(h: Awaited<ReturnType<typeof host>>) { h.overlays.at(-1)!.handleInput?.("\x1b"); }

function rowLabels(h: Awaited<ReturnType<typeof host>>) {
	const view = h.overlays.at(-1)!;
	view.handleInput?.("\x1b[H");
	const labels: string[] = [];
	for (let step = 0; step < 80; step++) {
		const selected = h.text().split("\n").find((line) => line.includes("›"))!;
		if (labels.at(-1) === selected) break;
		labels.push(selected);
		view.handleInput?.("\x1b[B");
	}
	return labels;
}

test("Tools is reachable from Usage and explains unobserved inventory without touching the host", { timeout: 15000 }, async () => {
	const h = await host({ tools: true, inputs: [["t"]] });
	try {
		const entries = h.sessionManager.getEntries(), active = h.session.getActiveToolNames();
		await h.session.prompt("/context");
		assert.match(h.text(), /Tool Diagnostics/);
		assert.match(h.text(), /Not yet observed/);
		assert.match(preview(h, "Observation details"), /before_provider_request.*this extension.*handler/s);
		back(h);
		for (const [name, exposure, state, callable] of [
			["fixture_tool", "direct", "active", "yes"],
			["fixture_model_only", "model-only", "active", "no"],
			["fixture_catalog", "codemode", "inactive", "yes"],
			["fixture_deferred", "deferred", "inactive", "yes"],
			["fixture_hidden", "hidden", "inactive", "no"],
			["fixture_inactive_direct", "direct", "inactive", "no"],
		]) {
			const text = preview(h, name!);
			assert.match(text, new RegExp(`Exposure: ${exposure}`));
			assert.match(text, new RegExp(`Active: ${state}`));
			assert.match(text, new RegExp(`Derived internal callability: ${callable}`));
			assert.match(text, /Source:.*inline.*diagnostic-fixtures/s);
			assert.match(text, /Host state sampled at view open:/);
			assert.doesNotMatch(text, new RegExp(deferredSchemaMarker));
			back(h);
		}
		assert.deepEqual(h.sessionManager.getEntries(), entries);
		assert.deepEqual(h.session.getActiveToolNames(), active);
		assert.equal(h.requests, 0); assert.equal(h.executions, 0);
		assert.deepEqual(h.errors, []);
	} finally { await h.close(); }
});

test("collapsed declarations expose adapter evidence before and after real tool discovery", { timeout: 15000 }, async () => {
	const h = await host({ tools: true });
	try {
		await h.session.prompt("Run the local plan.");
		assert.equal(h.requests, 1);
		assert.doesNotMatch(JSON.stringify(h.observedBodies[0]), new RegExp(deferredSchemaMarker), "absent from the ENTIRE actual observation payload");
		assert.doesNotMatch(JSON.stringify(h.bodies[0]), new RegExp(deferredSchemaMarker), "absent from the entire initial transport payload too");
		await h.session.prompt("/context tools");
		assert.match(h.text(), /Anthropic-shaped collapsed/);
		assert.doesNotMatch(h.text(), /Observed fixture_deferred/);
		const details = preview(h, "Observation details");
		assert.match(details, /Observed at: \d{4}-\d\d-\d\dT/);
		assert.match(details, /purpose unknown.*cache warming/s);
		back(h);
		const eager = preview(h, "Observed fixture_tool");
		assert.match(eager, /Position: \$\.tools\[\d+\]/);
		assert.match(eager, /"input_schema"/);
		assert.match(eager, /"properties": \{\}/, "actual adapter's encoded schema");
		const initialActive = h.session.getActiveToolNames();
		h.respond({ name: "tool_search", input: { query: "Quasarledger", limit: 1 } }, undefined);
		await h.session.prompt("Run the next local plan.");
		assert.equal(h.requests, 3);
		assert.deepEqual(h.session.getActiveToolNames().filter((name) => !initialActive.includes(name)), ["fixture_deferred"]);
		await h.session.prompt("/context tools");
		assert.match(preview(h, "Registered fixture_deferred"), /Active: active/);
		back(h);
		assert.match(preview(h, "Observed fixture_deferred"), new RegExp(deferredSchemaMarker));
		assert.match(JSON.stringify(h.observedBodies[2].tools.find((tool: any) => tool.name === "fixture_deferred")), new RegExp(deferredSchemaMarker));
		assert.deepEqual(h.bodies, h.observedBodies, "with no later rewriting handler, observation leaves the complete ordinary payload unchanged");
		assert.equal(h.executions, 0, "only real discovery runs, not fixture business tools");
		assert.deepEqual(h.errors, []);
	} finally { await h.close(); }
});

test("new unknown, malformed and failed observations replace old evidence without blocking requests or invoking getters", { timeout: 15000 }, async () => {
	let original: unknown, revision = 0, getters = 0;
	const before: ExtensionFactory = (pi) => {
		pi.on("before_provider_request", (event) => {
			original = event.payload;
			const body = event.payload as any;
			switch (revision) {
				case 1: return { unsupported: "PRIVATE_ERROR_CONTENT" };
				case 2: return { ...body, tools: [{ name: "broken", description: "bad", input_schema: 17 }] };
				case 3: return { ...body, tools: null };
				case 4: {
					const tool = { ...body.tools[0] };
					Object.defineProperty(tool, "input_schema", { enumerable: true, get() { getters++; throw new Error("PRIVATE_ERROR_CONTENT"); } });
					return { ...body, tools: [tool] };
				}
				case 5: {
					const schema: any = { type: "object" }; schema.properties = schema;
					return { ...body, tools: [{ name: "cycle", description: "local", input_schema: schema }] };
				}
				case 6: return { ...body, messages: [{ role: { toString() { getters++; return "user"; } }, content: "local" }] };
				case 7: return { ...body, tools: [{ name: "broken", description: "local", input_schema: { type: "object", properties: [] } }] };
				case 8: return { ...body, tools: [{ ...body.tools[0], input_schema: { type: "object", properties: { broken: 17 } } }] };
				case 9: return { ...body, tools: [{ ...body.tools[0], input_schema: { type: "object", properties: {
					broken: { anyOf: [false, { type: "array", items: { additionalProperties: 17 } }] },
				} } }] };
				case 10: return { ...body, tools: [{ ...body.tools[0], strict: "not-a-boolean" }] };
				case 11: return { ...body, tools: [{ ...body.tools[0], eager_input_streaming: 1 }] };
				case 12: return { ...body, tools: [{ ...body.tools[0], cache_control: { type: "persistent" } }] };
				case 13: return { ...body, tools: [{ ...body.tools[0], cache_control: { type: "ephemeral", ttl: "forever" } }] };
				case 14: return { ...body, tools: [{ ...body.tools[0], cache_control: 17 }] };
			}
		});
	};
	const after: ExtensionFactory = (pi) => {
		pi.on("before_provider_request", () => original);
	};
	const h = await host({ factories: [before, contextView, after] });
	try {
		await h.session.prompt("First normal request.");
		await h.session.prompt("/context tools");
		assert.match(preview(h, "Observed fixture_tool"), /"input_schema"/);
		for (revision = 1; revision <= 14; revision++) {
			await h.session.prompt("Next normal request.");
			assert.equal(h.session.messages.at(-1)?.role, "assistant");
			await h.session.prompt("/context tools");
			assert.match(h.text(), /Unknown:/, `malformed observation ${revision}`);
			assert.doesNotMatch(h.text(), /Observed fixture_tool|Anthropic-shaped collapsed/);
			const details = preview(h, "Observation details");
			assert.match(details, /Observed at: \d{4}/);
			assert.doesNotMatch(details, /PRIVATE_ERROR_CONTENT/);
			back(h);
			assert.match(preview(h, "Registered fixture_tool"), /Exposure: direct/);
		}
		assert.equal(getters, 0, "read-only observation must not run payload accessors");
		assert.equal(h.requests, 15, "decode failures do not block the ordinary transport");
		assert.deepEqual(h.errors, []); assert.deepEqual(h.notices, []);
	} finally { await h.close(); }
});

test("real native additions expose schema positions and distinguish the adapter placeholder from effective tools", { timeout: 15000 }, async () => {
	const h = await host({ tools: true, native: true });
	try {
		await h.session.prompt("First native local plan.");
		assert.ok(h.bodies[0].tools.some((tool: any) => tool.name === "__pi_deferred_placeholder__"));
		assert.doesNotMatch(JSON.stringify(h.observedBodies[0]), new RegExp(deferredSchemaMarker), "schema-only marker absent globally before loading");
		await h.session.prompt("/context tools");
		assert.match(preview(h, "Observation details"), /Anthropic-shaped native.*effective declarations/s);
		back(h);
		assert.match(preview(h, "Adapter placeholder"), /Never callable.*excluded from effective declarations/s);
		back(h);
		assert.doesNotMatch(h.text(), /Registered __pi_deferred_placeholder__|Observed __pi_deferred_placeholder__/);
		h.respond({ name: "tool_search", input: { query: "Quasarledger", limit: 1 } }, undefined);
		await h.session.prompt("Next native local plan.");
		assert.match(JSON.stringify(h.bodies[2].messages), /tool_addition/);
		await h.session.prompt("/context tools");
		assert.match(preview(h, "Registered fixture_deferred"), /Active: active/);
		back(h);
		const definition = preview(h, "Observed fixture_deferred");
		assert.match(definition, /Position: \$\.messages\[\d+\]\.content\[\d+\]\.tool\.definition/);
		assert.match(definition, new RegExp(deferredSchemaMarker));
		back(h);
		assert.match(preview(h, "Update + fixture_deferred"), /Native addition.*input_schema/s);
		assert.equal(h.executions, 0);
		for (let index = 0; index < h.requests; index++) {
			assert.deepEqual(h.bodies[index].tools, h.observedBodies[index].tools);
			assert.deepEqual(h.bodies[index].messages, h.observedBodies[index].messages, "native protocol unchanged; SDK moves betas to headers after observation");
		}
		assert.deepEqual(h.errors, []);
	} finally { await h.close(); }
});

test("unparseable native updates replace effective evidence with unknown and later handlers still deliver the real request", { timeout: 15000 }, async () => {
	let revision = 0, original: unknown, getters = 0;
	const before: ExtensionFactory = (pi) => {
		pi.on("before_provider_request", (event) => {
			original = event.payload;
			if (!revision) return;
			const body = JSON.parse(JSON.stringify(event.payload));
			const message = body.messages.find((message: any) => message.content?.some?.((block: any) => block.type === "tool_addition"));
			const block = message.content.find((block: any) => block.type === "tool_addition");
			switch (revision) {
				case 1: block.tool.unrecognized_definitions = []; break;
				case 2: block.tool.type = "tool_reference"; break;
				case 3: block.tool.definition = null; break;
				case 4: message.role = "user"; break;
				case 5: delete body.tools; break;
				case 6: body.tools.find((tool: any) => tool.name === "__pi_deferred_placeholder__").description = "Not the known placeholder"; break;
				case 7: block.tool.definition.defer_loading = true; break;
				case 8: Object.defineProperty(block.tool, "definition", { get() { getters++; throw new Error("PRIVATE_NATIVE_ERROR"); } }); break;
				case 9: block.tool.definition = Object.assign([], block.tool.definition); break;
				case 10: body.tools = body.tools.filter((tool: any) => tool.name !== "__pi_deferred_placeholder__"); break;
				case 11: block.tool.definition.input_schema = { type: "object", $defs: { broken: { patternProperties: { ".*": 17 } } } }; break;
				case 12: block.tool.definition.strict = "not-a-boolean"; break;
				case 13: block.cache_control = { type: "ephemeral", ttl: "forever" }; break;
			}
			return body;
		});
	};
	const after: ExtensionFactory = (pi) => { pi.on("before_provider_request", () => original); };
	const h = await host({ tools: true, native: true, factories: [before, contextView, after] });
	try {
		h.respond({ name: "tool_search", input: { query: "Quasarledger", limit: 1 } }, undefined);
		await h.session.prompt("Local native search.");
		await h.session.prompt("/context tools");
		assert.match(preview(h, "Observed fixture_deferred"), new RegExp(deferredSchemaMarker));
		for (revision of [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13]) {
			await h.session.prompt("Local native follow-up.");
			await h.session.prompt("/context tools");
			assert.match(h.text(), /Unknown:/, `unsupported native shape ${revision}`);
			assert.ok(!rowLabels(h).some((line) => /Observed fixture|Update [+−]|Adapter placeholder/.test(line)));
			assert.match(preview(h, "Observation details"), /Observed at:/);
			assert.doesNotMatch(h.text(), /PRIVATE_NATIVE_ERROR|effective declarations/);
			assert.equal(h.session.messages.at(-1)?.role, "assistant");
		}
		revision = 10;
		await h.session.prompt("Local native protocol without scaffolding at observation.");
		await h.session.prompt("/context tools");
		assert.match(preview(h, "Observed fixture_deferred"), new RegExp(deferredSchemaMarker), "native blocks are recognized independently of the placeholder");
		back(h);
		assert.ok(!rowLabels(h).some((line) => line.includes("Adapter placeholder")));
		assert.equal(getters, 0); assert.equal(h.requests, 15); assert.deepEqual(h.errors, []); assert.deepEqual(h.notices, []);
	} finally { await h.close(); }
});

for (const native of [false, true]) test(`supported recursive schemas, boolean subschemas and declaration options remain inspectable (${native ? "native" : "collapsed"})`, { timeout: 15000 }, async () => {
	let original: unknown, revision = 0;
	const fixture: ExtensionFactory = (pi) => {
		pi.registerTool({ name: "shape_schema", label: "shape_schema", description: "Shapeschemafixture structured input", exposure: native ? "deferred" : "direct",
			parameters: Type.Object({
				nested: Type.Object({ choice: Type.Union([Type.String(), Type.Null()]), tuple: Type.Tuple([Type.String(), Type.Boolean()]) }),
				list: Type.Array(Type.Object({ value: Type.Optional(Type.Number()) })),
			}, { additionalProperties: false }),
			async execute() { assert.fail("Schema inspection must not run tools"); } });
		pi.on("before_provider_request", (event) => {
			original = event.payload;
			const body = JSON.parse(JSON.stringify(event.payload));
			const tool = native ? body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
				.find((block: any) => block.type === "tool_addition" && block.tool.definition.name === "shape_schema")?.tool.definition
				: body.tools.find((tool: any) => tool.name === "shape_schema");
			if (!tool) return;
			const schema = tool.input_schema;
			schema.$defs = { anything: true, nothing: false, recursive: { properties: { next: { $ref: "#/$defs/recursive" } } } };
			schema.properties.free = true; schema.properties.forbidden = false;
			schema.properties.nullable = { type: ["string", "null"] };
			schema.properties.tuple = { type: "array", prefixItems: [true, { type: "string" }], items: false, contains: true, unevaluatedItems: false };
			schema.dependentSchemas = { nested: { required: ["list"] } };
			schema.dependentRequired = { nested: ["list"] };
			schema.if = { required: ["nested"] }; schema.then = true; schema.else = false;
			// Annotation/instance data is not a subschema, even when it has schema-like keys.
			schema["x-fixture-annotation"] = { properties: 17, marker: "STRUCTURAL_ANNOTATION" };
			schema.properties.literal = { const: { properties: 17 } };
			tool.strict = revision !== 1;
			tool.eager_input_streaming = [null, false, true][revision];
			tool.cache_control = [null, { type: "ephemeral", ttl: "5m" }, { type: "ephemeral", ttl: "1h" }][revision];
			return body;
		});
	};
	const after: ExtensionFactory = (pi) => { pi.on("before_provider_request", () => original); };
	const h = await host({ native, tools: native, factories: [fixture, contextView, after] });
	try {
		if (native) h.respond({ name: "tool_search", input: { query: "Shapeschemafixture", limit: 1 } }, undefined);
		for (revision = 0; revision < 3; revision++) {
			await h.session.prompt("Ordinary structured local request.");
			assert.equal(h.session.messages.at(-1)?.role, "assistant");
			await h.session.prompt("/context tools");
			assert.match(h.text(), native ? /Anthropic-shaped native/ : /Anthropic-shaped collapsed/);
			assert.match(preview(h, "Observed shape_schema"), native ? /Position: \$\.messages\[/ : /Position: \$\.tools\[/);
			const view = h.overlays.at(-1)!;
			view.handleInput?.("\x1b[F");
			assert.match(h.text(), /STRUCTURAL_ANNOTATION/);
			assert.match(h.text(), new RegExp(`"strict": ${revision !== 1}`));
			assert.match(h.text(), new RegExp(`"eager_input_streaming": ${["null", "false", "true"][revision]}`));
			assert.match(h.text(), revision === 0 ? /"cache_control": null/ : new RegExp(`"ttl": "${revision === 1 ? "5m" : "1h"}"`));
		}
		assert.equal(h.requests, native ? 4 : 3); assert.equal(h.executions, 0);
		assert.deepEqual(h.errors, []); assert.deepEqual(h.notices, []);
	} finally { await h.close(); }
});

for (const kimi of [false, true]) test(`${kimi ? "Kimi collapsed" : "Anthropic native"} removal and same-name redefinitions do not turn history into current tools`, { timeout: 15000 }, async () => {
	let revision = 0;
	const change: ExtensionFactory = (pi) => {
		const define = (version: string) => pi.registerTool({ name: "fixture_version", label: "Version", description: version,
			parameters: Type.Object({ value: Type.String({ description: version }) }),
			async execute() { assert.fail("History inspection must not run tools"); } });
		define("VERSION_ONE");
		pi.on("before_agent_start", () => {
			if (revision === 1 || revision === 4) pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "fixture_version"));
			if (revision === 2 || revision === 3) {
				define(revision === 2 ? "VERSION_TWO" : "VERSION_THREE");
				pi.setActiveTools([...pi.getActiveTools(), "fixture_version"]);
			}
		});
	};
	const h = await host({ kimi, tools: true, native: true, factories: [change, contextView] });
	try {
		for (revision = 0; revision <= 4; revision++) {
			await h.session.prompt("Next local version plan.");
			await h.session.prompt("/context tools");
			if (revision === 0 || revision === 2 || revision === 3) {
				assert.match(preview(h, "Observed fixture_version"), new RegExp(["VERSION_ONE", "", "VERSION_TWO", "VERSION_THREE"][revision]!));
				back(h);
			} else assert.ok(!rowLabels(h).some((line) => line.includes("Observed fixture_version")), "withdrawn definition is not effective");
		}
		if (kimi) {
			assert.match(h.text(), /OpenAI Chat Completions-shaped collapsed/);
			assert.doesNotMatch(rowLabels(h).join("\n"), /Baseline |Update [＋+−]/);
		} else {
			assert.match(preview(h, "Baseline fixture_version"), /Initial baseline.*not necessarily effective.*VERSION_ONE/s);
			back(h);
			const labels = rowLabels(h).filter((line) => line.includes("Update") && line.includes("fixture_version"));
			assert.deepEqual(labels.map((line) => /Update ([+−])/.exec(line)![1]), ["−", "+", "+", "−"]);
			assert.match(preview(h, "Update + fixture_version"), /VERSION_TWO/, "old additions remain inspectable as history");
			back(h);
			assert.match(preview(h, "Update − fixture_version"), /Position: \$\.messages\[\d+\]\.content\[\d+\]\.tool\.name/);
			back(h);
			assert.ok(!rowLabels(h).some((line) => line.includes("Observed fixture_version")));
			assert.match(JSON.stringify(h.bodies.at(-1).messages), /tool_removal.*tool_addition/s, "real adapter emits both protocols");
		}
		assert.equal(h.requests, 5); assert.equal(h.executions, 0); assert.deepEqual(h.errors, []);
	} finally { await h.close(); }
});

for (const kimi of [false, true]) for (const native of [false, true]) test(`the ${kimi ? "Chat" : "Anthropic"} handler owns ${native ? "native addition" : "collapsed"} schema while later in-place and replacement handlers reach the transport`, { timeout: 15000 }, async () => {
	let replacement = false;
	const schemaKey = kimi ? "parameters" : "input_schema";
	const target = (body: any) => kimi
		? (native ? body.messages.flatMap((message: any) => message.tools ?? []).find((tool: any) => tool.function.name === "fixture_deferred")?.function : undefined)
			?? body.tools.find((tool: any) => tool.function.name === "fixture_tool").function
		: native
		? body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []).find((block: any) => block.type === "tool_addition")?.tool.definition
			?? body.tools.find((tool: any) => tool.name === "fixture_tool")
		: body.tools.find((tool: any) => tool.name === "fixture_tool");
	const before: ExtensionFactory = (pi) => {
		pi.on("before_provider_request", (event) => {
			const body = event.payload as any;
			const tool = target(body);
			tool[schemaKey].properties.AT_OBSERVER_指令 = { type: "string", description: "Observed here." };
			(kimi ? body : tool).unrelated_envelope = { text: "UNNEEDED_PRIVATE_ENVELOPE" };
		});
	};
	const later: ExtensionFactory = (pi) => {
		pi.on("before_provider_request", (event) => {
			const body = event.payload as any;
			const tool = target(body);
			assert.equal(Object.isFrozen(body), false); assert.equal(Object.isFrozen(tool[schemaKey].properties), false);
			if (replacement) {
				const rewritten = JSON.parse(JSON.stringify(body));
				target(rewritten)[schemaKey] = { type: "object", properties: { AFTER_REPLACEMENT: { type: "number" } } };
				return rewritten;
			}
			delete tool[schemaKey].properties.AT_OBSERVER_指令;
			tool[schemaKey].properties.AFTER_IN_PLACE = { type: "boolean" };
		});
	};
	const h = await host({ kimi, native, tools: native, factories: [before, contextView, later] });
	try {
		if (native) h.respond({ name: "tool_search", input: { query: "Quasarledger", limit: 1 } }, undefined);
		for (replacement of [false, true]) {
			await h.session.prompt("A normal local request.");
			await h.session.prompt("/context tools");
			const text = preview(h, native ? "Observed fixture_deferred" : "Observed fixture_tool");
			assert.match(text, /AT_OBSERVER_指令/);
			assert.doesNotMatch(text, /AFTER_IN_PLACE|AFTER_REPLACEMENT|UNNEEDED_PRIVATE_ENVELOPE/);
			assert.match(JSON.stringify(target(h.bodies.at(-1))), replacement ? /AFTER_REPLACEMENT/ : /AFTER_IN_PLACE/);
			assert.doesNotMatch(JSON.stringify(target(h.bodies.at(-1))), /AT_OBSERVER/);
			assert.equal(h.session.messages.at(-1)?.role, "assistant");
		}
		await h.session.prompt("/context usage");
		assert.match(h.text(), /Context Usage/);
		assert.doesNotMatch(h.text(), /Anthropic-shaped|Observed at:/);
		const view = h.overlays.at(-1)!;
		view.handleInput?.("\x1b[B"); view.handleInput?.("\r");
		assert.doesNotMatch(h.text(), /AT_OBSERVER|AFTER_IN_PLACE|AFTER_REPLACEMENT/, "canonical transcript estimates are not request observations");
		assert.equal(h.requests, native ? 3 : 2); assert.deepEqual(h.errors, []);
	} finally { await h.close(); }
});

for (const native of [false, true]) test(`observation stays latest-only and process-local across public reload and independent runtimes (${native ? "native" : "collapsed"})`, { timeout: 15000 }, async () => {
	let counter = 0;
	const change: ExtensionFactory = (pi) => {
		pi.on("before_provider_request", (event) => {
			const body = event.payload as any;
			body.tools.find((tool: any) => tool.name === "fixture_tool").description = ++counter === 1 ? "FIRST_PRIVATE_SCHEMA" : "LATEST_PRIVATE_SCHEMA";
		});
	};
	const h = await host({ native, factories: [change, contextView] });
	try {
		const agentFiles = await readdir(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
		await h.session.prompt("First ordinary request.");
		await h.session.prompt("/context tools");
		assert.match(preview(h, "Observed fixture_tool"), /FIRST_PRIVATE_SCHEMA/);
		await h.session.prompt("Second ordinary request.");
		const entries = h.sessionManager.getEntries(), files = await readdir(h.base, { recursive: true });
		await h.session.prompt("/context tools");
		assert.match(preview(h, "Observed fixture_tool"), /LATEST_PRIVATE_SCHEMA/);
		assert.doesNotMatch(h.text(), /FIRST_PRIVATE_SCHEMA/);
		assert.deepEqual(h.sessionManager.getEntries(), entries);
		assert.equal(entries.filter((entry) => entry.type === "custom").length, 0);
		assert.deepEqual(await readdir(h.base, { recursive: true }), files);
		for (const file of files) {
			try { assert.doesNotMatch(await readFile(join(h.base, file), "utf8"), /FIRST_PRIVATE_SCHEMA|LATEST_PRIVATE_SCHEMA/); }
			catch (error: any) { if (error.code !== "EISDIR") throw error; }
		}
		assert.deepEqual(await readdir(process.env.PI_CODING_AGENT_DIR!, { recursive: true }), agentFiles, "no request files in the owned agent directory");
		const other = await host({ sessionManager: h.sessionManager });
		try {
			await other.session.prompt("/context tools");
			assert.match(other.text(), /Not yet observed/);
			assert.equal(other.requests, 0);
			await other.session.prompt("A normal request in the independent runtime.");
			await other.session.prompt("/context tools");
			assert.match(preview(other, "Observed fixture_tool"), /Local operation/);
			await h.session.prompt("/context tools");
			assert.match(preview(h, "Observed fixture_tool"), /LATEST_PRIVATE_SCHEMA/, "other runtime does not replace this runtime's observation");
		} finally { await other.close(); }
		await h.session.reload();
		await h.session.prompt("/context tools");
		assert.match(h.text(), /Not yet observed/);
		assert.doesNotMatch(h.text(), /Observed fixture_tool|PRIVATE_SCHEMA/);
		assert.equal(h.requests, 2); assert.equal(h.executions, 0); assert.deepEqual(h.errors, []);
	} finally { await h.close(); }
});

test("tool inventory's derived callability agrees with benign real nested calls, not active alone", { timeout: 15000 }, async () => {
	const h = await host({ tools: true });
	try {
		h.respond({ name: "fixture_nested" }, undefined);
		await h.session.prompt("Run the benign local check.");
		assert.equal(h.nested.length, 1);
		assert.equal(h.executions, 3);
		assert.deepEqual(h.nested[0]!.callable.filter((name) => name.startsWith("fixture_")),
			["fixture_tool", "fixture_deferred", "fixture_catalog", "fixture_nested"]);
		for (const name of ["fixture_model_only", "fixture_hidden", "fixture_inactive_direct"]) assert.equal(h.nested[0]!.outcomes[name], true);
		for (const name of ["fixture_tool", "fixture_deferred", "fixture_catalog"]) assert.notEqual(h.nested[0]!.outcomes[name], true);
		await h.session.prompt("/context tools");
		assert.match(preview(h, "Registered fixture_model_only"), /Derived internal callability: no/);
		back(h);
		assert.match(preview(h, "Observed fixture_model_only"), /"input_schema"/);
		back(h);
		assert.match(preview(h, "Registered fixture_deferred"), /Active: inactive.*Derived internal callability: yes/s);
		assert.equal(h.executions, 3, "viewer does not perform additional callability checks");
		assert.equal(h.requests, 2); assert.deepEqual(h.errors, []);
	} finally { await h.close(); }
});

for (const native of [false, true]) test(`real codemode only keeps eager active with inline description, executes benign calls and searches without activating deferred tools (${native ? "native" : "collapsed"})`, { timeout: 15000 }, async () => {
	const h = await host({ tools: true, codemodeMode: "only", native });
	try {
		await h.session.prompt("Local inline plan.");
		assert.doesNotMatch(JSON.stringify(h.observedBodies[0]), new RegExp(deferredSchemaMarker), "schema-only marker initially absent from the whole observation");
		assert.ok(h.session.getActiveToolNames().includes("fixture_tool"));
		assert.ok(!h.bodies[0].tools.some((tool: any) => tool.name === "fixture_tool"));
		assert.match(h.bodies[0].tools.find((tool: any) => tool.name === "codemode").description, /fixture_tool/);
		await h.session.prompt("/context tools");
		assert.match(preview(h, "Registered fixture_tool"), /Active: active.*Derived internal callability: yes/s);
		back(h);
		assert.ok(!rowLabels(h).some((line) => /Observed fixture_tool|Observed fixture_catalog|Observed fixture_deferred/.test(line)));
		const description = preview(h, "Codemode description");
		assert.match(description, /Description content.*not independent declarations/s);
		const view = h.overlays.at(-1)!;
		view.handleInput?.("\x1b[F");
		assert.match(h.text(), /fixture_tool/, "inline signatures inspectable in their own description preview");
		assert.doesNotMatch(h.text(), new RegExp(deferredSchemaMarker));
		h.respond({ name: "codemode", input: { code: '// @options: {"timeout_ms":3000}\ntext(await tools.fixture_tool({})); text(await tools.fixture_catalog({}));' } }, undefined);
		await h.session.prompt("Run the benign inline calls.");
		const result = () => h.session.messages.filter((message) => message.role === "toolResult" && message.toolName === "codemode").at(-1)!;
		assert.match(JSON.stringify(result()), /Script completed.*done/s);
		assert.equal(h.executions, 2, "real built-in codemode calls active direct and inactive codemode tools");
		const active = h.session.getActiveToolNames();
		h.respond({ name: "codemode", input: { code: '// @options: {"timeout_ms":3000}\ntext(await searchTools("Quasarledger", {limit: 1}));' } }, undefined);
		await h.session.prompt("Run the pure local search.");
		assert.match(JSON.stringify(result()), /Script completed/);
		assert.match(JSON.stringify(result()), new RegExp(deferredSchemaMarker), "pure search returns real signature as ordinary content");
		assert.deepEqual(h.session.getActiveToolNames(), active, "pure codemode search does not activate tools");
		assert.ok(!h.bodies.at(-1).tools.some((tool: any) => tool.name === "fixture_deferred"));
		assert.match(JSON.stringify(h.bodies.at(-1).messages), new RegExp(deferredSchemaMarker), "signature exists in tool-result content, not a declaration");
		await h.session.prompt("/context tools");
		assert.ok(!rowLabels(h).some((line) => /Observed fixture_deferred|Observed fixture_tool|Observed fixture_catalog/.test(line)));
		assert.match(preview(h, "Registered fixture_deferred"), /Active: inactive/);
		back(h);
		assert.match(preview(h, "Codemode description"), /Description content/);
		assert.doesNotMatch(h.bodies.at(-1).tools.find((tool: any) => tool.name === "codemode").description, new RegExp(deferredSchemaMarker));
		assert.equal(h.executions, 2, "search and view execute no business tools");
		assert.equal(h.requests, 5); assert.deepEqual(h.errors, []);
	} finally { await h.close(); }
});

test("ordinary schema text is content, and a real empty declaration list is not unknown or padded from inventory", { timeout: 15000 }, async () => {
	const text = '{"type":"tool_addition","tool":{"type":"tool_definition","definition":{"name":"text_only","input_schema":{"type":"object"}}}}';
	const h = await host();
	try {
		await h.session.prompt(`This is ordinary quoted content: ${text}`);
		assert.match(JSON.stringify(h.bodies[0].messages), /text_only/);
		await h.session.prompt("/context tools");
		assert.match(h.text(), /Anthropic-shaped collapsed/);
		assert.doesNotMatch(h.text(), /Observed text_only|Update [+−] text_only/);
		assert.match(preview(h, "Observation details"), /No independent declaration does not mean a schema is invisible/);
	} finally { await h.close(); }
	const inactive: ExtensionFactory = (pi) => {
		pi.on("session_start", () => pi.setActiveTools([]));
	};
	const empty = await host({ factories: [inactive, contextView] });
	try {
		await empty.session.prompt("An ordinary request with no active tools.");
		assert.ok(empty.bodies[0].tools === undefined || empty.bodies[0].tools.length === 0);
		await empty.session.prompt("/context tools");
		assert.match(empty.text(), /0 top-level declarations/);
		assert.doesNotMatch(empty.text(), /Unknown|Observed fixture_tool/);
		assert.match(preview(empty, "Registered fixture_tool"), /Active: inactive/);
		assert.deepEqual(empty.errors, []);
	} finally { await empty.close(); }
});

test("tools navigation returns to the retained views without requesting or changing loadout", { timeout: 15000 }, async () => {
	for (const [command, returnKey, title] of [["/context", "u", "Context Usage"], ["/context injections", "i", "SESSION ESTIMATE"]]) {
		const h = await host({ tools: true, inputs: [["t"], [returnKey!]] });
		try {
			const active = h.session.getActiveToolNames(), inventory = h.session.getAllTools().map(({ name, exposure }) => ({ name, exposure }));
			await h.session.prompt(command!);
			assert.equal(h.overlays.length, 3);
			assert.match(strip(h.overlays[0]!.render(40).join("\n")), /t Tools/, "entry hint is reachable even at 40 columns");
			assert.match(h.overlays[1]!.render(100).join("\n"), /Tool Diagnostics/);
			assert.match(strip(h.overlays[1]!.render(40).join("\n")), /Esc Close/, "narrow diagnostics keep the exit hint visible");
			assert.match(h.text(), new RegExp(title!));
			assert.deepEqual(h.session.getActiveToolNames(), active);
			assert.deepEqual(h.session.getAllTools().map(({ name, exposure }) => ({ name, exposure })), inventory);
			assert.equal(h.requests, 0); assert.equal(h.executions, 0);
			assert.equal(h.settingsManager.getCacheWarmingMode(), "off");
			assert.deepEqual(h.session.messages, []); assert.deepEqual(h.errors, []);
		} finally { await h.close(); }
	}
});

for (const native of [false, true]) test(`observed long multilingual ${native ? "native" : "collapsed"} schema previews wrap, scroll, sanitize and return without side effects`, { timeout: 15000 }, async () => {
	const fixture: ExtensionFactory = (pi) => {
		pi.registerTool({ name: "long_schema", label: "long_schema", description: "Longschemafixture multilingual preview", exposure: native ? "deferred" : "direct",
			parameters: Type.Object({ value: Type.String({ description: `START_指令 ${"\u001b]52;c;ignored\u0007"}${"长文字 schema ".repeat(500)} END_指令` }) }),
			async execute() { assert.fail("Viewer must not execute this tool"); } });
		pi.on("before_provider_request", (event) => {
			const body = event.payload as any;
			const tool = native ? body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
				.find((block: any) => block.type === "tool_addition" && block.tool.definition.name === "long_schema")?.tool.definition
				: body.tools.find((tool: any) => tool.name === "long_schema");
			if (tool) tool.name += "\u001b]52;c;blocked\u0007";
		});
	};
	const h = await host({ native, tools: native, factories: [fixture, contextView] });
	try {
		if (native) h.respond({ name: "tool_search", input: { query: "Longschemafixture", limit: 1 } }, undefined);
		await h.session.prompt("One ordinary request.");
		const entries = h.sessionManager.getEntries(), files = await readdir(h.base, { recursive: true });
		await h.session.prompt("/context tools");
		const initialPreview = preview(h, "Observed long_schema");
		assert.match(initialPreview, /START_指令/);
		assert.doesNotMatch(initialPreview, /\u001b\]52|\u0007/, "untrusted preview headings must be sanitized too");
		const view = h.overlays.at(-1)! as typeof h.overlays[number] & { handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined };
		for (const width of [40, 80, 120]) {
			for (const line of view.render(width)) assert.ok(visibleWidth(line) <= width, `schema fits ${width}`);
			const frame = () => strip(view.render(width).join("\n"));
			view.handleInput?.("\x1b[H"); const start = frame();
			view.handleInput?.("\x1b[6~"); assert.notEqual(frame(), start, "PgDn scrolls the preview");
			view.handleInput?.("\x1b[F"); assert.match(frame(), /END_指令/);
			view.handleInput?.("\x1b[H"); assert.equal(frame(), start, "Home restores the start");
			assert.deepEqual(view.handleMouse({ type: "wheel", wheelDelta: 7 } as TuiMouseEvent), { handled: true, render: true });
			assert.notEqual(frame(), start, "public logical wheel delta scrolls");
			assert.doesNotMatch(frame(), /\u001b\]52|\u0007/, "no executable OSC or control bytes");
		}
		back(h); assert.match(h.text(), /Tool Diagnostics/);
		assert.equal(h.requests, native ? 2 : 1); assert.equal(h.executions, 0);
		assert.deepEqual(h.sessionManager.getEntries(), entries);
		assert.deepEqual(await readdir(h.base, { recursive: true }), files);
		assert.deepEqual(h.errors, []);
	} finally { await h.close(); }
});

for (const command of ["/context usage", "/context injections"]) test(`${command} forwards public wheel deltas to long content previews`, { timeout: 15000 }, async () => {
	const prompt = Array.from({ length: 60 }, (_, index) => `PUBLIC_WHEEL_LINE_${index}`).join("\n");
	const fixture: ExtensionFactory = (pi) => {
		pi.on("before_agent_start", () => ({ systemPrompt: prompt }));
	};
	const h = await host({ factories: [fixture, contextView] });
	try {
		await h.session.prompt(prompt);
		const entries = h.sessionManager.getEntries(), active = h.session.getActiveToolNames();
		await h.session.prompt(command);
		const view = h.overlays.at(-1)!;
		if (command === "/context injections") view.handleInput?.("\x1b[B");
		else {
			for (let step = 0; step < 30 && !h.text().split("\n").some((line) => /→.*User Messages/.test(line)); step++)
				view.handleInput?.("\x1b[B");
			assert.match(h.text(), /→.*User Messages/);
		}
		view.handleInput?.("\r");
		assert.match(h.text(), /PUBLIC_WHEEL_LINE_0(?:\s|$)/);
		assert.deepEqual(view.handleMouse?.(wheelEvent(7)), { handled: true, render: true });
		const scrolled = h.text();
		assert.doesNotMatch(scrolled, /PUBLIC_WHEEL_LINE_0(?:\s|$)/);
		assert.match(scrolled, /PUBLIC_WHEEL_LINE_7(?:\s|$)/);
		view.handleMouse?.(wheelEvent(-7));
		assert.match(h.text(), /PUBLIC_WHEEL_LINE_0(?:\s|$)/);
		back(h); assert.match(h.text(), command === "/context usage" ? /Context Usage/ : /LATEST/);
		assert.equal(h.requests, 1); assert.equal(h.executions, 0);
		assert.deepEqual(h.sessionManager.getEntries(), entries);
		assert.deepEqual(h.session.getActiveToolNames(), active);
		assert.deepEqual(h.errors, []);
	} finally { await h.close(); }
});

test("opening and previewing before capture leaves the conversation untouched and labels estimates", { timeout: 15000 }, async () => {
	const h = await host();
	try {
		const before = h.sessionManager.getEntries();
		for (const command of ["/context", "/context usage", "/context injections"]) {
			await h.session.prompt(command);
			assert.deepEqual(h.errors, [], "public view command succeeds");
			assert.deepEqual(h.sessionManager.getEntries(), before, "viewing must not create messages or custom entries");
			assert.match(h.text(), /Not captured.*Session estimate/s);
			const view = h.overlays.at(-1)!;
			view.handleInput?.("\r");
			view.render(40);
			view.handleInput?.("\x1b[B");
			view.handleInput?.("\x1b");
		}
		assert.equal(h.requests, 0);
		assert.equal(h.executions, 0);
		assert.deepEqual(h.session.messages, []);
		assert.deepEqual(h.errors, []);
		assert.equal(h.settingsManager.getCacheWarmingMode(), "off");
	} finally { await h.close(); }
});


test("normal requests pass through, replace Latest after completion, and reload cannot replay capture", { timeout: 15000 }, async () => {
	const h = await host();
	try {
		await h.session.prompt("Hello local fixture");
		assert.equal(h.requests, 1);
		assert.match(JSON.stringify(h.bodies[0]), /FIRST_CJK_指令/);
		assert.match(JSON.stringify(h.bodies[0]), /INITIAL_PRIVATE_CONTENT/);
		assert.equal(h.session.messages.at(-1)?.role, "assistant");
		assert.equal(h.executions, 0);
		assert.deepEqual(h.errors, []);
		const entries = h.sessionManager.getEntries();
		assert.equal(entries.filter((entry) => entry.type === "custom").length, 0);
		const files = await readdir(h.base, { recursive: true });
		await h.session.prompt("/context injections");
		assert.doesNotMatch(h.text(), /Not captured/);
		const view = h.overlays.at(-1)!;
		view.handleInput?.("\x1b[B");
		view.handleInput?.("\r");
		assert.match(h.text(), /FIRST_CJK_指令/);
		view.handleInput?.("\x1b");
		await h.session.prompt("/context usage");
		assert.match(h.text(), /Context Usage/);
		assert.deepEqual(h.sessionManager.getEntries(), entries, "view/preview adds no session entries");
		assert.deepEqual(await readdir(h.base, { recursive: true }), files, "view/preview adds no files");
		await h.session.prompt("Second local fixture");
		assert.equal(h.requests, 2);
		assert.match(JSON.stringify(h.bodies[1]), /SECOND_CJK_指令/);
		await h.session.prompt("/context injections");
		const latest = h.overlays.at(-1)!;
		latest.handleInput?.("\x1b[B");
		latest.handleInput?.("\r");
		assert.match(h.text(), /SECOND_CJK_指令/);
		assert.doesNotMatch(h.text(), /FIRST_CJK_指令/);
		await h.session.reload();
		await h.session.prompt("/context injections");
		assert.match(h.text(), /Not captured.*Session estimate/s);
		assert.equal(h.requests, 2, "reload and inspection do not request a model");
		assert.equal(h.executions, 0);
		assert.deepEqual(h.errors, []);
	} finally { await h.close(); }
});

test("print mode refuses views but explicitly creates only owned display preferences", { timeout: 15000 }, async () => {
	const h = await host({ mode: "print" });
	try {
		for (const command of ["/context", "/context injections", "/context tools"]) await h.session.prompt(command);
		assert.equal(h.overlays.length, 0);
		assert.ok(h.notices.every((notice) => /TUI mode only/.test(notice)));
		const configPath = getConfigFilePath();
		await assert.rejects(readFile(configPath), { code: "ENOENT" });
		await h.session.prompt("/context config");
		const preferences = await readFile(configPath, "utf8");
		assert.equal(JSON.parse(preferences).mapCols, 16);
		assert.equal(Object.keys(JSON.parse(preferences)).length, 17);
		assert.doesNotMatch(preferences, /PRIVATE_CONTENT|CJK|messages|parameters/);
		await h.session.prompt("/context config");
		assert.equal(await readFile(configPath, "utf8"), preferences);
		assert.match(h.notices.at(-1)!, /already exists; left unchanged/);
		await assert.rejects(readFile(join(process.env.PI_CODING_AGENT_DIR!, "extensions/pi-context-view.json")), { code: "ENOENT" });
		assert.equal(h.requests, 0);
		assert.equal(h.executions, 0);
		assert.deepEqual(h.errors, []);
	} finally { await h.close(); }
});

test("Kimi Chat Completions declarations appear with their actual function parameters at the public command", { timeout: 15000 }, async () => {
	const fixture: ExtensionFactory = (pi) => {
		pi.registerTool({ name: "kimi_lookup", label: "Lookup", description: "Local Kimi declaration preview",
			parameters: Type.Object({ query: Type.String({ description: "KIMI_PARAMETER_MARKER" }) }),
			async execute() { assert.fail("Preview must not execute tools"); } });
	};
	const h = await host({ kimi: true, factories: [fixture, contextView] });
	try {
		await h.session.prompt("Prepare a local declaration request.");
		await h.session.prompt("/context tools");
		assert.match(h.text(), /OpenAI Chat Completions-shaped collapsed/);
		const definition = preview(h, "Observed kimi_lookup");
		assert.match(definition, /Position: \$\.tools\[\d+\]\.function/);
		assert.match(definition, /"name": "kimi_lookup"/);
		assert.match(definition, /Local Kimi declaration preview/);
		assert.match(definition, /"parameters":/);
		assert.match(definition, /KIMI_PARAMETER_MARKER/);
		assert.doesNotMatch(definition, /"input_schema"|"strict"/);
		assert.match(definition, /Not final wire or provider acceptance/);
		assert.equal(h.executions, 0);
		assert.deepEqual(h.errors, []);
	} finally { await h.close(); }
});

test("Kimi anchored system tools expose ordered additions without content or payload mutation", { timeout: 15000 }, async () => {
	const h = await host({ kimi: true, tools: true, native: true });
	try {
		await h.session.prompt("First Kimi local plan.");
		h.respond({ name: "tool_search", input: { query: "Quasarledger", limit: 1 } }, undefined);
		await h.session.prompt("Discover the local tool.");
		await h.session.prompt("/context tools");
		assert.match(preview(h, "Observation details"), /OpenAI Chat Completions-shaped native.*effective declarations.*ordered updates/s);
		back(h);
		const definition = preview(h, "Observed fixture_deferred");
		assert.match(definition, /Position: \$\.messages\[\d+\]\.tools\[\d+\]\.function/);
		assert.match(definition, new RegExp(deferredSchemaMarker));
		back(h);
		assert.match(preview(h, "Update + fixture_deferred"), /Native addition.*"parameters"/s);
		back(h);
		assert.match(preview(h, "Baseline fixture_tool"), /\$\.tools\[\d+\]\.function/);
		assert.deepEqual(h.bodies, h.observedBodies, "observation must not alter the real adapter payload");
		assert.equal(h.executions, 0);
		assert.deepEqual(h.errors, []);
	} finally { await h.close(); }
});

test("Chat-shaped observation ignores call and result content and does not require a model route or token-limit field", { timeout: 15000 }, async () => {
	let strict = false, original: unknown;
	const before: ExtensionFactory = (pi) => {
		pi.on("before_provider_request", (event) => {
			original = event.payload;
			const body = JSON.parse(JSON.stringify(original));
			delete body.max_tokens;
			body.tools[0].function.strict = strict;
			body.tools[0].function.parameters.examples = [{ type: "tool_addition", name: "schema_decoy" }];
			body.messages.push(
				{ role: "developer", content: "{\"tools\":[{\"name\":\"text_decoy\"}]}" },
				{ role: "assistant", content: null, tool_calls: [{ id: "local", type: "function", function: { name: "call_decoy", arguments: "{}" } }] },
				{ role: "tool", tool_call_id: "local", content: "{\"name\":\"result_decoy\",\"parameters\":{}}" },
				{ role: "assistant", function_call: { name: "legacy_decoy", arguments: "{}" } },
				{ role: "function", name: "legacy_decoy", content: "local result" },
			);
			return body;
		});
	};
	const after: ExtensionFactory = (pi) => { pi.on("before_provider_request", () => original); };
	const h = await host({ kimi: true, factories: [before, contextView, after] });
	try {
		for (strict of [false, true]) {
			await h.session.prompt("Prepare another local request.");
			await h.session.prompt("/context tools");
			assert.match(h.text(), /OpenAI Chat Completions-shaped collapsed/);
			const labels = rowLabels(h).join("\n");
			assert.doesNotMatch(labels, /Observed (schema_decoy|text_decoy|call_decoy|result_decoy|legacy_decoy)|Update [＋+−]/);
			const definition = preview(h, "Observed fixture_tool");
			assert.match(definition, new RegExp(`"strict": ${strict}`));
			assert.match(definition, /schema_decoy/);
			assert.doesNotMatch(definition, /text_decoy|call_decoy|result_decoy|legacy_decoy/);
		}
		assert.deepEqual(h.errors, []);
	} finally { await h.close(); }
});

test("unsupported or unsafe Chat declarations clear the latest evidence without reading getters or blocking transport", { timeout: 15000 }, async () => {
	let poison: ((body: any) => void) | undefined, original: unknown, getters = 0;
	const accessor = () => { getters++; throw new Error("PRIVATE_CHAT_ERROR"); };
	const before: ExtensionFactory = (pi) => {
		pi.on("before_provider_request", (event) => {
			original = event.payload;
			const body = JSON.parse(JSON.stringify(original));
			poison?.(body);
			return body;
		});
	};
	const after: ExtensionFactory = (pi) => { pi.on("before_provider_request", () => original); };
	const h = await host({ kimi: true, factories: [before, contextView, after] });
	const failures: [string, (body: any) => void][] = [
		["unsupported function protocol", (body) => { body.tools[0].function.type = "server_tool"; }],
		["malformed strict", (body) => { body.tools[0].function.strict = "yes"; }],
		["function array", (body) => { body.tools[0].function = Object.assign([], body.tools[0].function); }],
		["inherited parameters", (body) => {
			const fn = body.tools[0].function, parameters = fn.parameters;
			delete fn.parameters; Object.setPrototypeOf(fn, { parameters });
		}],
		["parameter accessor", (body) => { Object.defineProperty(body.tools[0].function, "parameters", { get: accessor }); }],
		["schema toJSON", (body) => { body.tools[0].function.parameters.toJSON = accessor; }],
		["mixed protocol", (body) => { body.messages.push({ role: "system", content: [{ type: "tool_removal", tool: { type: "tool_reference", name: "fixture_tool" } }] }); }],
		["non-system tools", (body) => { body.messages.push({ role: "user", tools: [body.tools[0]], content: "not a declaration anchor" }); }],
		["invented wire removal", (body) => { body.messages.push({ role: "system", tools: [{ type: "function", function: { name: "fixture_tool" }, action: "remove" }] }); }],
		["shared character budget", (body) => {
			body.tools[0].function.parameters.examples = ["a".repeat(1100000)];
			body.messages.push({ role: "system", tools: [{ type: "function", function: {
				name: "other", description: "local", parameters: { type: "object", examples: ["b".repeat(1100000)] },
			} }] });
		}],
	];
	try {
		for (const [label, damage] of failures) {
			poison = undefined;
			await h.session.prompt("Prepare a valid local request.");
			await h.session.prompt("/context tools");
			assert.match(preview(h, "Observed fixture_tool"), /"parameters"/);
			poison = damage;
			await h.session.prompt("Prepare an unsupported local observation.");
			await h.session.prompt("/context tools");
			assert.match(h.text(), /Unknown:/, label);
			assert.doesNotMatch(rowLabels(h).join("\n"), /Observed fixture_tool|Baseline |Update [＋+−]/, label);
			assert.doesNotMatch(preview(h, "Observation details"), /PRIVATE_CHAT_ERROR/);
			assert.equal(h.session.messages.at(-1)?.role, "assistant", "later handler restores the ordinary transport");
		}
		assert.equal(getters, 0);
		assert.deepEqual(h.errors, []); assert.deepEqual(h.notices, []);
	} finally { await h.close(); }
});

test("Kimi can declare its first tools in a system anchor after an initially empty baseline", { timeout: 15000 }, async () => {
	let activate = false;
	const change: ExtensionFactory = (pi) => {
		pi.on("session_start", () => pi.setActiveTools([]));
		pi.on("before_agent_start", () => { pi.setActiveTools(activate ? ["fixture_tool"] : []); });
	};
	const h = await host({ kimi: true, native: true, factories: [change, contextView] });
	try {
		await h.session.prompt("Start without tools.");
		await h.session.prompt("/context tools");
		assert.match(h.text(), /0 top-level declarations/);
		assert.doesNotMatch(h.text(), /Unknown:|Anthropic-shaped|OpenAI Chat Completions-shaped|Observed fixture_tool/);
		activate = true;
		await h.session.prompt("Now expose a local tool.");
		await h.session.prompt("/context tools");
		assert.match(h.text(), /OpenAI Chat Completions-shaped native/);
		assert.match(preview(h, "Observed fixture_tool"), /\$\.messages\[\d+\]\.tools\[\d+\]\.function/);
		back(h);
		assert.match(preview(h, "Update + fixture_tool"), /"parameters"/);
		back(h);
		assert.doesNotMatch(rowLabels(h).join("\n"), /Baseline fixture_tool/);
		h.respond({ name: "fixture_tool" }, undefined);
		await h.session.prompt("Run the benign local fixture operation.");
		activate = false;
		await h.session.prompt("Withdraw all tools after the call.");
		await h.session.prompt("/context tools");
		assert.match(h.text(), /0 top-level declarations/);
		assert.doesNotMatch(rowLabels(h).join("\n"), /Unknown:|Observed fixture_tool|Baseline |Update [＋+−]/);
		assert.deepEqual(h.errors, []);
	} finally { await h.close(); }
});
