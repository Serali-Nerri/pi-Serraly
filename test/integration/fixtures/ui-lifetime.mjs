import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";

const { AssistantMessageComponent, discoverAndLoadExtensions, initTheme, SessionManager } = await import(
	new URL("./bundle/index.js", import.meta.resolve("@earendil-works/pi-coding-agent"))
);
initTheme("dark", false);
const cwd = join(process.env.TMPDIR, "ui-host");
await mkdir(cwd);
const loaded = await discoverAndLoadExtensions([
	new URL("../../../packages/pi-ui/dist/index.ts", import.meta.url).pathname,
], cwd, process.env.PI_CODING_AGENT_DIR);
assert.deepEqual(loaded.errors, []);
assert.equal(loaded.extensions.length, 1);
const { handlers } = loaded.extensions[0];
function emit(name, event, context) {
	for (const handler of [...(handlers.get(name) ?? [])]) handler(event, context);
}
const countHandlers = () => [...handlers.values()].reduce((total, list) => total + list.length, 0);
const baselineHandlers = countHandlers();
const originalUpdate = AssistantMessageComponent.prototype.updateContent;
const theme = { fg: (_role, text) => text, bg: (_role, text) => text, bold: (text) => text, italic: (text) => text };

function streamedFrames() {
	const component = new AssistantMessageComponent(undefined, true);
	const refs = [], payloads = [];
	for (let frame = 0; frame < 400; frame++) {
		const message = {
			role: "assistant", timestamp: 1000, provider: "fixture", model: "fixture", api: "openai-responses", stopReason: "stop",
			content: [{ type: "thinking", thinking: `**Current reasoning**\n\n${Array.from({ length: 120 }, (_, line) => `frame_${frame}_line_${line} ${"x".repeat(100)}`).join("\n")}` }],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		};
		emit("message_update", { message, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 } });
		component.updateContent(message, true);
		const rendered = component.render(80).join("\n");
		assert.match(rendered, /Current reasoning/, "the built entry decorates the actual bundled host component");
		const region = component.children[0].children.find((child) => "onMouse" in child);
		assert.ok(region?.child, "the host owns the mouse region around our Thinking view");
		refs.push(new WeakRef(region.child));
		payloads.push(new WeakRef(message));
	}
	return { component, refs, payloads };
}

function mountedUi() {
	let component;
	const notices = [];
	const ui = {
		theme,
		notify(message) { notices.push(message); },
		setFooter(factory) {
			component?.dispose?.();
			component = factory?.({ requestRender() {}, mode: "regular" }, theme, {
				getGitBranch: () => "fixture", getExtensionStatuses: () => new Map(), onBranchChange: () => () => {},
			});
		},
	};
	const ctx = {
		hasUI: true, mode: "tui", ui, cwd: "/fixture", thinkingLevel: "high", model: { id: "fixture", provider: "fixture" },
		sessionManager: SessionManager.inMemory(cwd),
		getContextUsage: () => undefined,
	};
	emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	assert.deepEqual(notices, []);
	return { context: new WeakRef(ctx), render: () => component.render(80) };
}

const mounted = mountedUi();
try {
	const streamed = streamedFrames();
	for (let attempt = 0; attempt < 4; attempt++) { await nextTurn(); globalThis.gc(); }
	assert.equal(streamed.refs.filter((ref) => ref.deref()).length, 1, "obsolete Thinking views are collectable");
	assert.equal(streamed.payloads.filter((ref) => ref.deref()).length, 1, "obsolete streamed messages are collectable");
	assert.equal(mounted.context.deref(), undefined, "the mounted UI does not retain its startup ExtensionContext");
	assert.match(streamed.component.render(80).join("\n"), /frame_399_line_119/);
	assert.match(mounted.render().join("\n"), /fixture/);
} finally {
	emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	loaded.runtime.invalidate();
}
assert.equal(AssistantMessageComponent.prototype.updateContent, originalUpdate, "shutdown restores the actual host prototype");
assert.equal(countHandlers(), baselineHandlers, "all feature event subscriptions are released");
