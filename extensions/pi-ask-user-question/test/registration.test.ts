import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ASK_USER_QUESTION_TOOL_NAME, DEFAULT_TOOL_DESCRIPTION, registerAskUserQuestionTool } from "../src/ask-user-question.ts";
import { registerAskUserQuestionReconciler } from "../src/reconcile.ts";
import { DECLINE_MESSAGE } from "../src/tool/response-envelope.ts";
import type { QuestionParams } from "../src/tool/types.ts";

type RegisteredTool = {
	name: string;
	description: string;
	exposure?: string;
	executionMode?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: any;
	execute: (...args: any[]) => Promise<any>;
};

function createHost() {
	const tools = new Map<string, RegisteredTool>();
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	const active = [ASK_USER_QUESTION_TOOL_NAME, "read"];
	const api = {
		registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
		on: (event: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(event, handler),
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => { active.length = 0; active.push(...names); },
	};
	return { api, tools, handlers, active };
}

const params: QuestionParams = {
	questions: [{
		question: "Which?",
		header: "Pick",
		options: [
			{ label: "Local", description: "embedded" },
			{ label: "Remote", description: "client/server" },
		],
	}],
};

/** Deterministic defaults: the registration reads the config from this directory. */
async function withAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-ask-user-question-agent-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await run(agentDir);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(agentDir, { recursive: true, force: true });
	}
}

test("the tool registers as sequential and model-only with exactly one prompt field", async () => {
	await withAgentDir(async () => {
		const host = createHost();
		registerAskUserQuestionTool(host.api as never);
		const tool = host.tools.get(ASK_USER_QUESTION_TOOL_NAME);
		assert.ok(tool);
		assert.equal(tool.description, DEFAULT_TOOL_DESCRIPTION);
		assert.equal(tool.exposure, "model-only");
		assert.equal(tool.executionMode, "sequential");
		assert.equal(tool.promptSnippet, undefined);
		assert.equal(tool.promptGuidelines, undefined);
		assert.deepEqual(tool.parameters.required, ["questions"]);
		assert.equal(tool.parameters.properties.questions.maxItems, 4);
		assert.equal(tool.parameters.properties.questions.items.properties.header.maxLength, 16);
		assert.equal(tool.parameters.properties.questions.items.properties.options.items.properties.label.maxLength, 60);
	});
});

test("a description override replaces the built-in text", async () => {
	const { writeFile } = await import("node:fs/promises");
	await withAgentDir(async (agentDir) => {
		await writeFile(join(agentDir, "ask-user-question.json"), JSON.stringify({ guidance: { description: "House style." } }));
		const host = createHost();
		registerAskUserQuestionTool(host.api as never);
		assert.equal(host.tools.get(ASK_USER_QUESTION_TOOL_NAME)?.description, "House style.");
	});
});

test("a non-interactive host gets no_ui instead of a dialog", async () => {
	await withAgentDir(async () => {
		const host = createHost();
		registerAskUserQuestionTool(host.api as never);
		const tool = host.tools.get(ASK_USER_QUESTION_TOOL_NAME)!;
		const result = await tool.execute("call", params, undefined, undefined, { hasUI: false, mode: "print", ui: {} });
		assert.deepEqual(result.details, { answers: [], cancelled: true, error: "no_ui" });
	});
});

test("validation failures never open the UI", async () => {
	await withAgentDir(async () => {
		const host = createHost();
		registerAskUserQuestionTool(host.api as never);
		const tool = host.tools.get(ASK_USER_QUESTION_TOOL_NAME)!;
		const ctx = {
			hasUI: true,
			mode: "tui",
			ui: { custom: () => { throw new Error("the dialog must not open"); } },
		};
		const result = await tool.execute("call", {
			questions: [{ question: "Q?", header: "H", options: [{ label: "Only", description: "d" }] }],
		}, undefined, undefined, ctx);
		assert.equal(result.details.error, "empty_options");
	});
});

test("an already-aborted call cancels without opening the UI", async () => {
	await withAgentDir(async () => {
		const host = createHost();
		registerAskUserQuestionTool(host.api as never);
		const tool = host.tools.get(ASK_USER_QUESTION_TOOL_NAME)!;
		const controller = new AbortController();
		controller.abort();
		const ctx = {
			hasUI: true,
			mode: "tui",
			ui: { custom: () => { throw new Error("the dialog must not open"); } },
		};
		const result = await tool.execute("call", params, controller.signal, undefined, ctx);
		assert.deepEqual(result.details, { answers: [], cancelled: true });
	});
});

test("an RPC host walks the native dialogs and maps a free-text answer", async () => {
	await withAgentDir(async () => {
		const host = createHost();
		registerAskUserQuestionTool(host.api as never);
		const tool = host.tools.get(ASK_USER_QUESTION_TOOL_NAME)!;
		const controller = new AbortController();
		const seen: unknown[] = [];
		const ctx = {
			hasUI: true,
			mode: "rpc",
			ui: {
				select: async (title: string, options: string[], opts?: unknown) => {
					seen.push({ title, options, opts });
					return options[options.length - 1];
				},
				input: async (_title: string, _placeholder?: string, opts?: unknown) => {
					seen.push({ opts });
					return "typed answer";
				},
			},
		};
		const result = await tool.execute("call", params, controller.signal, undefined, ctx);
		assert.equal(result.details.answers[0]?.kind, "custom");
		assert.equal(result.details.answers[0]?.answer, "typed answer");
		assert.deepEqual((seen[0] as { opts: unknown }).opts, { signal: controller.signal });
	});
});

test("dismissing an RPC dialog cancels without claiming the user answered", async () => {
	await withAgentDir(async () => {
		const host = createHost();
		registerAskUserQuestionTool(host.api as never);
		const tool = host.tools.get(ASK_USER_QUESTION_TOOL_NAME)!;
		const ctx = { hasUI: true, mode: "rpc", ui: { select: async () => undefined, input: async () => undefined } };
		const result = await tool.execute("call", params, undefined, undefined, ctx);
		assert.deepEqual(result.details, { answers: [], cancelled: true });
		assert.equal(result.content[0]?.text, DECLINE_MESSAGE);
	});
});

test("the reconciler strips the tool without UI and never re-adds an operator-removed one", () => {
	const host = createHost();
	registerAskUserQuestionReconciler(host.api as never);
	const reconcile = host.handlers.get("before_agent_start")!;
	reconcile({}, { hasUI: false });
	assert.ok(!host.active.includes(ASK_USER_QUESTION_TOOL_NAME));
	reconcile({}, { hasUI: true });
	assert.ok(!host.active.includes(ASK_USER_QUESTION_TOOL_NAME), "a removed tool is not resurrected");
	assert.ok(host.active.includes("read"), "sibling tools are untouched");
});

test("the reconciler leaves an active tool alone when the host has UI", () => {
	const host = createHost();
	registerAskUserQuestionReconciler(host.api as never);
	const reconcile = host.handlers.get("before_agent_start")!;
	reconcile({}, { hasUI: true });
	assert.ok(host.active.includes(ASK_USER_QUESTION_TOOL_NAME));
});
