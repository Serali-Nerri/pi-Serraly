// Shared source-aware presentation policy for all compatibility domains.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { config } from "../config/config.ts";

const NATIVE_TOOLS = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
let tools: (() => ReturnType<ExtensionAPI["getAllTools"]>) | undefined;
let observedDefinitions = new Map<string, any>();

/** Bound only by the session owner; no tool definitions are replaced or registered. */
export function bindRendererPolicy(provider: () => ReturnType<ExtensionAPI["getAllTools"]>): () => void {
	tools = provider;
	observedDefinitions = new Map();
	return () => {
		if (tools === provider) { tools = undefined; observedDefinitions.clear(); }
	};
}

export interface RendererPolicy {
	managed: boolean;
	groupable: boolean;
	compactable: boolean;
	reason: "off" | "excluded" | "dedicated" | "builtin" | "generic";
}

export type ManagedView = "generic" | "file" | "patch";
export function managedView(name: string, policy: Pick<RendererPolicy, "reason">): ManagedView {
	if (name === "apply_patch") return "patch";
	return policy.reason === "builtin" && (name === "write" || name === "edit") ? "file" : "generic";
}

/** A single decision is shared by renderers, grouping, compact, background and mouse. */
export function resolveRendererPolicy(componentOrName: any, suppliedDefinition?: any): RendererPolicy {
	const component = typeof componentOrName === "string" ? undefined : componentOrName;
	const name = String(component?.toolName ?? component?.toolDefinition?.name ?? componentOrName ?? "");
	const currentDefinition = suppliedDefinition ?? component?.toolDefinition;
	if (currentDefinition) observedDefinitions.set(name, currentDefinition);
	const definition = currentDefinition ?? observedDefinitions.get(name);
	const native = (reason: RendererPolicy["reason"]): RendererPolicy =>
		({ managed: false, groupable: false, compactable: false, reason });
	if (config.mode === "off") return native("off");
	if (config.excludeRenderers.includes(name)) return native("excluded");
	let source: ReturnType<ExtensionAPI["getAllTools"]>[number]["sourceInfo"] | undefined;
	try { source = tools?.().find((tool) => tool.name === name)?.sourceInfo; } catch { /* Unbound or stale context. */ }
	const builtin = NATIVE_TOOLS.has(name) && source?.source === "builtin" && source.path === `builtin:${name}`;
	// Public metadata intentionally omits renderers. Until a custom tool component
	// supplies its definition, compact must not count or suppress that tool.
	if (!builtin && !definition && (source || !NATIVE_TOOLS.has(name))) return native("dedicated");
	const hasDedicatedRenderer = definition?.renderShell === "self" ||
		typeof definition?.renderCall === "function" || typeof definition?.renderResult === "function";
	if (!builtin && hasDedicatedRenderer) return native("dedicated");
	const reason = builtin ? "builtin" : "generic";
	const aggregate = managedView(name, { reason }) === "generic";
	return { managed: true, groupable: aggregate, compactable: aggregate, reason };
}
