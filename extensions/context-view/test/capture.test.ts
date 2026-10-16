import assert from "node:assert/strict";
import { test } from "node:test";

import { estimateTokens } from "@earendil-works/pi-coding-agent";

import type {
	BuildSystemPromptOptions,
	ContextEvent,
	SlashCommandInfo,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";

import {
	captureActiveTools,
	collectPromptSources,
	copyPromptOptions,
	diffRequestMessages,
	LatestCaptureState,
	measureInjectedMessages,
} from "../src/capture.ts";

/** Minimal custom-role message fixture. */
function customMessage(customType: string, content: string, timestamp: number): ContextEvent["messages"][number] {
	return { role: "custom", customType, content, display: false, timestamp };
}

/** Skill fixture with explicit model-visibility state. */
function skill(
	name: string,
	disableModelInvocation: boolean,
): NonNullable<BuildSystemPromptOptions["skills"]>[number] {
	return {
		name,
		description: `${name} description`,
		filePath: `/tmp/${name}/SKILL.md`,
		baseDir: `/tmp/${name}`,
		disableModelInvocation,
		sourceInfo: {
			path: `/tmp/${name}/SKILL.md`,
			source: "temporary",
			scope: "temporary",
			origin: "top-level",
		},
	};
}

/** ToolInfo fixture with the given provenance source and one guideline. */
function tool(name: string, source: string): ToolInfo {
	return {
		name,
		exposure: "direct",
		description: `${name} description`,
		parameters: {} as ToolInfo["parameters"],
		promptGuidelines: [`Use ${name}`],
		sourceInfo: {
			path: `/tmp/${name}.ts`,
			source,
			scope: "temporary",
			origin: "top-level",
		},
	};
}

/** Assistant fixture for content and signature previews. */
function assistantMessage(
	stopReason: "aborted" | "error",
	timestamp: number,
	errorMessage?: string,
): Extract<ContextEvent["messages"][number], { role: "assistant" }> {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		errorMessage,
		timestamp,
	};
}

test("captureActiveTools uses the final active set", () => {
	const tools = captureActiveTools(
		[tool("read", "builtin"), tool("search", "npm:web")],
		["search"],
		{ toolSnippets: { search: "Search the web" } },
	);

	assert.deepEqual(tools.map((entry) => entry.name), ["search"]);
	assert.equal(tools[0]?.source, "npm:web");
	assert.equal(tools[0]?.snippet, "Search the web");
});

test("captureActiveTools keeps pi's active-tool order and drops repeated names", () => {
	const tools = captureActiveTools(
		[tool("read", "builtin"), tool("search", "npm:web")],
		["search", "read", "search"],
		{},
	);

	// Guideline ownership follows this order, so it must match the order pi
	// builds its Guidelines section from.
	assert.deepEqual(tools.map((entry) => entry.name), ["search", "read"]);
});

test("collectPromptSources rosters the names of extension tools and commands", () => {
	const command = (name: string, source: string): SlashCommandInfo => ({
		name,
		source: "extension",
		sourceInfo: { path: `/tmp/${name}.ts`, source, scope: "temporary", origin: "top-level" },
	});
	const sources = collectPromptSources(
		[tool("read", "builtin"), tool("search", "npm:web"), tool("fetch", "npm:web")],
		[command("ask", "npm:ask"), command("/web", "npm:web")],
	);

	// One roster entry per extension file, and commands keep the slash prompts use.
	assert.deepEqual(sources.map((source) => [source.source, source.names]), [
		["npm:web", ["search"]],
		["npm:web", ["fetch"]],
		["npm:ask", ["/ask"]],
		["npm:web", ["/web"]],
	]);
});

test("copyPromptOptions owns decomposition metadata and keeps only visible skills", () => {
	const contextFile = { path: "./AGENTS.md", content: "rules" };
	const visibleSkill = skill("visible", false);
	const options: BuildSystemPromptOptions = {
		cwd: "/tmp",
		contextFiles: [contextFile],
		skills: [visibleSkill, skill("hidden", true)],
	};

	const copied = copyPromptOptions(options);
	contextFile.path = "./changed.md";
	visibleSkill.description = "changed";

	assert.deepEqual(copied.contextFilePaths, ["./AGENTS.md"]);
	assert.deepEqual(copied.skills, [
		{ name: "visible", description: "visible description", filePath: "/tmp/visible/SKILL.md" },
	]);
});

