import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager, type CustomEntry, type EntryRenderer, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { registerActivityCompletion } from "../src/activity-completion.js";

function harness(session = SessionManager.inMemory("/fixture")) {
	const handlers = new Map<string, Set<(event: unknown) => void>>();
	const renderers = new Map<string, EntryRenderer>();
	const pi = {
		on(name: string, handler: (event: unknown) => void) {
			const listeners = handlers.get(name) ?? new Set();
			handlers.set(name, listeners);
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
		registerEntryRenderer(name: string, renderer: EntryRenderer) { renderers.set(name, renderer); },
		appendEntry(name: string, data: unknown) { session.appendCustomEntry(name, data); },
	} as unknown as ExtensionAPI;
	const completion = registerActivityCompletion(pi);
	const theme = { fg: (_role: string, text: string) => text } as Theme;
	const entries = () => session.getBranch().filter((entry): entry is CustomEntry => entry.type === "custom");
	return {
		completion, entries, session, renderers, theme,
		emit(name: string, event: unknown = { type: name }) { for (const handler of [...(handlers.get(name) ?? [])]) handler(event); },
		render(entry: CustomEntry, width = 80) {
			return renderers.get(entry.customType)?.(entry, {
				expanded: false,
				keyText: () => "",
				keyHint: () => "",
			}, theme)?.render(width).map(stripTerminalSequences);
		},
	};
}

test("one frozen, right-aligned completion follows the entire activity, not intermediate agent ends", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 0, 2, 14, 29, 50).getTime() });
	const h = harness();
	h.completion.start();
	t.after(() => h.completion.stop());
	h.emit("agent_start");
	t.mock.timers.tick(2_000);
	h.emit("agent_end");
	assert.equal(h.entries().length, 0);
	h.emit("agent_start");
	t.mock.timers.tick(136_000);
	h.emit("agent_settled");
	assert.equal(h.entries().length, 1);
	const record = h.entries()[0]!;
	assert.equal(h.render(record)?.[0], " ".repeat(52) + "Worked for 2m 18s · 14:32:08");
	t.mock.timers.tick(60_000);
	h.emit("agent_settled");
	assert.equal(h.entries().length, 1);
	assert.deepEqual(h.render(record, 12), ["Worked for …"]);
	assert.deepEqual(h.render(record, 1), ["…"]);
	t.mock.timers.setTime(new Date(2026, 0, 3, 1).getTime());
	assert.equal(h.render(record)?.[0]?.trim(), "Worked for 2m 18s · 2026-01-02 14:32:08");
	assert.deepEqual(h.session.buildSessionContext().messages, [], "presentation does not become model content");
});

test("overlapping UI waits are excluded once, including a manual stop while still waiting", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 0, 2, 14).getTime() });
	const h = harness();
	h.completion.start();
	t.after(() => h.completion.stop());
	h.emit("ui_prompt_end");
	h.emit("agent_start");
	for (const toolCallId of ["one", "two"]) h.emit("tool_execution_start", { toolCallId });
	t.mock.timers.tick(1_000);
	h.emit("ui_prompt_start");
	t.mock.timers.tick(10_000);
	h.emit("ui_prompt_start");
	t.mock.timers.tick(5_000);
	h.emit("ui_prompt_end");
	t.mock.timers.tick(5_000);
	h.emit("ui_prompt_end");
	t.mock.timers.tick(2_000);
	h.emit("agent_settled", { type: "agent_settled", aborted: false });
	assert.equal(h.render(h.entries()[0]!)?.[0]?.trim(), "Worked for 3s · 14:00:23");
	h.emit("agent_start");
	t.mock.timers.tick(1_000);
	h.emit("ui_prompt_start");
	t.mock.timers.tick(3_000);
	h.emit("agent_settled", { type: "agent_settled", aborted: true });
	assert.equal(h.render(h.entries()[1]!)?.[0]?.trim(), "Worked for 1s · 14:00:27");
});

test("navigation and session replacement discard unfinished work and inactive sessions write nothing", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
	const h = harness();
	t.after(() => h.completion.stop());
	h.emit("agent_start");
	h.emit("agent_settled");
	assert.deepEqual(h.entries(), []);
	h.completion.start();
	h.emit("agent_start");
	t.mock.timers.tick(1_000);
	h.emit("session_tree");
	h.emit("agent_settled");
	assert.deepEqual(h.entries(), []);
	h.emit("agent_start");
	h.completion.stop();
	h.completion.stop();
	h.emit("agent_settled");
	h.completion.start();
	h.completion.start();
	h.emit("agent_settled");
	assert.deepEqual(h.entries(), []);
	h.emit("agent_start");
	h.emit("agent_settled");
	assert.equal(h.entries().length, 1);
	assert.match(h.render(h.entries()[0]!)?.[0] ?? "", /Worked for <1s/);
});

test("saved completions render after reopen only with their visible history and never become model messages", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 0, 2, 14).getTime() });
	const directory = mkdtempSync(join(tmpdir(), "pi-ui-completion-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const session = SessionManager.create(directory, directory);
	const user = session.appendMessage({ role: "user", content: "A local fixture", timestamp: Date.now() });
	const h = harness(session);
	h.completion.start();
	h.emit("agent_start");
	t.mock.timers.tick(2_000);
	h.emit("agent_settled");
	h.completion.stop();
	const reopened = harness(SessionManager.open(session.getSessionFile()!));
	assert.equal(reopened.entries().length, 1);
	assert.equal(reopened.render(reopened.entries()[0]!)?.[0]?.trim(), "Worked for 2s · 14:00:02");
	assert.deepEqual(reopened.session.buildSessionContext().messages.map((message) => message.role), ["user"]);
	reopened.session.branch(user);
	assert.deepEqual(reopened.entries(), []);
});
