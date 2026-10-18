import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import {
	AssistantMessageComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	SkillInvocationMessageComponent,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, TuiAltScreen } from "@earendil-works/pi-tui";
import { harness, strip } from "./harness.ts";
import { probeHostCapabilities, requireHostCapabilities, requireReplaceableMethod, thinkingBuildMethod } from "../src/compat/host-capabilities.ts";

const PIPELINES = Symbol.for("pi-ui.method-pipelines");
const tool = ToolExecutionComponent.prototype as any;
const assistant = AssistantMessageComponent.prototype as any;
const branch = BranchSummaryMessageComponent.prototype as any;
const skill = SkillInvocationMessageComponent.prototype as any;
const compaction = CompactionSummaryMessageComponent.prototype as any;

test("the untouched Pi 1.3.0 host satisfies every required display capability", () => {
	assert.deepEqual(probeHostCapabilities(), { ok: true, missing: [] });
	requireHostCapabilities();
});

test("thinking capability selection follows late builders while updateContent remains required", () => {
	const builder = Object.getOwnPropertyDescriptor(assistant, "buildContent");
	const update = Object.getOwnPropertyDescriptor(assistant, "updateContent")!;
	try {
		delete assistant.buildContent;
		assert.equal(thinkingBuildMethod(), "updateContent");
		assert.deepEqual(probeHostCapabilities(), { ok: true, missing: [] });
		assert.equal(Object.hasOwn(assistant, "buildContent"), false, "the probe does not create a builder");

		Object.defineProperty(assistant, "buildContent", {
			configurable: true, writable: true, value: () => { throw new Error("the probe must not build content"); },
		});
		const before = Object.getOwnPropertyDescriptor(assistant, "buildContent");
		assert.equal(thinkingBuildMethod(), "buildContent");
		assert.deepEqual(probeHostCapabilities(), { ok: true, missing: [] });
		assert.deepEqual(Object.getOwnPropertyDescriptor(assistant, "buildContent"), before, "selection and probing are read-only");

		assistant.updateContent = undefined;
		assert.deepEqual(probeHostCapabilities(), {
			ok: false, missing: ["AssistantMessageComponent.updateContent (not a method)"],
		});
	} finally {
		Object.defineProperty(assistant, "updateContent", update);
		if (builder) Object.defineProperty(assistant, "buildContent", builder);
		else delete assistant.buildContent;
	}
});

test("present unusable thinking builders fail preflight instead of falling back to updateContent", () => {
	const builder = Object.getOwnPropertyDescriptor(assistant, "buildContent");
	try {
		for (const [descriptor, reason] of [
			[{ value: undefined, writable: true }, "not a method"],
			[{ value: 42, writable: true }, "not a method"],
			[{ value: () => {}, writable: false }, "not writable"],
			[{ get: () => { throw new Error("the probe must not evaluate a host getter"); } }, "getter-only, not replaceable"],
		] as const) {
			Object.defineProperty(assistant, "buildContent", { configurable: true, ...descriptor });
			const before = Object.getOwnPropertyDescriptor(assistant, "buildContent");
			assert.equal(thinkingBuildMethod(), "buildContent");
			assert.deepEqual(probeHostCapabilities(), {
				ok: false, missing: [`AssistantMessageComponent.buildContent (${reason})`],
			});
			assert.deepEqual(Object.getOwnPropertyDescriptor(assistant, "buildContent"), before);
		}
	} finally {
		if (builder) Object.defineProperty(assistant, "buildContent", builder);
		else delete assistant.buildContent;
	}
});

test("a thinking builder with a setter remains admissible without executing its accessors", () => {
	const builder = Object.getOwnPropertyDescriptor(assistant, "buildContent");
	try {
		Object.defineProperty(assistant, "buildContent", {
			configurable: true,
			get: () => { throw new Error("the probe must not evaluate a host getter"); },
			set: () => { throw new Error("the probe must not write a host setter"); },
		});
		const before = Object.getOwnPropertyDescriptor(assistant, "buildContent");
		assert.equal(thinkingBuildMethod(), "buildContent");
		assert.deepEqual(probeHostCapabilities(), { ok: true, missing: [] });
		assert.deepEqual(Object.getOwnPropertyDescriptor(assistant, "buildContent"), before);
	} finally {
		if (builder) Object.defineProperty(assistant, "buildContent", builder);
		else delete assistant.buildContent;
	}
});

