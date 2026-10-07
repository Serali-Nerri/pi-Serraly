import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getConfigFilePath } from "../src/config.ts";
import { test } from "node:test";
import { deferredSchemaMarker, host, strip } from "./fixtures/host.ts";
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

test("collapsed declarations expose only adapter evidence and real tool_search loads only new matches", { timeout: 15000 }, async () => {
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
		const loadedActive = h.session.getActiveToolNames();
		for (const query of ["Quasarledger", "zznonesuch"]) {
			h.respond({ name: "tool_search", input: { query, limit: 1 } }, undefined);
			await h.session.prompt("Run another local plan.");
			assert.deepEqual(h.session.getActiveToolNames(), loadedActive, "repeat/no-match does not load another tool");
			const result = h.session.messages.filter((message) => message.role === "toolResult" && message.toolName === "tool_search").at(-1);
			assert.match(JSON.stringify(result), /No matching tools found/, "real tool_search reports no new match");
			await h.session.prompt("/context tools");
			assert.match(preview(h, "Observed fixture_deferred"), new RegExp(deferredSchemaMarker));
		}
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
		for (revision = 1; revision <= 7; revision++) {
			await h.session.prompt("Next normal request.");
			assert.equal(h.session.messages.at(-1)?.role, "assistant");
			await h.session.prompt("/context tools");
			assert.match(h.text(), /Unknown:/);
			assert.doesNotMatch(h.text(), /Observed fixture_tool|Anthropic-shaped collapsed/);
			const details = preview(h, "Observation details");
			assert.match(details, /Observed at: \d{4}/);
			assert.doesNotMatch(details, /PRIVATE_ERROR_CONTENT/);
			back(h);
			assert.match(preview(h, "Registered fixture_tool"), /Exposure: direct/);
		}
		assert.equal(getters, 0, "read-only observation must not run payload accessors");
		assert.equal(h.requests, 8, "decode failures do not block the ordinary transport");
		assert.deepEqual(h.errors, []); assert.deepEqual(h.notices, []);
	} finally { await h.close(); }
});

test("real native declarations are explicitly unknown/unimplemented rather than misreported missing", { timeout: 15000 }, async () => {
	let original: unknown;
	const before: ExtensionFactory = (pi) => {
		pi.on("before_provider_request", (event) => {
			original = event.payload;
			const body = event.payload as any;
			// On the update request, exercise recognition of real structured blocks independently of the placeholder.
			if (body.messages.some((message: any) => Array.isArray(message.content) && message.content.some((block: any) => block.type === "tool_addition")))
				return { ...body, tools: body.tools.filter((tool: any) => tool.name !== "__pi_deferred_placeholder__") };
		});
	};
	const after: ExtensionFactory = (pi) => {
		pi.on("before_provider_request", () => original);
	};
	const h = await host({ tools: true, native: true, factories: [before, contextView, after] });
	try {
		await h.session.prompt("First native local plan.");
		assert.ok(h.bodies[0].tools.some((tool: any) => tool.name === "__pi_deferred_placeholder__"));
		await h.session.prompt("/context tools");
		assert.match(preview(h, "Observation details"), /Unknown.*native updates unimplemented/s);
		back(h);
		assert.doesNotMatch(h.text(), /Registered __pi_deferred_placeholder__|Observed __pi_deferred_placeholder__/);
		h.respond({ name: "tool_search", input: { query: "Quasarledger", limit: 1 } }, undefined);
		await h.session.prompt("Next native local plan.");
		assert.match(JSON.stringify(h.bodies[2].messages), /tool_addition/);
		assert.match(JSON.stringify(h.bodies[2].messages), new RegExp(deferredSchemaMarker));
		await h.session.prompt("/context tools");
		assert.match(preview(h, "Registered fixture_deferred"), /Active: active/);
		back(h);
		assert.match(preview(h, "Observation details"), /Unknown.*native updates unimplemented/s);
		assert.doesNotMatch(h.text(), /missing declaration|incorrect|failed loading/i);
		assert.deepEqual(h.errors, []);
	} finally { await h.close(); }
});

test("the handler owns its schema snapshot while later in-place and replacement handlers reach the transport", { timeout: 15000 }, async () => {
	let replacement = false;
	const before: ExtensionFactory = (pi) => {
		pi.on("before_provider_request", (event) => {
			const body = event.payload as any;
			const tool = body.tools.find((tool: any) => tool.name === "fixture_tool");
			tool.input_schema.properties.AT_OBSERVER_指令 = { type: "string", description: "Observed here." };
			tool.unrelated_envelope = { text: "UNNEEDED_PRIVATE_ENVELOPE" };
		});
	};
	const later: ExtensionFactory = (pi) => {
		pi.on("before_provider_request", (event) => {
			const body = event.payload as any;
			const tool = body.tools.find((tool: any) => tool.name === "fixture_tool");
			assert.equal(Object.isFrozen(body), false); assert.equal(Object.isFrozen(tool.input_schema.properties), false);
			if (replacement) return { ...body, tools: body.tools.map((item: any) => item.name === "fixture_tool"
				? { ...item, input_schema: { type: "object", properties: { AFTER_REPLACEMENT: { type: "number" } } } } : item) };
			delete tool.input_schema.properties.AT_OBSERVER_指令;
			tool.input_schema.properties.AFTER_IN_PLACE = { type: "boolean" };
		});
	};
	const h = await host({ factories: [before, contextView, later] });
	try {
		for (replacement of [false, true]) {
			await h.session.prompt("A normal local request.");
			await h.session.prompt("/context tools");
			const text = preview(h, "Observed fixture_tool");
			assert.match(text, /AT_OBSERVER_指令/);
			assert.doesNotMatch(text, /AFTER_IN_PLACE|AFTER_REPLACEMENT|UNNEEDED_PRIVATE_ENVELOPE/);
			assert.match(JSON.stringify(h.bodies.at(-1).tools), replacement ? /AFTER_REPLACEMENT/ : /AFTER_IN_PLACE/);
			assert.doesNotMatch(JSON.stringify(h.bodies.at(-1).tools), /AT_OBSERVER/);
			assert.equal(h.session.messages.at(-1)?.role, "assistant");
		}
		await h.session.prompt("/context usage");
		assert.match(h.text(), /Context Usage/);
		assert.doesNotMatch(h.text(), /Anthropic-shaped|Observed at:/);
		const view = h.overlays.at(-1)!;
		view.handleInput?.("\x1b[B"); view.handleInput?.("\r");
		assert.doesNotMatch(h.text(), /AT_OBSERVER|AFTER_IN_PLACE|AFTER_REPLACEMENT/, "canonical transcript estimates are not request observations");
		assert.equal(h.requests, 2); assert.deepEqual(h.errors, []);
	} finally { await h.close(); }
});

