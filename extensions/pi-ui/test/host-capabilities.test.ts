import assert from "node:assert/strict";
import test from "node:test";
import {
	AssistantMessageComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	SkillInvocationMessageComponent,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, TuiAltScreen } from "@earendil-works/pi-tui";
import { harness } from "./harness.ts";
import { probeHostCapabilities, requireHostCapabilities, requireReplaceableMethod } from "../src/compat/host-capabilities.ts";

const PIPELINES = Symbol.for("pi-ui.method-pipelines");
const tool = ToolExecutionComponent.prototype as any;
const assistant = AssistantMessageComponent.prototype as any;
const branch = BranchSummaryMessageComponent.prototype as any;
const skill = SkillInvocationMessageComponent.prototype as any;
const compaction = CompactionSummaryMessageComponent.prototype as any;

test("the untouched Pi 1.0.0 host satisfies every required display capability", () => {
	assert.deepEqual(probeHostCapabilities(), { ok: true, missing: [] });
	requireHostCapabilities();
});

test("a missing required method is reported by name and skips the whole compat domain", async () => {
	const region = tool.createResultRegion, render = tool.render, updateDisplay = tool.updateDisplay;
	const assistantUpdate = assistant.updateContent;
	let h: Awaited<ReturnType<typeof harness>> | undefined;
	try {
		h = await harness({ beforeStart: () => { tool.createResultRegion = undefined; } });
		assert.equal(h.notices.length, 1, "one notification per session");
		assert.equal(h.notices[0]!.level, "warning");
		assert.match(h.notices[0]!.message, /ToolExecutionComponent\.createResultRegion/);
		assert.equal(tool.createResultRegion, undefined, "the skipped domain never writes the host method");
		assert.equal(tool.render, render, "no partial tool patch");
		assert.equal(tool.updateDisplay, updateDisplay);
		assert.equal(assistant.updateContent, assistantUpdate, "thinking stays native as well");
		assert.equal(Object.hasOwn(tool, PIPELINES), false, "no prototype pipeline registration");
		assert.equal(Object.hasOwn(skill, PIPELINES), false);
		assert.equal((globalThis as any)[Symbol.for("claude-style-tools.global-tool-render-patch")], undefined);
		assert.ok(h.commands.has("ccstyle"), "the public shell keeps its commands");
		assert.ok(h.widgets.has("pi-ui-bridge"), "the public shell keeps its bridge widget");
	} finally {
		await h?.close();
		tool.createResultRegion = region;
	}
});

test("several missing capabilities merge into a single notification", async () => {
	const region = tool.createResultRegion, updateDisplay = branch.updateDisplay;
	let h: Awaited<ReturnType<typeof harness>> | undefined;
	try {
		h = await harness({
			beforeStart: () => {
				tool.createResultRegion = undefined;
				branch.updateDisplay = undefined;
			},
		});
		assert.equal(h.notices.length, 1, "multiple failures are merged");
		assert.match(h.notices[0]!.message, /ToolExecutionComponent\.createResultRegion/);
		assert.match(h.notices[0]!.message, /BranchSummaryMessageComponent\.updateDisplay/);
	} finally {
		await h?.close();
		tool.createResultRegion = region;
		branch.updateDisplay = updateDisplay;
	}
});

test("a non-writable summary method is detected before any patch is installed", async () => {
	const descriptor = Object.getOwnPropertyDescriptor(skill, "updateDisplay")!;
	const assistantUpdate = assistant.updateContent, compactionUpdate = compaction.updateDisplay;
	let h: Awaited<ReturnType<typeof harness>> | undefined;
	try {
		Object.defineProperty(skill, "updateDisplay", { ...descriptor, writable: false });
		h = await harness();
		assert.equal(h.notices.length, 1);
		assert.match(h.notices[0]!.message, /SkillInvocationMessageComponent\.updateDisplay/);
		assert.equal(skill.updateDisplay, descriptor.value, "a non-writable method is never replaced");
		assert.equal(compaction.updateDisplay, compactionUpdate, "no sibling summary patch is left behind");
		assert.equal(Object.hasOwn(compaction, PIPELINES), false);
		assert.equal(assistant.updateContent, assistantUpdate, "thinking stays native as well");
		assert.equal((globalThis as any)[Symbol.for("claude-style-tools.message-display-patch")], undefined);
	} finally {
		await h?.close();
		Object.defineProperty(skill, "updateDisplay", descriptor);
	}
});

