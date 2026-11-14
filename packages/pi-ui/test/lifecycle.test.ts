import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AssistantMessageComponent, initTheme, SessionManager, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.js";

test("non-TUI sessions leave native presentation untouched and settings explain the mode requirement", async () => {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	let command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> } | undefined;
	const notices: string[] = [];
	let entries = 0;
	const original = AssistantMessageComponent.prototype.updateContent;
	const pi = {
		on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); return () => handlers.delete(name); },
		registerCommand(name: string, definition: typeof command) { if (name === "ui") command = definition; },
		registerEntryRenderer() {}, appendEntry() { entries++; },
	} as unknown as ExtensionAPI;
	extension(pi);
	const ctx = {
		hasUI: false, mode: "print",
		ui: { notify(message: string) { notices.push(message); } },
	} as unknown as ExtensionContext;
	await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
	assert.equal(AssistantMessageComponent.prototype.updateContent, original);
	await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
	await handlers.get("agent_settled")?.({ type: "agent_settled", aborted: false }, ctx);
	assert.equal(entries, 0);
	await command?.handler("", ctx);
	assert.match(notices[0] ?? "", /TUI/);
	await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
	assert.equal(AssistantMessageComponent.prototype.updateContent, original);
});

test("TUI session replacement restores owned presentation and does not accumulate event listeners", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-ui-lifecycle-"));
	const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});
	initTheme("dark");
	const { theme } = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as { theme: Theme };
	const handlers = new Map<string, Set<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const original = AssistantMessageComponent.prototype.updateContent;
	const completionEntries: unknown[] = [];
	const pi = {
		on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
			const list = handlers.get(name) ?? new Set();
			handlers.set(name, list);
			list.add(handler);
			return () => list.delete(handler);
		},
		registerCommand() {}, registerEntryRenderer() {},
		appendEntry(_customType: string, data: unknown) { completionEntries.push(data); },
	} as unknown as ExtensionAPI;
	extension(pi);
	let footer: { render(width: number): string[]; dispose?: () => void } | undefined;
	const notices: string[] = [];
	const ui = {
		theme,
		setFooter(factory: Parameters<ExtensionContext["ui"]["setFooter"]>[0]) {
			footer?.dispose?.();
			footer = factory?.({ requestRender() {}, mode: "regular" } as never, theme, {
				getGitBranch: () => "test", getExtensionStatuses: () => new Map(), onBranchChange: () => () => {}, getAvailableProviderCount: () => 1,
			});
		},
		notify(message: string) { notices.push(message); },
	};
	const ctx = {
		hasUI: true, mode: "tui", ui, cwd: "/fixture",
		sessionManager: SessionManager.inMemory("/fixture"), getContextUsage: () => undefined,
	} as unknown as ExtensionContext;
	async function emit(name: string, event: unknown) {
		for (const handler of [...(handlers.get(name) ?? [])]) await handler(event, ctx);
	}
	const count = () => [...handlers.values()].reduce((sum, list) => sum + list.size, 0);
	const baseline = count();
	let liveCount = 0;
	try {
		for (let session = 0; session < 3; session++) {
			await emit("session_start", { type: "session_start", reason: session === 0 ? "startup" : "reload" });
			assert.ok(footer?.render(80).join("\n").includes("/fixture"));
			assert.notEqual(AssistantMessageComponent.prototype.updateContent, original);
			await emit("agent_start", { type: "agent_start" });
			await emit("agent_settled", { type: "agent_settled", aborted: false });
			assert.equal(completionEntries.length, session + 1, "the active TUI session appends one completion");
			if (session === 0) liveCount = count();
			else assert.equal(count(), liveCount);
			await emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
			assert.equal(footer, undefined);
			assert.equal(AssistantMessageComponent.prototype.updateContent, original);
			assert.equal(count(), baseline);
		}
		assert.deepEqual(notices, []);
	} finally { await emit("session_shutdown", { type: "session_shutdown", reason: "quit" }); }
});
