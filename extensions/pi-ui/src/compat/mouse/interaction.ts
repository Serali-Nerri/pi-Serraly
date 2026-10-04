import {
	AssistantMessageComponent, BranchSummaryMessageComponent, CompactionSummaryMessageComponent,
	SkillInvocationMessageComponent, ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { MouseRegion, TuiAltScreen, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { config } from "../../config/config.ts";
import { showTextPreview } from "../../overlays/text-preview.ts";
import { ThinkingPreviewBlock } from "../../transcript/thinking.ts";
import { walkComponentTree } from "../component-tree.ts";
import { NATIVE_MOUSE_OWNER, patchRegistry } from "../patch-keys.ts";
import { COMPACT_LOCAL_EXPANSION, COMPACT_ROUND_PARENT, isCompactAssistantComponent, setHoveredCompactAssistant } from "../compact-mode.ts";
import { ToolGroupComponent } from "../grouping.ts";
import { isExpandedToolIoView } from "../../transcript/tool/result.ts";
import { setToolTuiFullscreen } from "../../transcript/tool/show-more-hint.ts";
import { setHoveredToolCallId, getToolMouseTui } from "../../overlays/mouse-state.ts";
import { resolveRendererPolicy } from "../policy.ts";
import { requireReplaceableMethod } from "../host-capabilities.ts";

const OWNER = NATIVE_MOUSE_OWNER;
type Preview = { title: string; content: string | Component };
let activeContext: any;
let hovered: { key: unknown; clear: () => void } | undefined;
let hoverVisited = false;
const frames = new WeakMap<object, string[]>();

function plain(text: string): string { return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""); }

export function hintHit(line: string, x: number): boolean {
	const text = plain(line);
	const match = [...text.matchAll(/(?:click|ctrl\+o|[^ ]+) to (?:show more|collapse)/g)].at(-1);
	if (!match) return false;
	const start = visibleWidth(text.slice(0, match.index));
	return x >= start && x < start + visibleWidth(match[0]);
}

function clearHover(): void { hovered?.clear(); hovered = undefined; }

function hover(key: unknown, set: (value: boolean) => void): boolean {
	hoverVisited = true;
	if (hovered?.key === key) return false;
	clearHover(); set(true);
	hovered = { key, clear: () => set(false) };
	return true;
}

function isFullscreen(): boolean { return getToolMouseTui()?.mode === "fullscreen"; }
function isStyleActive(): boolean { return isFullscreen() && config.mode !== "off"; }
// Hidden Thinking is independent of tool/message styling and has no native MouseRegion fallback.
function isCardActive(card: any): boolean {
	return isFullscreen() && (card instanceof ThinkingPreviewBlock || config.mode !== "off");
}

function expand(card: any): void {
	walkComponentTree(getToolMouseTui(), (other) => {
		if (other === card || !other.expanded || typeof other.setExpanded !== "function") return;
		if (other === card[COMPACT_ROUND_PARENT]) return;
		if (card instanceof ThinkingPreviewBlock && isCompactAssistantComponent(other)) return;
		if ((other instanceof ToolExecutionComponent && resolveRendererPolicy(other).managed) || other instanceof ToolGroupComponent ||
			other instanceof ThinkingPreviewBlock || isCompactAssistantComponent(other)) {
			other[COMPACT_LOCAL_EXPANSION] = false; other.setExpanded(false); other.invalidate?.();
		}
	});
	card[COMPACT_LOCAL_EXPANSION] = true;
	card.setExpanded(true); card.invalidate?.(); clearHover();
}

function openPreview(preview: Preview): void {
	clearHover();
	void showTextPreview(activeContext, preview.title, preview.content).catch((error: unknown) =>
		activeContext?.ui?.notify(error instanceof Error ? error.message : String(error), "error"));
}

function cardEvent(card: any, event: TuiMouseEvent, line: string, setHover: (value: boolean) => void, preview?: Preview): any {
	if (!isCardActive(card)) return undefined;
	const groupHeader = card instanceof ToolGroupComponent && event.y === 1;
	const hit = (!card.expanded || preview !== undefined || groupHeader) && hintHit(line, event.x);
	if (event.type === "move") {
		const changed = hit && hover(preview?.title ?? card, setHover);
		return hit ? { handled: true, render: changed } : undefined;
	}
	// Only the explicit action captures the press. Body drags stay with Pi selection.
	if (event.type === "press" && event.button === "left" && hit) return { handled: true, render: false };
	if (event.type !== "click" || event.button !== "left") return undefined;
	if (preview && hit && card.expanded) { openPreview(preview); return { handled: true }; }
	if (!card.expanded && hit) { expand(card); return { handled: true }; }
	if (card.expanded) {
		card[COMPACT_LOCAL_EXPANSION] = false;
		card.setExpanded(false); card.invalidate?.(); clearHover(); return { handled: true };
	}
	return undefined;
}

function toolRegion(host: any, child: any, fallback: Component): Component {
	let lines: string[] = [];
	const region = new MouseRegion(child, (event) => {
		if (!isStyleActive() || !resolveRendererPolicy(host).managed) return fallback.handleMouse?.(event);
		const line = child === host.callRendererComponent ? "" : lines[event.y] ?? "";
		let preview: Preview | undefined = child.previewAtRow?.(event.y);
		if (isExpandedToolIoView(child)) {
			const section = child.showMoreHeaderLineIndexes().find((entry) => entry.line === event.y)?.section;
			if (section) preview = { title: `${host.toolName}: ${section}`, content: section === "input" ? child.getInputBody() : child.getOutputBody() };
		}
		return cardEvent(host, event, line, (value) => {
			child.setHintHovered?.(value);
			if (isExpandedToolIoView(child)) {
				const section = child.showMoreHeaderLineIndexes().find((entry) => entry.line === event.y)?.section;
				child.setHoveredSection(value ? section ?? null : null);
			}
			setHoveredToolCallId(value ? host.toolCallId : null); host.invalidate?.();
		}, preview);
	});
	region.render = (width) => { lines = child.render(width); return lines; };
	return region;
}

export function installToolMouseInteraction(ctx: any): () => void {
	patchRegistry.getOwned(OWNER, (value): value is { dispose(): void } =>
		typeof value === "object" && value !== null && typeof (value as { dispose?: unknown }).dispose === "function")?.dispose();
	activeContext = ctx;
	const patches: Array<{ proto: any; key: string; original: any; installed: any }> = [];
	let disposed = false;
	const patch = (owner: string, proto: any, key: string, factory: (original: any) => any) => {
		requireReplaceableMethod(owner, proto, key, { optional: key === "handleMouse" });
		const original = proto[key]; const installed = factory(original);
		proto[key] = installed; patches.push({ proto, key, original, installed });
	};
	const installation = { dispose() {
		if (disposed) return;
		disposed = true; clearHover();
		for (const { proto, key, original, installed } of patches.reverse()) {
			if (proto[key] === installed) {
				if (original === undefined) delete proto[key]; else proto[key] = original;
			}
		}
		if (patchRegistry.owns(OWNER, installation)) {
			activeContext = undefined;
			patchRegistry.dispose(OWNER, installation);
		}
	} };
	// Register before the first write: a failure in any later patch releases the
	// prototypes that were already replaced instead of leaving them owned.
	patchRegistry.installOwned(OWNER, installation);
	const toolProto = ToolExecutionComponent.prototype as any;
	try {
		patch("ToolExecutionComponent", toolProto, "createResultRegion", (original) => function (this: any, child: any) {
			const native = original.call(this, child);
			if (!resolveRendererPolicy(this).managed) return native;
			return toolRegion(this, child, native);
		});
		const track = (owner: string, proto: any) => patch(owner, proto, "render", (original) => function (this: any, width: number) {
			const lines = original.call(this, width); frames.set(this, lines); return lines;
		});
		const expandable = (owner: string, proto: any, enabled: (value: any) => boolean = () => true) => {
			track(owner, proto);
			patch(owner, proto, "handleMouse", (original) => function (this: any, event: TuiMouseEvent) {
				if (!isCardActive(this) || !enabled(this)) return original?.call(this, event);
				const lines = frames.get(this) ?? [];
				const line = lines[event.y] ?? "";
				const setHover = (value: boolean) => {
					if (isCompactAssistantComponent(this)) setHoveredCompactAssistant(value ? this : undefined);
					else this.setHintHovered?.(value);
					this.invalidate?.();
				};
				if (!this.expanded) return cardEvent(this, event, line, setHover);
				const result = original?.call(this, event);
				return result ?? cardEvent(this, event, line, setHover);
			});
		};
		expandable("ThinkingPreviewBlock", ThinkingPreviewBlock.prototype);
		expandable("AssistantMessageComponent", AssistantMessageComponent.prototype, isCompactAssistantComponent);
		// ccstyle 的 updateDisplay 接管这三个摘要后不再构建原生 MouseRegion（on/compact），
		// 必须由这里的 hint 命中逻辑负责展开；off 模式 handleMouse 早退给原生 Box 分发，
		// 原生 MouseRegion 仍负责整行点击切换，OSC8 链接与拖拽选择都不受影响。
		expandable("SkillInvocationMessageComponent", SkillInvocationMessageComponent.prototype);
		expandable("CompactionSummaryMessageComponent", CompactionSummaryMessageComponent.prototype);
		expandable("BranchSummaryMessageComponent", BranchSummaryMessageComponent.prototype);
		track("ToolGroupComponent", ToolGroupComponent.prototype);
		patch("ToolGroupComponent", ToolGroupComponent.prototype, "handleMouse", () => function (this: any, event: TuiMouseEvent) {
			if (!isStyleActive()) return undefined;
			const line = frames.get(this)?.[event.y] ?? "";
			const child = this.childAtRow(event.y, event.width);
			if (this.expanded && child && (event.clickCount ?? 0) < 2) {
				const result = child.component.handleMouse?.({ ...event, x: event.x - 1, y: child.row, width: Math.max(1, event.width - 2) });
				if (result) return result;
			}
			return cardEvent(this, event, line, (value) => { this.setHintHovered(value); this.invalidate(); });
		});
		patch("TuiAltScreen", TuiAltScreen.prototype, "dispatchMouseToLayout", (original) => function (this: any, event: TuiMouseEvent) {
			hoverVisited = false;
			const result = original.call(this, event);
			if (event.type === "move" && !hoverVisited && hovered) { clearHover(); this.requestRender(); }
			return result;
		});
	} catch (error) {
		installation.dispose();
		throw error;
	}
	setToolTuiFullscreen(getToolMouseTui()?.mode === "fullscreen");
	return () => installation.dispose();
}