test("an absent optional handleMouse is accepted and replaced on an extensible prototype", async () => {
	const descriptor = Object.getOwnPropertyDescriptor(assistant, "handleMouse");
	const render = assistant.render;
	let h: Awaited<ReturnType<typeof harness>> | undefined;
	try {
		assistant.handleMouse = undefined;
		h = await harness();
		assert.deepEqual(h.notices, [], "an optional method may be absent");
		assert.equal(typeof assistant.handleMouse, "function", "the mouse domain installs its own handler");
		assert.equal(typeof assistant.render, "function", "the mouse domain still tracks frames");
	} finally {
		await h?.close();
		if (descriptor) Object.defineProperty(assistant, "handleMouse", descriptor);
		else delete assistant.handleMouse;
		assert.equal(typeof assistant.render, "function", `render stays callable (was ${String(render)})`);
	}
});

test("requireReplaceableMethod accepts replaceable and optional members", () => {
	const target: Record<string, unknown> = { present: () => 1 };
	requireReplaceableMethod("Fixture", target, "present");
	requireReplaceableMethod("Fixture", target, "absent", { optional: true });
	Object.defineProperty(target, "accessor", { configurable: true, get: () => () => 2, set: () => {} });
	requireReplaceableMethod("Fixture", target, "accessor");
});

test("requireReplaceableMethod refuses missing, non-method, non-writable and getter-only members", () => {
	const target: Record<string, unknown> = { value: 1 };
	assert.throws(() => requireReplaceableMethod("Fixture", target, "absent"), /Fixture\.absent/);
	assert.throws(() => requireReplaceableMethod("Fixture", target, "value"), /Fixture\.value/);
	Object.defineProperty(target, "fixed", { value: () => 1, writable: false, configurable: false });
	assert.throws(() => requireReplaceableMethod("Fixture", target, "fixed"), /Fixture\.fixed/);
	let invoked = 0;
	Object.defineProperty(target, "getterOnly", { configurable: true, get: () => { invoked++; return () => 3; } });
	assert.throws(() => requireReplaceableMethod("Fixture", target, "getterOnly"), /Fixture\.getterOnly/);
	assert.equal(invoked, 0, "the probe never executes an accessor");
	assert.throws(() => requireReplaceableMethod("Fixture", Object.freeze({}), "handleMouse", { optional: true }), /Fixture\.handleMouse/);
});

test("probeHostCapabilities lists a non-writable capability without writing anything", () => {
	const descriptor = Object.getOwnPropertyDescriptor(tool, "createResultRegion")!;
	const render = tool.render, updateDisplay = tool.updateDisplay;
	try {
		Object.defineProperty(tool, "createResultRegion", { ...descriptor, writable: false });
		assert.deepEqual(probeHostCapabilities(), {
			ok: false,
			missing: ["ToolExecutionComponent.createResultRegion (not writable)"],
		});
		assert.equal(tool.render, render);
		assert.equal(tool.updateDisplay, updateDisplay);
	} finally {
		Object.defineProperty(tool, "createResultRegion", descriptor);
	}
	assert.deepEqual(probeHostCapabilities(), { ok: true, missing: [] });
});

test("the probe covers every host prototype the compat domains patch", () => {
	for (const [owner, target, names] of [
		["Container", Container.prototype as any, ["addChild", "removeChild", "clear"]],
		["TuiAltScreen", TuiAltScreen.prototype as any, ["dispatchMouseToLayout"]],
		["ToolExecutionComponent", tool, ["hasRendererDefinition", "getRenderShell", "getCallRenderer", "getResultRenderer", "updateDisplay", "render", "createResultRegion"]],
		["AssistantMessageComponent", assistant, ["updateContent", "render"]],
		["SkillInvocationMessageComponent", skill, ["updateDisplay", "render"]],
		["CompactionSummaryMessageComponent", compaction, ["updateDisplay", "render"]],
	] as const) {
		for (const name of names) assert.equal(typeof target[name], "function", `${owner}.${name}`);
	}
});
