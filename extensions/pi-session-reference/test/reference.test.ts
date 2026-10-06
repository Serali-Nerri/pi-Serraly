import assert from "node:assert/strict";
import fs, { readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { harness, references, usage } from "./harness.ts";

test("an explicit stable ID adds inspectable untrusted background without changing user, system or source", async (t) => {
	const h = await harness(t);
	const source = h.source("AUTHORIZED HISTORY", "Same title");
	h.source("UNSELECTED HISTORY", "Same title");
	const file = source.getSessionFile()!;
	const before = await readFile(file);
	const system = h.session.systemPrompt;
	const prompt = `Use @session:[${source.getSessionId()}] as context.`;
	await h.session.prompt(prompt);
	const messages = references(h);
	assert.equal(messages.length, 1);
	assert.equal(messages[0].role, "custom");
	if (messages[0].role !== "custom") assert.fail("expected background");
	assert.equal(messages[0].display, true);
	assert.match(String(messages[0].content), /untrusted background/i);
	assert.match(String(messages[0].content), /AUTHORIZED HISTORY/);
	assert.doesNotMatch(String(messages[0].content), /UNSELECTED HISTORY/);
	assert.match(String(messages[0].content), new RegExp(source.getSessionId()));
	const request = JSON.stringify(h.requests[0].messages);
	assert.match(request, /AUTHORIZED HISTORY/);
	assert.ok(request.includes(prompt));
	assert.equal(h.session.systemPrompt, system);
	assert.deepEqual(h.session.getActiveToolNames(), []);
	assert.deepEqual(await readFile(file), before);
	await h.session.prompt("A new request without a reference");
	assert.equal(references(h).length, 1);
});

test("only effective compaction-aware visible context is exported, not branches, private state or recursive guidance", async (t) => {
	const h = await harness(t);
	const source = h.source("SUMMARIZED RAW HISTORY");
	const root = source.getLeafId()!;
	source.appendMessage({ role: "user", content: "ABANDONED BRANCH", timestamp: Date.now() });
	source.branch(root);
	const kept = source.appendMessage({ role: "user", content: "REPLACED TEXT", timestamp: Date.now() });
	source.appendContextEdit(kept, { content: "EFFECTIVE EDITED TEXT" });
	source.appendMessage({ role: "assistant", provider: "fixture", model: "fixture", api: "reference-scripted",
		content: [{ type: "thinking", thinking: "HIDDEN THINKING" }, { type: "text", text: "VISIBLE ASSISTANT" },
			{ type: "toolCall", id: "call", name: "read", arguments: { secret: "PRIVATE TOOL ARGUMENTS" } }],
		usage, stopReason: "toolUse", timestamp: Date.now() });
	source.appendMessage({ role: "toolResult", toolCallId: "call", toolName: "read", isError: false,
		content: [{ type: "text", text: "RETAINED TOOL TEXT\n[Output truncated]" }, { type: "image", data: "RAW ATTACHMENT", mimeType: "image/png" }],
		details: { fullOutputPath: "/arbitrary/private-file", secret: "PRIVATE TOOL DETAILS" }, timestamp: Date.now() });
	source.appendMessage({ role: "bashExecution", command: "echo kept", output: "RETAINED SHELL OUTPUT",
		exitCode: 0, cancelled: false, truncated: true, fullOutputPath: "/arbitrary/private-file", timestamp: Date.now() });
	source.appendMessage({ role: "bashExecution", command: "echo hidden", output: "EXCLUDED SHELL OUTPUT",
		exitCode: 0, cancelled: false, truncated: false, excludeFromContext: true, timestamp: Date.now() });
	source.appendCustomMessageEntry("session-reference", "NESTED REFERENCE GUIDANCE", true);
	source.appendCustomMessageEntry("subagent-mention", "NESTED DELEGATION GUIDANCE", true);
	source.appendCustomMessageEntry("hidden", "HIDDEN CUSTOM TEXT", false);
	source.appendCustomEntry("private-state", { text: "NONCONTEXT STATE" });
	source.appendUsage("independent", "fixture", "fixture", usage, "PRIVATE USAGE NOTE");
	source.appendCompaction("RETAINED COMPACTION SUMMARY", kept, 1000);
	source.appendMessage({ role: "system", content: [{ type: "text", text: "SOURCE SYSTEM PROMPT" }], timestamp: Date.now() });
	await h.session.prompt(`Read @session:[${source.getSessionId()}]`);
	const text = String(references(h)[0]?.content);
	for (const visible of ["EFFECTIVE EDITED TEXT", "VISIBLE ASSISTANT", "RETAINED TOOL TEXT", "Output truncated",
		"RETAINED SHELL OUTPUT", "RETAINED COMPACTION SUMMARY"]) assert.ok(text.includes(visible), visible);
	for (const hidden of ["SUMMARIZED RAW HISTORY", "ABANDONED BRANCH", "REPLACED TEXT", "HIDDEN THINKING",
		"PRIVATE TOOL ARGUMENTS", "RAW ATTACHMENT", "PRIVATE TOOL DETAILS", "/arbitrary/private-file",
		"EXCLUDED SHELL OUTPUT", "NESTED REFERENCE GUIDANCE", "NESTED DELEGATION GUIDANCE", "HIDDEN CUSTOM TEXT",
		"NONCONTEXT STATE", "PRIVATE USAGE NOTE", "SOURCE SYSTEM PROMPT"]) assert.ok(!text.includes(hidden), hidden);
});

test("bad, unsafe, missing, self and excess selections are diagnosed while the first five readable IDs proceed once", async (t) => {
	const h = await harness(t, "json");
	const unsafe = h.source("LEGACY MUST NOT MIGRATE");
	const unsafeFile = unsafe.getSessionFile()!;
	await writeFile(unsafeFile, (await readFile(unsafeFile, "utf8")).replace('"version":3', '"version":2'));
	const bad = h.source("BAD UTF8 MUST NOT REPAIR");
	const badFile = bad.getSessionFile()!;
	await writeFile(badFile, Buffer.concat([await readFile(badFile), Buffer.from([0xff])]));
	const frozen = [await readFile(unsafeFile), await readFile(badFile)];
	const sources = Array.from({ length: 7 }, (_, index) => h.source(`SOURCE ${index + 1}`));
	const prompt = ["missing", h.manager.getSessionId(), unsafe.getSessionId(), bad.getSessionId(),
		sources[0].getSessionId(), sources[0].getSessionId(), ...sources.slice(1).map((source) => source.getSessionId()),
		unsafeFile].map((id) => `@session:[${id}]`).join(" ");
	await h.session.prompt(prompt);
	assert.equal(references(h).length, 1);
	const text = String(references(h)[0].content);
	for (const notice of [/missing/i, /current session/i, /unsupported.*format/i, /UTF-8/i, /limit.*5/i]) assert.match(text, notice);
	for (const index of [1, 2, 3, 4, 5]) assert.ok(text.includes(`SOURCE ${index}`));
	for (const index of [6, 7]) assert.ok(!text.includes(`SOURCE ${index}`));
	assert.equal(text.split("user: SOURCE 1").length - 1, 1);
	assert.ok(!text.includes("LEGACY MUST NOT MIGRATE"));
	assert.deepEqual(await readFile(unsafeFile), frozen[0]);
	assert.deepEqual(await readFile(badFile), frozen[1]);
	assert.deepEqual(h.factories, [], "JSON never creates terminal completion");
});

test("UTF-8 message, source and total bounds include their labels and omission notices without splitting Unicode", async (t) => {
	const h = await harness(t, "rpc");
	const long = "🚀界e\u0301".repeat(3000);
	const source = h.source(long, "Unicode source");
	await h.session.prompt(`@session:[${source.getSessionId()}]`);
	let text = String(references(h).at(-1)!.content);
	const sourceMessage = text.slice(text.indexOf("user: "));
	assert.ok(Buffer.byteLength(sourceMessage) <= 8000, "message label and omission fit 8,000 bytes");
	assert.match(sourceMessage, /omitted/i);
	assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(sourceMessage)), sourceMessage);
	for (let index = 0; index < 10; index++) source.appendMessage({ role: "user", content: long, timestamp: Date.now() });
	await h.session.prompt(`@session:[${source.getSessionId()}]`);
	text = String(references(h).at(-1)!.content);
	const section = text.slice(text.indexOf("Session ID:"));
	assert.ok(Buffer.byteLength(section) <= 24000, "metadata and transcript fit 24,000 bytes");
	assert.match(section, /omitted/i);
	const sources = [source, ...Array.from({ length: 4 }, () => {
		const saved = h.source(long);
		for (let index = 0; index < 10; index++) saved.appendMessage({ role: "user", content: long, timestamp: Date.now() });
		return saved;
	})];
	await h.session.prompt(sources.map((saved) => `@session:[${saved.getSessionId()}]`).join(" "));
	text = String(references(h).at(-1)!.content);
	assert.ok(Buffer.byteLength(text) <= 48000, "all five sections and wrapper fit 48,000 bytes");
	for (const saved of sources) assert.ok(text.includes(saved.getSessionId()), "each included source stays inspectable");
	assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(text)), text);
});