test("measureInjectedMessages reports request deltas against the session projection", () => {
	const ordinaryUser = { role: "user", content: "ordinary", timestamp: 1 } satisfies ContextEvent["messages"][number];
	const sessionCustom = customMessage("marker", "session", 2);
	const requestCustom = customMessage("marker", "request only", 3);
	const injectedUser = { role: "user", content: "injected", timestamp: 4 } satisfies ContextEvent["messages"][number];
	const blockUser = {
		role: "user",
		content: [{ type: "text", text: "injected" }],
		timestamp: 5,
	} satisfies ContextEvent["messages"][number];
	const items = measureInjectedMessages(
		[ordinaryUser, sessionCustom, requestCustom, injectedUser, blockUser],
		[ordinaryUser, sessionCustom],
	);

	assert.deepEqual(
		items.map((entry) => entry.id),
		["message:added:marker:0", "message:added:user:0", "message:added:user:1"],
	);
	assert.equal(items[0]?.source.id, "message-type:marker");
	assert.equal(items[0]?.label, "message");
	assert.deepEqual(items[0]?.change, { kind: "added", before: "", after: "request only" });
	assert.equal(items[0]?.requestOnly, true);
	assert.equal(items[1]?.source.id, "aggregate:extensions");
	assert.equal(items[1]?.text, "injected");
	// String content is text; serialized block content is marked JSON for full-content previews.
	assert.equal(items[1]?.jsonSpan, undefined);
	assert.equal(items[2]?.text, '[{"type":"text","text":"injected"}]');
	assert.deepEqual(items[2]?.jsonSpan, { start: 0, end: items[2]?.text.length });
});

test("measureInjectedMessages keeps replacements and removals aligned with the session", () => {
	const before = { role: "user", content: "before text", timestamp: 1 } satisfies ContextEvent["messages"][number];
	const after = { role: "user", content: "after text", timestamp: 1 } satisfies ContextEvent["messages"][number];
	const dropped = customMessage("marker", "gone", 2);

	const items = measureInjectedMessages([after], [before, dropped]);

	assert.deepEqual(
		items.map((entry) => [entry.id, entry.change?.kind, entry.tokens]),
		[["message:modified:user:0", "modified", estimateTokens(after)], ["message:removed:marker:0", "removed", 0]],
	);
	assert.equal(items[0]?.change?.before, "before text");
	assert.equal(items[0]?.change?.after, "after text");
	assert.equal(items[0]?.requestOnly, undefined);
	assert.equal(items[1]?.text, "gone");

	// Insertions do not misattribute the messages that follow them.
	const second = { role: "user", content: "second", timestamp: 3 } satisfies ContextEvent["messages"][number];
	const inserted = customMessage("marker", "inserted", 4);
	assert.deepEqual(
		diffRequestMessages([before, inserted, second], [before, second]).map((delta) => [delta.kind, delta.index]),
		[["added", 1]],
	);
	assert.deepEqual(
		diffRequestMessages([before], [before, inserted]).map((delta) => [delta.kind, delta.index]),
		[["removed", 1]],
	);
});

test("Latest capture omits opaque signatures from injected and transformed assistant previews", () => {
	const message = {
		...assistantMessage("aborted", 8),
		content: [
			{ type: "text", text: "visible answer", textSignature: "OPAQUE_TEXT_SENTINEL" },
			{ type: "thinking", thinking: "visible reasoning", thinkingSignature: "OPAQUE_THINKING_SENTINEL" },
			{
				type: "toolCall", id: "call-1", name: "read",
				arguments: {
					path: "example.txt",
					textSignature: "text argument data",
					thinkingSignature: "argument data",
					thoughtSignature: "more argument data",
				},
				thoughtSignature: "OPAQUE_THOUGHT_SENTINEL",
			},
		],
	} satisfies Extract<ContextEvent["messages"][number], { role: "assistant" }>;
	const original = structuredClone(message);
	const expectedTokens = estimateTokens(message);
	const baselines: ContextEvent["messages"][] = [
		[],
		[{ ...message, content: [{ type: "text", text: "before context transformation" }] }],
	];
	for (const [index, baselineMessages] of baselines.entries()) {
		const originalBaseline = structuredClone(baselineMessages);
		const capture = new LatestCaptureState();
		capture.prepare({ cwd: "/tmp", customPrompt: "system" });
		const snapshot = capture.finalize(() => ({
			systemPrompt: "system", messages: [message], baselineMessages,
			allTools: [], activeToolNames: [], origin: "real-turn",
		}));
		assert.ok(snapshot);
		const item = snapshot.groups.flatMap((group) => group.items).find((item) => item.kind === "message");
		assert.ok(item);
		assert.equal(item.requestOnly, index === 0 ? true : undefined);
		assert.equal(item.tokens, expectedTokens);
		assert.equal(item.chars, item.text.length);
		assert.deepEqual(item.jsonSpan, { start: 0, end: item.text.length });
		assert.deepEqual(JSON.parse(item.text), [
			{ type: "text", text: "visible answer" },
			{ type: "thinking", thinking: "visible reasoning" },
			{
				type: "toolCall", id: "call-1", name: "read",
				arguments: {
					path: "example.txt",
					textSignature: "text argument data",
					thinkingSignature: "argument data",
					thoughtSignature: "more argument data",
				},
			},
		]);
		assert.doesNotMatch(JSON.stringify(snapshot), /OPAQUE_(TEXT|THINKING|THOUGHT)_SENTINEL/);
		assert.deepEqual(message, original);
		assert.deepEqual(baselineMessages, originalBaseline);
	}
	// Preview-only redaction does not change structural baseline matching.
	assert.deepEqual(measureInjectedMessages([message], [original]), []);
});

