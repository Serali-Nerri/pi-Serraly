// Pure-display host compatibility. Views live in transcript/tool-renderers.ts.
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { config } from "../config/config.ts";
import { createCcstyleTool } from "../transcript/tool-renderers.ts";
import {
	COMPONENT_TOOL_RENDER_MODE, GLOBAL_TOOL_RENDER_PATCH, patchRegistry, TOOL_EXPANDED_BACKGROUND_PATCH,
} from "./patch-keys.ts";
import { getMessageDisplayTheme } from "./message-display.ts";
import { managedView, resolveRendererPolicy } from "./policy.ts";
import { captureMethod, installMethodStep } from "./method-pipeline.ts";

type Methods = {
	hasRendererDefinition: (...args: any[]) => boolean;
	getRenderShell: (...args: any[]) => "default" | "self";
	getCallRenderer: (...args: any[]) => any;
	getResultRenderer: (...args: any[]) => any;
};
const METHOD_NAMES = ["hasRendererDefinition", "getRenderShell", "getCallRenderer", "getResultRenderer"] as const;
type Patch = {
	version: 2;
	prototype: any;
	active: boolean;
	byDefinition: WeakMap<object, any>;
	byName: Map<string, any>;
	downstream: Methods;
	installed: Methods;
};
export type DefaultModeHooks = { isOwner(): boolean; shutdown(): void };

function requireMethods(proto: any, methods: readonly string[]): void {
	for (const name of methods) if (typeof proto?.[name] !== "function") {
		throw new Error(`Pi 1.0.0 tool component lacks ${name}; native rendering retained`);
	}
}
function syncShell(component: any, shell: "default" | "self"): void {
	const target = shell === "self" ? component.selfRenderContainer : component.contentBox;
	if (!target || !Array.isArray(component.children)) return;
	const candidates = new Set([component.contentTextRegion, component.contentText, component.contentBox, component.selfRenderContainer].filter(Boolean));
	const indexes = component.children.map((child: any, index: number) => candidates.has(child) ? index : -1).filter((index: number) => index >= 0);
	const targetIndex = indexes[0];
	// Constructor has not mounted the shell yet: never insert it twice.
	if (targetIndex === undefined) return;
	component.children[targetIndex] = target;
	for (const index of indexes.sort((a: number, b: number) => b - a)) if (index !== targetIndex) component.children.splice(index, 1);
}
function managed(component: any): boolean {
	const result = resolveRendererPolicy(component).managed;
	component[COMPONENT_TOOL_RENDER_MODE] = result;
	return result;
}
function renderer(component: any, patch: Patch): any {
	const kind = managedView(String(component.toolName), resolveRendererPolicy(component));
	const definition = component.toolDefinition ?? component.builtInToolDefinition;
	if (definition && typeof definition === "object") {
		let cached = patch.byDefinition.get(definition);
		if (!cached || cached.kind !== kind) {
			cached = { kind, value: createCcstyleTool(definition, kind) };
			patch.byDefinition.set(definition, cached);
		}
		return cached.value;
	}
	const name = String(component.toolName || "tool");
	let cached = patch.byName.get(name);
	if (!cached || cached.kind !== kind) {
		cached = { kind, value: createCcstyleTool({ name, label: name }, kind) };
		patch.byName.set(name, cached);
	}
	return cached.value;
}
function release(patch: Patch): void {
	patch.active = false;
	patch.byDefinition = new WeakMap();
	patch.byName.clear();
	for (const key of METHOD_NAMES) if (patch.prototype[key] === patch.installed[key]) patch.prototype[key] = patch.downstream[key];
	patchRegistry.dispose(GLOBAL_TOOL_RENDER_PATCH, patch);
}

