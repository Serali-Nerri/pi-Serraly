import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { root } from "../../scripts/lib/packages.mjs";
import { entriesByName } from "./fixtures/contracts.mjs";

/**
 * The tool-card consumers register their own renderers; the shared kit owns only
 * the card chrome. These probes call the real factory, take the registered
 * renderCall/renderResult components and assert the shared syntax plus the
 * information each tool must keep.
 */

initTheme("dark", false);

const packageDirectories = {
	background: "extensions/pi-background-shell",
	subagents: "extensions/pi-subagents",
	ui: "extensions/pi-ui",
};

function fakePi() {
	const tools = new Map();
	const commands = new Map();
	const messages = new Map();
	const api = {
		registerTool: (tool) => tools.set(tool.name, tool),
		registerCommand: (name, options) => commands.set(name, options),
		registerShortcut: () => {},
		registerMessageRenderer: (name, factory) => messages.set(name, factory),
		registerProvider: () => {},
		on: () => {},
		events: { on: () => {} },
	};
	return { api, tools, commands, messages };
}

async function loadFactory(consumer, entry) {
	const module = await import(pathToFileURL(join(root, packageDirectories[consumer], entry)).href);
	return module.default;
}

async function registered(consumer, entry = entriesByName[packageDirectories[consumer].split("/").pop()]) {
	const factory = await loadFactory(consumer, entry);
	const pi = fakePi();
	await factory(pi.api);
	return pi;
}

const plain = (lines) => lines.map((line) => stripTerminalSequences(line).trimEnd());
const render = (component, width) => (component ? component.render(width) : []);

/** Assert the shared chrome of one card: `● title summary` then `  ⎿ message`. */
function assertCardSyntax(lines, { title, summary, status }, label) {
	const text = plain(lines);
	assert.ok(text[0]?.startsWith(`● ${title}`), `${label}: header must be the shared card header, got ${JSON.stringify(text[0])}`);
	if (summary !== undefined) assert.ok(text[0].includes(summary), `${label}: header keeps ${JSON.stringify(summary)}, got ${JSON.stringify(text[0])}`);
	if (status !== undefined) {
		assert.ok(text[1]?.startsWith("  ⎿ "), `${label}: result must be the shared status line, got ${JSON.stringify(text[1])}`);
		assert.ok(text[1].includes(status), `${label}: status keeps ${JSON.stringify(status)}, got ${JSON.stringify(text[1])}`);
	}
	for (const line of lines) assert.ok(visibleWidth(line) <= Math.max(1, lines.__width ?? visibleWidth(line)), `${label}: line exceeds the render width`);
}