test("a late non-writable thinking builder retains native rendering without partial display patches", async () => {
	const builder = Object.getOwnPropertyDescriptor(assistant, "buildContent");
	const assistantUpdate = assistant.updateContent, assistantRender = assistant.render;
	const toolRender = tool.render, toolUpdate = tool.updateDisplay, summaryUpdate = compaction.updateDisplay;
	const message = {
		role: "assistant", timestamp: 1,
		content: [{ type: "thinking", thinking: "plan" }, { type: "text", text: "Native answer" }],
	} as any;
	const nativeLines = new AssistantMessageComponent(message, true).render(100).map(strip);
	let h: Awaited<ReturnType<typeof harness>> | undefined;
	try {
		h = await harness({
			beforeStart: () => {
				Object.defineProperty(assistant, "buildContent", { configurable: true, writable: false, value: () => {} });
			},
		});
		assert.equal(h.notices.length, 1, "one notification for the failed display domain");
		assert.equal(h.notices[0]!.level, "warning");
		assert.match(h.notices[0]!.message, /AssistantMessageComponent\.buildContent \(not writable\)/);
		assert.match(h.notices[0]!.message, /native rendering retained/);
		assert.equal(assistant.updateContent, assistantUpdate, "thinking never falls back to patching updateContent");
		assert.equal(assistant.render, assistantRender);
		assert.equal(tool.render, toolRender, "no partial tool patch");
		assert.equal(tool.updateDisplay, toolUpdate);
		assert.equal(compaction.updateDisplay, summaryUpdate, "no partial summary patch");
		assert.equal(Object.hasOwn(assistant, PIPELINES), false);
		assert.equal(Object.hasOwn(tool, PIPELINES), false);
		assert.equal(h.widgets.has("pi-ui-bridge"), false);
		const lines = new AssistantMessageComponent(message, true).render(100).map(strip);
		assert.deepEqual(lines, nativeLines, "the native hidden-thinking label and answer are preserved");
		assert.ok(lines.some((line) => line.includes("Thinking...")));
		assert.ok(lines.some((line) => line.includes("Native answer")));
	} finally {
		await h?.close();
		if (builder) Object.defineProperty(assistant, "buildContent", builder);
		else delete assistant.buildContent;
	}
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
		assert.equal(h.widgets.has("pi-ui-bridge"), false,
			"the TUI bridge exists only for the compat domain that was skipped");
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

test("the public probe rejects nonextensible targets with own writable methods without mutating the host", async () => {
	for (const constrain of [Object.preventExtensions, Object.seal]) {
		// Fresh external host classes: irreversible constraints never touch Pi's
		// actual prototypes or another fixture's host.
		const hostUrl = `data:text/javascript,${encodeURIComponent(`
			export class ToolExecutionComponent {
				hasRendererDefinition() {}
				getRenderShell() {}
				getCallRenderer() {}
				getResultRenderer() {}
				updateDisplay() {}
				render() {}
				createResultRegion() {}
			}
			export class AssistantMessageComponent { updateContent() {} render() {} }
			export class SkillInvocationMessageComponent { updateDisplay() {} render() {} }
			export class CompactionSummaryMessageComponent { updateDisplay() {} render() {} }
			export class BranchSummaryMessageComponent { updateDisplay() {} render() {} }
			export class Container { addChild() {} removeChild() {} clear() {} }
			export class TuiAltScreen { dispatchMouseToLayout() {} compositeScrollToEndIndicator() {} clearComponentMouseGesture() {} }
			// ${constrain.name}
		`)}`;
		const host = await import(hostUrl);
		const probeUrl = new URL("../src/compat/host-capabilities.ts", import.meta.url);
		probeUrl.searchParams.set("fixture", constrain.name);
		const hooks = registerHooks({
			resolve(specifier, context, nextResolve) {
				if (context.parentURL === probeUrl.href &&
					["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"].includes(specifier)) {
					return { url: hostUrl, shortCircuit: true };
				}
				return nextResolve(specifier, context);
			},
		});
		try {
			const probe = await import(probeUrl.href);
			assert.deepEqual(probe.probeHostCapabilities(), { ok: true, missing: [] });
			const target = host.ToolExecutionComponent.prototype;
			constrain(target);
			const before = Object.values(host).map((component: any) => Object.getOwnPropertyDescriptors(component.prototype));
			const missing = [
				"ToolExecutionComponent.hasRendererDefinition (target not extensible)",
				"ToolExecutionComponent.getRenderShell (target not extensible)",
				"ToolExecutionComponent.getCallRenderer (target not extensible)",
				"ToolExecutionComponent.getResultRenderer (target not extensible)",
				"ToolExecutionComponent.updateDisplay (target not extensible)",
				"ToolExecutionComponent.render (target not extensible)",
				"ToolExecutionComponent.createResultRegion (target not extensible)",
			];
			assert.deepEqual(probe.probeHostCapabilities(), { ok: false, missing }, constrain.name);
			assert.throws(() => probe.requireHostCapabilities(), (error: any) => {
				assert.deepEqual(error.capabilities, missing);
				return true;
			});
			assert.throws(() => probe.requireReplaceableMethod("ToolExecutionComponent", target, "render"),
				/ToolExecutionComponent\.render \(target not extensible\)/);
			assert.deepEqual(Object.values(host).map((component: any) => Object.getOwnPropertyDescriptors(component.prototype)),
				before, "preflight and in-place guards leave every host prototype unchanged");
		} finally {
			hooks.deregister();
		}
	}
});

test("the probe covers every host prototype the compat domains patch", () => {
	for (const [owner, target, names] of [
		["Container", Container.prototype as any, ["addChild", "removeChild", "clear"]],
		["TuiAltScreen", TuiAltScreen.prototype as any, ["dispatchMouseToLayout", "compositeScrollToEndIndicator", "clearComponentMouseGesture"]],
		["ToolExecutionComponent", tool, ["hasRendererDefinition", "getRenderShell", "getCallRenderer", "getResultRenderer", "updateDisplay", "render", "createResultRegion"]],
		["AssistantMessageComponent", assistant, ["updateContent", "render"]],
		["SkillInvocationMessageComponent", skill, ["updateDisplay", "render"]],
		["CompactionSummaryMessageComponent", compaction, ["updateDisplay", "render"]],
	] as const) {
		for (const name of names) assert.equal(typeof target[name], "function", `${owner}.${name}`);
	}
});