/** Keep legacy v2 ownership keys and unwrap only wrappers still owned by that patch. */
export function installDefaultMode(): DefaultModeHooks {
	const proto = ToolExecutionComponent.prototype as any;
	requireMethods(proto, METHOD_NAMES);
	const previous = patchRegistry.get<Patch>(GLOBAL_TOOL_RENDER_PATCH);
	const downstream = Object.fromEntries(METHOD_NAMES.map((key) => [key,
		previous?.version === 2 && previous.prototype === proto && proto[key] === previous.installed?.[key]
			? previous.downstream[key] : proto[key],
	])) as Methods;
	if (previous?.version === 2) {
		previous.active = false;
		previous.byDefinition = new WeakMap();
		previous.byName.clear();
	}
	const patch: Patch = { version: 2, prototype: proto, active: true, byDefinition: new WeakMap(), byName: new Map(), downstream, installed: undefined as any };
	patch.installed = {
		hasRendererDefinition(this: any, ...args: any[]) {
			return patch.active && managed(this) ? true : patch.downstream.hasRendererDefinition.apply(this, args);
		},
		getRenderShell(this: any, ...args: any[]) {
			if (!patch.active) return patch.downstream.getRenderShell.apply(this, args);
			const shell = managed(this) ? this.expanded && resolveRendererPolicy(this).groupable ? "default" : "self" : patch.downstream.getRenderShell.apply(this, args);
			syncShell(this, shell);
			return shell;
		},
		getCallRenderer(this: any, ...args: any[]) {
			return patch.active && managed(this) ? renderer(this, patch).renderCall : patch.downstream.getCallRenderer.apply(this, args);
		},
		getResultRenderer(this: any, ...args: any[]) {
			return patch.active && managed(this) ? renderer(this, patch).renderResult : patch.downstream.getResultRenderer.apply(this, args);
		},
	};
	for (const key of METHOD_NAMES) proto[key] = patch.installed[key];
	patchRegistry.install(GLOBAL_TOOL_RENDER_PATCH, patch);
	return { isOwner: () => patch.active && patchRegistry.owns(GLOBAL_TOOL_RENDER_PATCH, patch), shutdown: () => release(patch) };
}

/** Expanded managed tools only; dedicated/off/excluded cards keep their own shell. */
export function installToolExpandedBackground(): () => void {
	patchRegistry.get<{ dispose(): void }>(TOOL_EXPANDED_BACKGROUND_PATCH)?.dispose();
	const proto = ToolExecutionComponent.prototype as any;
	requireMethods(proto, ["updateDisplay"]);
	const original = captureMethod(proto, "updateDisplay");
	const boxes = new Map<any, { paddingX: number; paddingY: number; nativeBg: any; installedBg: any }>();
	const restore = (box: any) => {
		const saved = boxes.get(box);
		if (!saved) return;
		if (box.bgFn === saved.installedBg) {
			box.paddingX = saved.paddingX; box.paddingY = saved.paddingY;
			box.setBgFn?.(saved.nativeBg);
		}
		boxes.delete(box);
	};
	let active = true;
	const installed = function (this: any) {
		restore(this.contentBox);
		original.call(this);
		if (!active || config.mode !== "on" || !managed(this) || !this.expanded || !resolveRendererPolicy(this).groupable) return;
		const theme = getMessageDisplayTheme();
		const box = this.contentBox;
		if (!box || !theme?.bg) return;
		const installedBg = (text: string) => theme.bg("userMessageBg", text);
		boxes.set(box, { paddingX: box.paddingX, paddingY: box.paddingY, nativeBg: box.bgFn, installedBg });
		box.paddingX = 1; box.paddingY = 1; box.setBgFn?.(installedBg);
	};
	const patch = { dispose() {
		if (!active) return;
		active = false;
		step.dispose();
		for (const box of boxes.keys()) restore(box);
		patchRegistry.dispose(TOOL_EXPANDED_BACKGROUND_PATCH, patch);
	} };
	const step = installMethodStep(proto, "updateDisplay", () => installed);
	patchRegistry.install(TOOL_EXPANDED_BACKGROUND_PATCH, patch);
	return patch.dispose;
}
