import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionToolContext,
	KeybindingsManager,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { AskUserQuestionDialog } from "../src/dialog.ts";
import type { AskUserQuestionDetails, DialogOutcome } from "../src/result.ts";
import { ParamsSchema, type QuestionInput } from "../src/schema.ts";
import { registerAskUserQuestion } from "../src/tool.ts";
import { fakeTui, keys, testQuestion, testTheme } from "./helpers.ts";

type Tool = ToolDefinition<typeof ParamsSchema, AskUserQuestionDetails>;
type Factory = (
	tui: TUI,
	theme: ReturnType<typeof testTheme>,
	keybindings: KeybindingsManager,
	done: (outcome: DialogOutcome) => void,
) => AskUserQuestionDialog;

function register() {
	const tools: Tool[] = [];
	const pi = {
		registerTool: (definition: Tool) => {
			tools.push(definition);
		},
	} as unknown as ExtensionAPI;
	registerAskUserQuestion(pi);
	const tool = tools[0];
	assert.ok(tool, "registerAskUserQuestion must register exactly one tool");
	return { tool };
}

/** A context whose `ui.custom` runs the real dialog with the given keystrokes. */
function tuiContext(script: (component: AskUserQuestionDialog) => void): ExtensionToolContext {
	return {
		mode: "tui",
		ui: {
			custom: (factory: Factory) =>
				new Promise<DialogOutcome>((resolve) => {
					const component = factory(fakeTui(), testTheme(), {} as KeybindingsManager, resolve);
					script(component);
				}),
		},
	} as unknown as ExtensionToolContext;
}

function nonTuiContext(): ExtensionToolContext {
	return { mode: "print", ui: {} } as unknown as ExtensionToolContext;
}

test("registers the Claude Code tool metadata", () => {
	const { tool } = register();
	assert.equal(tool.name, "AskUserQuestion");
	assert.equal(tool.label, "Ask User Question");
	assert.equal(tool.exposure, "deferred");
	assert.equal(tool.namespace?.name, "questions");
	assert.equal(tool.executionMode, "sequential");
	assert.equal(tool.parameters, ParamsSchema);
	assert.match(tool.description, /Use this tool only when you are blocked on a decision/);
	assert.match(tool.description, /Reserve this for decisions where the user's answer changes what you do next/);
});

test("execute refuses to run without the interactive TUI", async () => {
	const { tool } = register();
	const questions = [testQuestion()];
	const result = await tool.execute("call", { questions }, undefined, undefined, nonTuiContext());
	assert.equal(result.content[0]?.type, "text");
	assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /requires the interactive TUI/);
	assert.deepEqual(result.details.questions, questions);
	assert.deepEqual(result.details.answers, {});
});

test("execute maps a submitted answer onto the tool result", async () => {
	const { tool } = register();
	const questions = [testQuestion()];
	const result = await tool.execute(
		"call",
		{ questions },
		undefined,
		undefined,
		tuiContext((component) => component.handleInput(keys.enter)),
	);
	assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", 'Your questions have been answered: "Which database should we use?"="SQLite (Recommended)". You can now continue with these answers in mind.');
	assert.deepEqual(result.details.answers, { "Which database should we use?": "SQLite (Recommended)" });
	assert.equal(result.details.cancelled, undefined);
});

test("execute maps a cancelled dialog onto the did-not-answer result", async () => {
	const { tool } = register();
	const result = await tool.execute(
		"call",
		{ questions: [testQuestion()] },
		undefined,
		undefined,
		tuiContext((component) => component.handleInput(keys.escape)),
	);
	assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", "The user did not answer the questions.");
	assert.equal(result.details.cancelled, true);
});

test("execute rejects questions that violate the schema rules", async () => {
	const { tool } = register();
	const questions: QuestionInput[] = [testQuestion({ options: [{ label: "only", description: "one" }] })];
	await assert.rejects(
		tool.execute("call", { questions }, undefined, undefined, nonTuiContext()),
		/single option has no decision in it/,
	);
});

test("renderCall summarizes the questions", () => {
	const { tool } = register();
	const component = tool.renderCall?.({ questions: [testQuestion()] }, testTheme(), {} as never);
	assert.ok(component);
	assert.match(component.render(80).join("\n"), /● AskUserQuestion 1 question \(Database\)/);
});

test("renderResult lists the answers, notes and freeform responses", () => {
	const { tool } = register();
	const question = testQuestion();
	const result: AgentToolResult<AskUserQuestionDetails> = {
		content: [{ type: "text", text: "ignored" }],
		details: {
			questions: [question],
			answers: { [question.question]: "Postgres" },
			annotations: { [question.question]: { notes: "for JSONB" } },
			response: "also enable WAL",
		},
	};
	const component = tool.renderResult?.(result, {} as never, testTheme(), {} as never);
	assert.ok(component);
	const text = component.render(120).join("\n");
	assert.match(text, /✓ Database: Postgres/);
	assert.match(text, /notes: for JSONB/);
	assert.match(text, /response: also enable WAL/);
});

test("renderResult explains a dismissal", () => {
	const { tool } = register();
	const result: AgentToolResult<AskUserQuestionDetails> = {
		content: [{ type: "text", text: "The user did not answer the questions." }],
		details: { questions: [testQuestion()], answers: {}, cancelled: true },
	};
	const component = tool.renderResult?.(result, {} as never, testTheme(), {} as never);
	assert.ok(component);
	assert.match(component.render(120).join("\n"), /No answer — the question was dismissed\./);
});