test("Latest capture reports injected image sizes instead of retaining their payloads", () => {
	const payload = "B".repeat(2_048);
	const imageUser = {
		role: "user",
		content: [
			{ type: "text", text: "look at this" },
			{ type: "image", data: payload, mimeType: "image/png" },
		],
		timestamp: 1,
	} satisfies ContextEvent["messages"][number];
	const imageToolResult = {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "screenshot",
		content: [{ type: "image", data: "tiny", mimeType: "image/jpeg" }],
		isError: false,
		timestamp: 2,
	} satisfies ContextEvent["messages"][number];
	const original = structuredClone([imageUser, imageToolResult]);

	const items = measureInjectedMessages([imageUser, imageToolResult], []);

	assert.deepEqual(JSON.parse(items[0]?.text ?? ""), [
		{ type: "text", text: "look at this" },
		{ type: "image", data: "<2.0KB omitted>", mimeType: "image/png" },
	]);
	assert.deepEqual(JSON.parse(items[1]?.text ?? ""), [
		{ type: "image", data: "<4B omitted>", mimeType: "image/jpeg" },
	]);
	// Estimates keep using pi's own image proxy, which the omitted text must not change.
	assert.equal(items[0]?.tokens, estimateTokens(imageUser));
	assert.equal(items[0]?.chars, items[0]?.text.length);
	assert.deepEqual([imageUser, imageToolResult], original);
});

test("captured summary previews omit envelope metadata without changing the content", () => {
	const messages = [
		{
			role: "compactionSummary", summary: "We fixed image previews.\nNext: update the tests.",
			tokensBefore: 42_000, timestamp: 1_700_000_000_000,
		},
		{
			role: "branchSummary", summary: '{"fromId":"actual summary content"}',
			fromId: "INTERNAL_BRANCH_ID", timestamp: 1_700_000_000_001,
		},
	] satisfies ContextEvent["messages"];
	const original = structuredClone(messages);
	const items = measureInjectedMessages(messages, []);

	assert.deepEqual(items.map((item) => item.text), messages.map((message) => message.summary));
	for (const [index, item] of items.entries()) {
		assert.equal(item.jsonSpan, undefined);
		assert.equal(item.chars, item.text.length);
		assert.equal(item.tokens, estimateTokens(messages[index]));
		assert.equal(item.requestOnly, true);
	}
	assert.deepEqual(messages, original);
	assert.deepEqual(measureInjectedMessages(messages, original), []);
});

test("captured bash previews use provider-facing text instead of message metadata", () => {
	const base = {
		role: "bashExecution", command: "ls", output: "example.txt", exitCode: 0,
		cancelled: false, truncated: false, fullOutputPath: "/tmp/full-output.txt", timestamp: 1,
	} satisfies ContextEvent["messages"][number];
	const messages = [
		base,
		{ ...base, output: "", timestamp: 2 },
		{ ...base, output: "failed", exitCode: 2, timestamp: 3 },
		{ ...base, output: "partial", exitCode: undefined, cancelled: true, timestamp: 4 },
		{ ...base, truncated: true, timestamp: 5 },
		{ ...base, excludeFromContext: true, timestamp: 6 },
	];
	const original = structuredClone(messages);
	const items = measureInjectedMessages(messages, []);

	assert.deepEqual(items.map((item) => item.text), [
		"Ran `ls`\n```\nexample.txt\n```",
		"Ran `ls`\n(no output)",
		"Ran `ls`\n```\nfailed\n```\n\nCommand exited with code 2",
		"Ran `ls`\n```\npartial\n```\n\n(command cancelled)",
		"Ran `ls`\n```\nexample.txt\n```\n\n[Output truncated. Full output: /tmp/full-output.txt]",
		"",
	]);
	for (const [index, item] of items.entries()) {
		assert.equal(item.jsonSpan, undefined);
		assert.equal(item.chars, item.text.length);
		assert.equal(item.tokens, estimateTokens(messages[index]));
	}
	assert.deepEqual(messages, original);
	assert.deepEqual(measureInjectedMessages(messages, original), []);
});

