import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import loop from "../src/index.ts";

export const MINUTE = 60_000;
export const DAY = 86_400_000;

type Handler = (event: { type: string }, ctx: ExtensionContext) => unknown;
type Command = (args: string, ctx: ExtensionCommandContext) => unknown;

/** Only the public boundary is replaced; the real factory owns parsing, jobs and scheduling. */
export function loopHarness(t: TestContext) {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_700_000_000_000 });
	const handlers = new Map<string, Handler>();
	const delivered: { prompt: string; expandPromptTemplates: boolean | undefined }[] = [];
	const notices: { message: string; level: string | undefined }[] = [];
	const statuses = new Map<string, string | undefined>();
	let command: Command | undefined;
	let idle = true;
	let queued = false;
	let sessionId = "synthetic-session";
	let deliveryError = false;
	let obsolete = false;
	let commands: { name: string; source: string }[] = [];
	function active(): void {
		assert.equal(obsolete, false, "disposed context must not be accessed by timers");
	}
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: process.cwd(),
		ui: {
			setStatus: (key: string, text: string | undefined) => {
				active();
				statuses.set(key, text);
			},
			notify: (message: string, level?: string) => {
				active();
				notices.push({ message, level });
			},
		},
		sessionManager: { getSessionId: () => { active(); return sessionId; } },
		isIdle: () => { active(); return idle; },
		hasPendingMessages: () => { active(); return queued; },
	} as unknown as ExtensionCommandContext;
	const pi = {
		on: (name: string, handler: Handler) => { handlers.set(name, handler); },
		registerCommand: (name: string, definition: { handler: Command }) => {
			assert.equal(name, "loop");
			command = definition.handler;
		},
		getCommands: () => commands,
		sendUserMessage: (prompt: string, options?: { expandPromptTemplates?: boolean }) => {
			if (deliveryError) throw new Error("scripted delivery failure");
			delivered.push({ prompt, expandPromptTemplates: options?.expandPromptTemplates });
		},
	} as unknown as ExtensionAPI;
	loop(pi);
	const emit = (name: string, context: ExtensionContext = ctx) => handlers.get(name)?.({ type: name }, context);
	t.after(() => { obsolete = false; emit("session_shutdown"); });
	return {
		ctx, delivered, notices, statuses, emit,
		command: (args: string, context = ctx) => { assert.ok(command); return command(args, context); },
		tick: (milliseconds: number) => t.mock.timers.tick(milliseconds),
		setTime: (now: number) => t.mock.timers.setTime(now),
		setIdle: (value: boolean) => { idle = value; },
		setQueued: (value: boolean) => { queued = value; },
		setSessionId: (value: string) => { sessionId = value; },
		setDeliveryError: (value: boolean) => { deliveryError = value; },
		setCommands: (value: typeof commands) => { commands = value; },
		invalidateContext: () => { obsolete = true; },
		createdId: () => {
			const id = /^Loop ([a-f0-9]{8})：/u.exec(notices.at(-1)?.message ?? "")?.[1];
			assert.ok(id, "creation reports the cancellable job ID");
			return id;
		},
	};
}