for (const width of [1, 8, 40, 80]) {
	test(`background and subagents cards keep the shared syntax at width ${width}`, async () => {
		const background = await registered("background", "dist/extensions/background-tasks.js");
		const logs = background.tools.get("bg_logs");
		const logsCall = render(logs.renderCall({ taskId: "task-123" }, theme), width);
		if (width >= 20) assert.ok(plain(logsCall)[0].startsWith("● bg_logs"), JSON.stringify(plain(logsCall)));
		if (width >= 80) assert.equal(plain(logsCall)[0], "● bg_logs task-123");
		const logsResult = render(logs.renderResult({
			content: [{ type: "text", text: "line one\nline two" }],
			details: { task: { id: "task-123", name: "build", outputPath: "/tmp/task-123.log", status: "running" }, tail: true, bytesRead: 4096, truncated: true, path: "/tmp/task-123.log" },
		}, { expanded: false }, theme), width);
		if (width >= 80) {
			assert.equal(plain(logsResult)[0], "  ⎿ tail · 4.0KB · truncated");
			assert.equal(plain(logsResult)[1], "Full output: /tmp/task-123.log");
		}
		const run = background.tools.get("bg_run");
		const runResult = render(run.renderResult({
			content: [{ type: "text", text: "started" }],
			details: { task: { id: "task-9", name: "watch", outputPath: "/tmp/task-9.log", status: "running" } },
		}, {}, theme), width);
		if (width >= 80) {
			assert.equal(plain(runResult)[0], "  ⎿ started watch (task-9)");
			assert.equal(plain(runResult)[1], "Output: /tmp/task-9.log");
		}
		const kill = background.tools.get("bg_kill");
		const killResult = render(kill.renderResult({
			content: [{ type: "text", text: "killed" }],
			details: { task: { id: "task-9", name: "watch", outputPath: "/tmp/task-9.log", status: "killed" } },
		}, {}, theme), width);
		if (width >= 80) assert.equal(plain(killResult)[0], "  ⎿ killed watch (task-9)");
		const status = background.tools.get("bg_status");
		const statusResult = render(status.renderResult({
			content: [{ type: "text", text: "task-9 running" }],
			details: { tasks: [{ id: "task-9", name: "watch", status: "running" }] },
		}, {}, theme), width);
		if (width >= 80) {
			assert.equal(plain(statusResult)[0], "  ⎿ 1 task");
			assert.match(plain(statusResult).join("\n"), /task-9 running/);
		}

		const subagents = await registered("subagents");
		const agent = subagents.tools.get("Agent");
		const agentCall = render(agent.renderCall({ agent: "general-purpose", description: "Review the workspace" }, theme), width);
		if (width >= 80) assert.equal(plain(agentCall)[0], "▸ Agent");
		const agentResult = render(agent.renderResult({
			content: [{ type: "text", text: "done" }],
			details: { type: "general-purpose", description: "Review the workspace", turnCount: 3, toolUses: 5, input: 100, output: 50, contextPercent: 10, durationMs: 60000 },
		}, { expanded: false }, theme), width);
		if (width >= 80) {
			assert.ok(plain(agentResult)[0].startsWith("  ⎿ "), JSON.stringify(plain(agentResult)));
			assert.match(plain(agentResult).join("\n"), /Review the workspace/);
		}
	});
}

test("hostile task text cannot inject terminal control sequences through the shared chrome", async () => {
	const background = await registered("background", "dist/extensions/background-tasks.js");
	const logs = background.tools.get("bg_logs");
	const hostile = "task\u001b[31mred\u0007\nnext";
	const call = render(logs.renderCall({ taskId: hostile }, theme), 40);
	const result = render(logs.renderResult({
		content: [{ type: "text", text: "" }],
		details: { task: { id: hostile, name: hostile, outputPath: "/tmp/x", status: "running" }, tail: false, bytesRead: 10, truncated: false, path: "/tmp/x" },
	}, {}, theme), 40);
	for (const line of [...call, ...result]) {
		assert.ok(!line.includes("\u0007"), "no bell character reaches the terminal");
		assert.ok(!line.includes("\u001b]"), "no OSC sequence reaches the terminal");
	}
	const text = plain(call).join("\n");
	assert.match(text, /task/);
	assert.match(text, /next/);
});

test("every consumer card survives a one-column render", async () => {
	const background = await registered("background", "dist/extensions/background-tasks.js");
	const subagents = await registered("subagents");
	const cards = [
		background.tools.get("bg_logs").renderCall({ taskId: "task-1" }, theme),
		subagents.tools.get("Agent").renderCall({ agent: "general-purpose" }, theme),
	];
	for (const card of cards) {
		const lines = render(card, 1);
		for (const line of lines) assert.ok(visibleWidth(line) <= 1, `width 1 produced ${visibleWidth(line)} columns`);
	}
});

test("the bundled background leaf inlines the kit and keeps the host external", async () => {
	const dist = join(root, packageDirectories.background, "dist");
	const leaf = readFileSync(join(dist, "src/ui/tool-cards.js"), "utf8");
	assert.match(leaf, /renderToolHeader|toolHeaderText/, "the leaf bundle contains the shared kit");
	assert.doesNotMatch(leaf, /from\s*"pi-ui-kit"/, "the leaf bundle must not keep a bare workspace import");
	assert.match(leaf, /@earendil-works\/pi-tui/, "the host TUI package stays external");
	const map = JSON.parse(readFileSync(join(dist, "src/ui/tool-cards.js.map"), "utf8"));
	assert.ok(map.sources.length > 1, "the leaf is an esbuild multi-source bundle, not a one-to-one tsc emit");
	assert.ok(map.sourcesContent?.length === map.sources.length, "every bundled source ships its content");
	assert.ok(map.sources.some((source) => source.includes("pi-ui-kit")), JSON.stringify(map.sources));
});