test("captureActiveTools marks declarations Pi hid from this run's model", () => {
	const tools = captureActiveTools(
		[tool("read", "builtin"), tool("search", "npm:web")],
		["read", "search"],
		{ hiddenToolNames: ["search"] },
	);

	assert.deepEqual(tools.map((entry) => [entry.name, entry.hidden]), [["read", undefined], ["search", true]]);
});

test("LatestCaptureState owns prepared options before later handlers can mutate them", () => {
	const state = new LatestCaptureState();
	const options: BuildSystemPromptOptions = {
		cwd: "/tmp",
		toolSnippets: { search: "Original snippet" },
	};
	state.prepare(options);
	if (options.toolSnippets !== undefined) options.toolSnippets.search = "Changed snippet";

	const snapshot = state.finalize(() => ({
		systemPrompt: "Base\n\nAvailable tools:\n- search: Original snippet\n",
		messages: [],
		baselineMessages: [],
		allTools: [tool("search", "npm:web")],
		activeToolNames: ["search"],
		origin: "real-turn",
	}));

	assert.ok(snapshot !== undefined);
	const search = snapshot.groups.flatMap((group) => group.items).find((entry) => entry.label === "search");
	assert.match(search?.text ?? "", /Original snippet/);
});

test("LatestCaptureState replaces the previous snapshot with each finalized request", () => {
	const state = new LatestCaptureState();
	const firstOptions: BuildSystemPromptOptions = { cwd: "/tmp" };
	const finalOptions: BuildSystemPromptOptions = { cwd: "/tmp", customPrompt: "CUSTOM" };
	const message = customMessage("marker", "captured", 1);
	const capturedAt = new Date("2026-07-10T12:00:00Z");

	state.prepare(firstOptions);
	state.prepare(finalOptions);
	const first = state.finalize(() => ({
		systemPrompt: "CUSTOM",
		messages: [message],
		baselineMessages: [],
		allTools: [],
		activeToolNames: [],
		origin: "real-turn",
		capturedAt,
	}));
	assert.ok(first !== undefined);
	assert.equal(first.groups[0]?.items[0]?.label, "System Prompt");
	assert.equal(first.groups[1]?.items[0]?.text, "captured");

	if (message.role === "custom") message.content = "changed";
	capturedAt.setFullYear(2000);
	state.prepare({ cwd: "/different" });
	const second = state.finalize(() => ({
		systemPrompt: "DIFFERENT",
		messages: [],
		baselineMessages: [],
		allTools: [],
		activeToolNames: [],
		origin: "real-turn",
	}));

	assert.ok(second !== undefined);
	assert.notStrictEqual(second, first);
	assert.equal(second.groups[0]?.items[0]?.text, "DIFFERENT");
	assert.equal(first.groups[1]?.items[0]?.text, "captured");
	assert.equal(first.capturedAt.toISOString(), "2026-07-10T12:00:00.000Z");
	// The new request replaces the captured set instead of accumulating into it.
	assert.equal(second.groups.some((group) => group.items.some((item) => item.text === "captured")), false);
});

test("LatestCaptureState does not finalize before prepare", () => {
	const state = new LatestCaptureState();
	assert.equal(
		state.finalize(() => ({
			systemPrompt: "prompt",
			messages: [],
			baselineMessages: [],
			allTools: [],
			activeToolNames: [],
			origin: "real-turn",
		})),
		undefined,
	);
});

test("LatestCaptureState drops the previous snapshot when the next capture fails", () => {
	const state = new LatestCaptureState();
	state.prepare({ cwd: "/tmp" });
	const first = state.finalize(() => ({
		systemPrompt: "Base",
		messages: [],
		baselineMessages: [],
		allTools: [],
		activeToolNames: [],
		origin: "real-turn",
		sessionId: "session-1",
		leafId: "leaf-1",
		modelKey: "fixture/model",
	}));
	assert.ok(first !== undefined);
	assert.deepEqual(state.identity, { sessionId: "session-1", leafId: "leaf-1", modelKey: "fixture/model" });

	state.prepare({ cwd: "/tmp" });
	assert.throws(() =>
		state.finalize(() => {
			throw new Error("capture failed");
		}),
	);
	assert.equal(state.snapshot, undefined);
	assert.equal(state.messages, undefined);
	assert.equal(state.identity, undefined);
});
