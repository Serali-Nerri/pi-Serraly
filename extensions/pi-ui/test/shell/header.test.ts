import assert from "node:assert/strict";
import test from "node:test";
import { VERSION, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { installHeader, StartupHeader } from "../../src/shell/header.ts";
import { stripAnsi } from "../../src/shell/utils.ts";

const theme = {
	fg: (color: string, text: string) => `\x1b[${color === "accent" ? "35" : "37"}m${text}\x1b[39m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as Theme;

function headerHarness() {
	let commandReads = 0;
	let effort = "high";
	const pi = {
		getThinkingLevel: () => effort,
		getCommands: () => {
			commandReads++;
			return [{ name: "skill:review" }, { name: "review" }, { name: "review" }];
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: "/tmp/pi-session-ui",
		model: { provider: "openai", id: "gpt-5.6-sol" },
		ui: { theme },
	} as ExtensionContext;
	const header = new StartupHeader(pi, ctx);
	return { header, ctx, reads: () => commandReads, setEffort: (value: string) => { effort = value; } };
}

test("startup header preserves the upstream panel, logo, labels, and command column", () => {
	const { header, reads } = headerHarness();
	const rendered = header.render(120);
	const lines = rendered.map(stripAnsi);
	assert.equal(lines.length, 12);
	assert.ok(lines[0].startsWith(`╭─── Pi v${VERSION} ─────`));
	assert.ok(lines[0].endsWith("╮"));
	assert.equal(lines[11], "╰" + "─".repeat(118) + "╯");
	assert.deepEqual(lines.slice(3, 7).map((line) => line.split("│")[1].trim()), [
		"█████████", "███   ███", "██████   ███", "███      ███",
	]);
	assert.match(lines[2], /│ Welcome/);
	assert.match(lines[3], /│ Ask Pi anything/);
	assert.match(lines[5], /│ Commands/);
	assert.match(lines[8], /Let's build something great/);
	assert.match(lines[9], /openai\/gpt-5\.6-sol · high effort/);
	assert.match(lines[10], /\/tmp\/pi-session-ui/);
	const commands = lines.slice(6, 10).map((line) => line.split("│")[2].trim());
	assert.equal(new Set(commands).size, 4);
	for (const command of commands) assert.match(command, /^\/\S+$/);
	assert.ok(!commands.includes("/pi-session-ui"));
	assert.match(rendered.join("\n"), /\x1b\[35m/);
	assert.deepEqual(header.render(120), rendered);
	assert.equal(reads(), 1, "command collection stays outside rendering");
});

test("startup header fits every terminal width, including wide characters and long labels", () => {
	const { header, ctx } = headerHarness();
	ctx.cwd = "/tmp/工作目录/项目👩‍💻/".repeat(15);
	ctx.model = { provider: "测试供应商", id: "很长的模型名称".repeat(20) } as ExtensionContext["model"];
	for (let width = 0; width <= 220; width++) {
		const lines = header.render(width);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width, `overflow at ${width}: ${stripAnsi(line)}`);
			if (width >= 24) assert.equal(visibleWidth(line), width);
		}
	}
	assert.deepEqual(header.render(0), [""]);
	assert.equal(header.render(23).length, 1);
	assert.doesNotMatch(header.render(48).map(stripAnsi).join("\n"), /Welcome|Commands/);
	assert.match(header.render(49).map(stripAnsi).join("\n"), /Welcome/);
});

test("header cleanup captures host authority and never reads invalidated context getters", () => {
	let invalid = false;
	let cleaning = false;
	let removals = 0;
	let probes = 0;
	const staleReads: PropertyKey[] = [];
	const cleanupRenders: string[][] = [];
	let component: { render(width: number): string[]; dispose(): void } | undefined;
	let savedFactory: Function | undefined;
	const ui = { theme, setHeader(factory: Function | undefined) {
		if (!factory) removals++;
		savedFactory = factory ?? savedFactory;
		component = factory?.({}, theme);
	} };
	const ctx = new Proxy({
		cwd: "/tmp/pi-ui-synthetic", model: undefined, ui,
		sessionManager: { getSessionId: () => "unchanged" },
		isIdle() {
			probes++;
			if (cleaning) cleanupRenders.push(component!.render(120));
			if (invalid) throw new Error("runner.assertActive: invalidated context");
			return false;
		},
	}, { get(target, key, receiver) {
		if (invalid) { staleReads.push(key); throw new Error(`runner.assertActive: stale ${String(key)}`); }
		return Reflect.get(target, key, receiver);
	} }) as unknown as ExtensionContext;
	const pi = { getCommands: () => [], getThinkingLevel: () => "off" } as unknown as ExtensionAPI;
	const cleanup = installHeader(pi, ctx);
	assert.match(component!.render(120).join("\n"), /Welcome/);
	invalid = true;
	assert.throws(() => ctx.sessionManager, /runner\.assertActive/);
	assert.throws(() => ctx.ui, /runner\.assertActive/);
	staleReads.length = 0;
	cleaning = true;
	assert.doesNotThrow(() => cleanup());
	const afterCleanup = probes;
	cleanup(); component!.dispose();
	assert.deepEqual(component!.render(120), []);
	assert.deepEqual(savedFactory!().render(120), []);
	assert.equal(probes, afterCleanup, "idempotent cleanup and obsolete factories never probe the host");
	assert.equal(removals, 0, "an invalidated runner cannot authorize host clearing");
	assert.deepEqual(cleanupRenders, [[]], "disarm rendering before probing the host");
	assert.deepEqual(staleReads, []);
});

test("startup header reflects the current model, thinking level, and theme", () => {
	const { header, ctx, setEffort } = headerHarness();
	header.render(120);
	ctx.model = { provider: "another", id: "new-model" } as ExtensionContext["model"];
	setEffort("off");
	assert.match(header.render(120).map(stripAnsi).join("\n"), /another\/new-model · thinking off/);
	ctx.model = undefined;
	assert.match(header.render(120).map(stripAnsi).join("\n"), /no-model/);
	ctx.ui = { theme: { ...theme, fg: (_color: string, text: string) => `\x1b[32m${text}\x1b[39m` } } as ExtensionContext["ui"];
	assert.match(header.render(120).join("\n"), /\x1b\[32m/);
	assert.doesNotMatch(header.render(120).join("\n"), /\x1b\[35m/);
});