test("large truncated shell results retain their source warning and byte-budget omissions without reading full output", async (t) => {
	const h = await harness(t);
	const fullOutputPath = join(h.root, "full-output.txt");
	await writeFile(fullOutputPath, "FULL OUTPUT MUST NOT BE RECOVERED");
	const original = fs.readFile;
	let fullOutputRead = false;
	t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
		if (String(args[0]) === fullOutputPath) fullOutputRead = true;
		return original(...args);
	});
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	const output = "RETAINED SHELL TEXT " + "🚀界e\u0301".repeat(3000);
	const appendShell = (source: ReturnType<typeof h.source>) => source.appendMessage({
		role: "bashExecution", command: "fixture", output, exitCode: 0, cancelled: false,
		truncated: true, fullOutputPath, timestamp: Date.now(),
	});
	const source = h.source("Visible context", "Truncated Unicode shell");
	appendShell(source);
	await h.session.prompt(`@session:[${source.getSessionId()}]`);
	let text = String(references(h).at(-1)!.content);
	const message = text.slice(text.indexOf("Shell output:"));
	assert.match(message, /Source result truncated; missing output is not recovered/);
	assert.match(message, /content omitted by reference byte budget/);
	assert.ok(Buffer.byteLength(message) <= 8000, "shell label, warning and omission fit the message budget");
	assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(message)), message);

	// A source clip can cut a later shell body as well as the message clip. Any
	// retained shell output must still carry its source-truncation warning.
	appendShell(source);
	appendShell(source);
	await h.session.prompt(`@session:[${source.getSessionId()}]`);
	text = String(references(h).at(-1)!.content);
	assert.ok(Buffer.byteLength(text.slice(text.indexOf("Session ID:"))) <= 24000);
	assert.equal(text.split("RETAINED SHELL TEXT").length - 1, 3);
	assert.equal(text.split("Source result truncated").length - 1, 3);

	const sources = [source, ...Array.from({ length: 4 }, () => {
		const saved = h.source("Visible context", "Truncated Unicode shell");
		appendShell(saved);
		appendShell(saved);
		return saved;
	})];
	await h.session.prompt(sources.map((saved) => `@session:[${saved.getSessionId()}]`).join(" "));
	text = String(references(h).at(-1)!.content);
	assert.ok(Buffer.byteLength(text) <= 48000, "all metadata, warnings and omissions fit the total budget");
	assert.equal(text.split("RETAINED SHELL TEXT").length - 1, 10);
	assert.equal(text.split("Source result truncated").length - 1, 10);
	for (const saved of sources) assert.ok(text.includes(saved.getSessionId()));
	assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(text)), text);
	assert.doesNotMatch(JSON.stringify(h.requests), /FULL OUTPUT MUST NOT BE RECOVERED/);
	assert.equal(fullOutputRead, false, "a full-output path is not a source-reading permission");
});

test("only complete current-prompt tokens trigger background; retries reuse it and a later explicit request gets fresh context", async (t) => {
	const h = await harness(t);
	const source = h.source("FIRST CONTEXT");
	const token = `@session:[${source.getSessionId()}]`;
	await h.session.prompt(`Not a complete token: ${token}suffix`);
	assert.equal(references(h).length, 0);
	h.failNext();
	await h.session.prompt(`Use ${token} ${token}`);
	assert.equal(references(h).length, 1);
	assert.equal(h.requests.length, 3, "one ordinary call plus a failure and automatic retry");
	const retry = JSON.stringify(h.requests.at(-1)!.messages);
	assert.equal(retry.split("Referenced Pi sessions").length - 1, 1);
	source.appendMessage({ role: "user", content: "NEW SOURCE CONTEXT", timestamp: Date.now() });
	await h.session.prompt(`Use ${token} again`);
	assert.equal(references(h).length, 2);
	assert.match(String(references(h).at(-1)!.content), /NEW SOURCE CONTEXT/);
});
