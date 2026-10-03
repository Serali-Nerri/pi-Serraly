import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TestContext } from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import addDirExtension from "../src/index.ts";

export interface ScriptedExecResult {
	code: number;
	killed: boolean;
	stdout: string;
	stderr: string;
}

export type ScriptedExec = (
	command: string,
	args: string[],
	options?: { cwd?: string; signal?: AbortSignal; timeout?: number },
) => Promise<ScriptedExecResult> | ScriptedExecResult;

interface RegisteredCommand {
	description?: string;
	handler: (args: string, ctx: ExtensionCommandContext) => unknown;
}

interface RegisteredHandler {
	(event: unknown, ctx: ExtensionContext): unknown;
}

export interface HarnessOptions {
	agentDir?: string;
	exec?: ScriptedExec;
}

/**
 * Only the public host boundary is replaced; the real factory owns validation,
 * persistence and lifecycle decisions.
 */
export function addDirHarness(t: TestContext, options: HarnessOptions = {}) {
	const handlers = new Map<string, RegisteredHandler>();
	const commands = new Map<string, RegisteredCommand>();
	const tools: string[] = [];
	const appendedEntries: Array<{ customType: string; data: unknown }> = [];
	const sentMessages: Array<{ content: string; expandPromptTemplates?: boolean }> = [];
	const notices: Array<{ message: string; level: string | undefined }> = [];
	const widgets = new Map<string, unknown>();
	const autocompleteFactories: Array<(current: never) => unknown> = [];
	const widgetRenders: string[][] = [];
	const state = {
		mode: "tui" as "tui" | "rpc" | "print" | "json",
		hasUI: true,
		cwd: process.cwd(),
		branch: () => [] as unknown[],
		input: (async () => undefined) as () => Promise<string | undefined>,
		select: (async () => undefined) as (
			title: string,
			choices: string[],
		) => Promise<string | undefined>,
		reloadCount: 0,
		appendError: null as Error | null,
		/** When set, the host records the entry in the live branch before the append fails. */
		appendCommits: false,
		branchEntries: [] as unknown[],
		/** Every entry the host knows, including other branches, like Pi's entry index. */
		entries: new Map<string, unknown>(),
		leafId: null as string | null,
		sessionId: "pi-add-dir-test-session",
		nextEntryId: 1,
		inputCalls: 0,
		selectCalls: 0,
		slashCommands: [] as SlashCommandInfo[],
	};
	const execCalls: Array<{ command: string; args: string[]; cwd: string | undefined }> = [];

	const ctx = {
		get mode() {
			return state.mode;
		},
		get hasUI() {
			return state.hasUI;
		},
		get cwd() {
			return state.cwd;
		},
		ui: {
			notify(message: string, level?: string) {
				notices.push({ message, level });
			},
			addAutocompleteProvider(factory: (current: never) => unknown) {
				assert.equal(state.mode, "tui", "autocomplete is only registered in the TUI");
				autocompleteFactories.push(factory);
			},
			setWidget(key: string, content: unknown) {
				assert.equal(state.mode, "tui", "widgets are only registered in the TUI");
				widgets.set(key, content);
			},
			input: (title: string) => {
				state.inputCalls += 1;
				void title;
				return state.input();
			},
			select: (title: string, choices: string[]) => {
				state.selectCalls += 1;
				return state.select(title, choices);
			},
		},
		sessionManager: {
			getBranch: () => state.branch(),
			getSessionId: () => state.sessionId,
			getLeafId: () => state.leafId,
			getEntry: (id: string) => state.entries.get(id),
			getEntries: () => [...state.entries.values()],
		},
		reload: async () => {
			state.reloadCount += 1;
		},
	} as unknown as ExtensionCommandContext;

	const pi = {
		on(event: string, handler: RegisteredHandler) {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
		registerCommand(name: string, definition: RegisteredCommand) {
			commands.set(name, definition);
		},
		registerTool(definition: { name: string }) {
			tools.push(definition.name);
		},
		appendEntry(customType: string, data: unknown) {
			if (state.appendError && !state.appendCommits) throw state.appendError;
			const entry = { id: `entry-${state.nextEntryId++}`, parentId: state.leafId, type: "custom", customType, data };
			appendedEntries.push({ customType, data });
			state.branchEntries.push(entry);
			state.entries.set(entry.id, entry);
			state.leafId = entry.id;
			if (state.appendError) throw state.appendError;
		},
		getCommands: () => state.slashCommands,
		sendUserMessage(content: string, messageOptions?: { expandPromptTemplates?: boolean }) {
			sentMessages.push({ content, expandPromptTemplates: messageOptions?.expandPromptTemplates });
		},
		async exec(command: string, args: string[], execOptions?: { cwd?: string; signal?: AbortSignal }) {
			execCalls.push({ command, args, cwd: execOptions?.cwd });
			if (options.exec) return await options.exec(command, args, execOptions);
			if (args[0] === "rev-parse") return { code: 0, killed: false, stdout: "true\n", stderr: "" };
			if (args[0] === "config" && args.includes("--get-all")) return { code: 1, killed: false, stdout: "", stderr: "" };
			return { code: 128, killed: false, stdout: "", stderr: "not a git repository" };
		},
	} as unknown as ExtensionAPI;

	addDirExtension(pi, { agentDir: options.agentDir ?? join(tmpdir(), `pi-add-dir-test-${process.pid}`) });

	const emit = async (name: string, context: ExtensionContext = ctx, event: Record<string, unknown> = {}) =>
		await handlers.get(name)?.({ type: name, cwd: state.cwd, ...event }, context);
	const command = async (name: string, args: string, context: ExtensionCommandContext = ctx) => {
		const definition = commands.get(name);
		assert.ok(definition, `command ${name} is registered`);
		return await definition.handler(args, context);
	};
	return {
		ctx,
		handlers,
		commands,
		tools,
		appendedEntries,
		sentMessages,
		notices,
		widgets,
		autocompleteFactories,
		execCalls,
		state,
		emit,
		command,
		/**
		 * Simulates the host side of tree navigation: Pi re-points its live leaf (and its branch)
		 * before it emits `session_tree`, with no ordering guarantee against other handlers.
		 */
		navigate: (entries: unknown[], leafId?: string | null) => {
			for (const entry of entries) {
				const id = (entry as { id?: string }).id;
				if (typeof id === "string") state.entries.set(id, entry);
			}
			state.branchEntries = entries;
			state.leafId = leafId === undefined ? ((entries.at(-1) as { id?: string } | undefined)?.id ?? null) : leafId;
		},
		/** Registers an existing entry (another branch) without moving the live leaf. */
		rememberEntry: (entry: unknown) => {
			const id = (entry as { id?: string }).id;
			if (typeof id === "string") state.entries.set(id, entry);
		},
		/** Render the active widget factory and capture its lines. */
		renderWidget: (width = 100): string[] => {
			const factory = widgets.get("add-dir");
			if (typeof factory !== "function") return [];
			const theme = new Proxy({} as Record<string, unknown>, {
				get: () => (...parts: string[]) => parts.join(""),
			});
			const component = (
				factory as unknown as (
					tui: unknown,
					theme: unknown,
				) => { render: (width: number) => string[] }
			)(undefined, theme);
			const lines = component.render(width);
			widgetRenders.push(lines);
			return lines;
		},
		lastWidgetLines: () => widgetRenders.at(-1) ?? [],
	};
}