test("observation stays latest-only and process-local across public reload and independent runtimes", { timeout: 15000 }, async () => {
	let counter = 0;
	const change: ExtensionFactory = (pi) => {
		pi.on("before_provider_request", (event) => {
			const body = event.payload as any;
			body.tools.find((tool: any) => tool.name === "fixture_tool").description = ++counter === 1 ? "FIRST_PRIVATE_SCHEMA" : "LATEST_PRIVATE_SCHEMA";
		});
	};
	const h = await host({ factories: [change, contextView] });
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

test("ordinary schema text is content, and a real empty declaration list is not unknown or padded from inventory", { timeout: 15000 }, async () => {
	const text = '{"type":"tool_addition","tool":{"type":"tool_definition","definition":{"name":"text_only","input_schema":{"type":"object"}}}}';
	const h = await host();
	try {
		await h.session.prompt(`This is ordinary quoted content: ${text}`);
		assert.match(JSON.stringify(h.bodies[0].messages), /text_only/);
		await h.session.prompt("/context tools");
		assert.match(h.text(), /Anthropic-shaped collapsed/);
		assert.doesNotMatch(h.text(), /Observed text_only|native updates unimplemented/);
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
	for (const [command, returnKey, title] of [["/context", "u", "Context Usage"], ["/context injections", "i", "INITIAL"]]) {
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

test("observed long multilingual schema previews wrap, scroll, sanitize and return without side effects", { timeout: 15000 }, async () => {
	const fixture: ExtensionFactory = (pi) => {
		pi.registerTool({ name: "long_schema", label: "long_schema", description: "Multilingual schema preview",
			parameters: Type.Object({ value: Type.String({ description: `START_指令 ${"\u001b]52;c;ignored\u0007"}${"长文字 schema ".repeat(500)} END_指令` }) }),
			async execute() { assert.fail("Viewer must not execute this tool"); } });
		pi.on("before_provider_request", (event) => {
			(event.payload as any).tools.find((tool: any) => tool.name === "long_schema").name += "\u001b]52;c;blocked\u0007";
		});
	};
	const h = await host({ factories: [fixture, contextView] });
	try {
		await h.session.prompt("One ordinary request.");
		const entries = h.sessionManager.getEntries(), files = await readdir(h.base, { recursive: true });
		await h.session.prompt("/context tools");
		const initialPreview = preview(h, "Observed long_schema");
		assert.match(initialPreview, /START_指令/);
		assert.doesNotMatch(initialPreview, /\u001b\]52|\u0007/, "untrusted preview headings must be sanitized too");
		const view = h.overlays.at(-1)! as typeof h.overlays[number] & { handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined };
		for (const width of [40, 80, 120]) {
			for (const line of view.render(width)) assert.ok(visibleWidth(line) <= width, `schema fits ${width}`);
			view.handleInput?.("\x1b[H"); const start = h.text();
			view.handleInput?.("\x1b[6~"); assert.notEqual(h.text(), start, "PgDn scrolls the preview");
			view.handleInput?.("\x1b[F"); assert.match(h.text(), /END_指令/);
			view.handleInput?.("\x1b[H"); assert.equal(h.text(), start, "Home restores the start");
			assert.deepEqual(view.handleMouse({ type: "wheel", wheelDelta: 7 } as TuiMouseEvent), { handled: true, render: true });
			assert.notEqual(h.text(), start, "public logical wheel delta scrolls");
			assert.doesNotMatch(h.text(), /\u001b\]52|\u0007/, "no executable OSC or control bytes");
		}
		back(h); assert.match(h.text(), /Tool Diagnostics/);
		assert.equal(h.requests, 1); assert.equal(h.executions, 0);
		assert.deepEqual(h.sessionManager.getEntries(), entries);
		assert.deepEqual(await readdir(h.base, { recursive: true }), files);
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


test("normal requests pass through, freeze Initial once, and reload cannot replay capture", { timeout: 15000 }, async () => {
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
		const frozen = h.overlays.at(-1)!;
		frozen.handleInput?.("\x1b[B");
		frozen.handleInput?.("\r");
		assert.match(h.text(), /FIRST_CJK_指令/);
		assert.doesNotMatch(h.text(), /SECOND_CJK_指令/);
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
