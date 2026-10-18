import { UserMessageComponent, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, TuiAltScreen, compositeTuiLine, sliceByColumn, stripTerminalSequences, visibleWidth, type Component, type ScrollView, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { LayoutBox, LayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { config } from "../config/config.ts";
import { getToolMouseTui } from "../overlays/mouse-state.ts";
import { requireReplaceableMethod } from "./host-capabilities.ts";
import { installMethodStep } from "./method-pipeline.ts";
import { clearToolMouseHover } from "./mouse/interaction.ts";
import { patchRegistry, STICKY_USER_MESSAGE_OWNER } from "./patch-keys.ts";

// Pinned native Container.render cache: ordinary transcript Containers are opaque
// LayoutBox leaves. Their captured child heights preserve message provenance without
// re-rendering components or decorating saved/rendered text with extra markers.
type NativeContainerLayout = { width: number; children: Array<{ component: Component; height: number }> };

function scrollViewBox(box: LayoutBox, scrollView: ScrollView): LayoutBox | undefined {
	if (box.scrollView === scrollView) return box;
	for (const child of box.children) {
		const found = scrollViewBox(child, scrollView);
		if (found) return found;
	}
	return undefined;
}

function instructionAbove(box: LayoutBox, scrollView: ScrollView, top: number, tui: TuiAltScreen): { text: string; sourceRow: number } | undefined {
	let selected: { text: string; sourceRow: number } | undefined;
	const nativeTui = tui as unknown as { implicitDocument: Component; mouseLayout?: NativeContainerLayout };
	function visitBox(child: LayoutBox) {
		if (child.scrollView) return; // Nested scroll content has its own row coordinates.
		const sourceRow = child.rect.y - box.rect.y + scrollView.scrollTop;
		if (sourceRow >= top || (selected && sourceRow + child.rect.height <= selected.sourceRow)) return;
		if (child.children.length) {
			for (let index = child.children.length - 1; index >= 0; index--) visitBox(child.children[index]!);
			return;
		}
		const lines = child.lines ?? [];
		const offset = child.lineOffset ?? 0;
		const limit = Math.min(lines.length, offset + child.rect.height);
		// Native Containers concatenate child lines. Walk their captured heights
		// backwards into this same array, stopping once an earlier sibling cannot
		// replace the nearest instruction. Neither output nor child arrays are copied.
		function visitComponent(component: Component, start: number, end: number) {
			const row = sourceRow + start - offset;
			if (row >= top || end <= offset || start >= limit ||
				(selected && sourceRow + end - offset <= selected.sourceRow)) return;
			// Assistant messages emit the same OSC133 zones. Only native user
			// components supply instructions, including the spacer's jump row.
			if (component instanceof UserMessageComponent) {
				for (let index = Math.max(start, offset); index < Math.min(end, limit) && sourceRow + index - offset < top; index++) {
					const text = stripTerminalSequences(lines[index]!).trim();
					if (!text) continue;
					if (!selected || row > selected.sourceRow) selected = { text, sourceRow: row };
					break;
				}
				return;
			}
			const container = component === nativeTui.implicitDocument ? tui : component;
			if (!(container instanceof Container) || (container !== tui && container.render !== Container.prototype.render)) return;
			const native = (container as unknown as { mouseLayout?: NativeContainerLayout }).mouseLayout;
			if (native?.width !== child.rect.width) return;
			let childEnd = end;
			for (let index = native.children.length - 1; index >= 0; index--) {
				if (selected && sourceRow + childEnd - offset <= selected.sourceRow) break;
				const entry = native.children[index]!;
				const childStart = childEnd - entry.height;
				visitComponent(entry.component, childStart, childEnd);
				childEnd = childStart;
			}
		}
		visitComponent(child.component, 0, lines.length);
	}
	for (let index = box.children.length - 1; index >= 0; index--) visitBox(box.children[index]!);
	return selected;
}

export function installStickyUserMessage(ctx: ExtensionContext) {
	const ownerKey = STICKY_USER_MESSAGE_OWNER;
	patchRegistry.getOwned(ownerKey, (value): value is { dispose(): void } =>
		typeof value === "object" && value !== null && typeof (value as { dispose?: unknown }).dispose === "function")?.dispose();
	const proto = TuiAltScreen.prototype;
	requireReplaceableMethod("TuiAltScreen", proto, "compositeScrollToEndIndicator");
	requireReplaceableMethod("TuiAltScreen", proto, "dispatchMouseToLayout");
	requireReplaceableMethod("TuiAltScreen", proto, "clearComponentMouseGesture");
	const steps: Array<{ dispose(): void }> = [];
	let active = true;
	type Hit = { tui: any; layout: LayoutFrame; scrollView: ScrollView; top: number; row: number; x: number; right: number; sourceRow: number; text: string };
	let frame: Hit | undefined;
	let gesture: Hit | undefined;
	function isCurrentRenderer(tui: any): boolean {
		const current = getToolMouseTui();
		// Component factories receive a stable forwarding reference, not this
		// renderer. Layout identity also separates renderers sharing a ScrollView.
		return current?.mode === "fullscreen" && current.currentLayout === tui.currentLayout &&
			current.getPrimaryScrollView?.() === tui.getPrimaryScrollView();
	}
	function sameTarget(previous: Hit | undefined, current: Hit): boolean {
		return !!previous && previous.tui === current.tui && previous.scrollView === current.scrollView &&
			previous.layout.root.component === current.layout.root.component &&
			previous.layout.width === current.layout.width && previous.layout.height === current.layout.height &&
			previous.top === current.top && previous.row === current.row && previous.x === current.x &&
			previous.right === current.right && previous.sourceRow === current.sourceRow && previous.text === current.text;
	}
	function valid(hit: Hit | undefined, event: TuiMouseEvent): hit is Hit {
		return !!hit && active && patchRegistry.owns(ownerKey, owner) && frame === hit &&
			isCurrentRenderer(hit.tui) && hit.tui.currentLayout === hit.layout &&
			config.mode !== "off" && config.stickyUserMessage && hit.scrollView.scrollTop === hit.top &&
			hit.layout.width === hit.tui.terminal.columns && hit.layout.height === hit.tui.terminal.rows &&
			event.screenY === hit.row && event.screenX >= hit.x && event.screenX < hit.right;
	}
	const target: Component = {
		render: () => [],
		invalidate() {},
		handleMouse(event) {
			if (event.type === "press") gesture = frame;
			const hit = event.type === "move" ? frame : gesture;
			if (!valid(hit, event) || (event.button !== "left" && event.type !== "move")) return undefined;
			if (event.type === "click") {
				hit.scrollView.scrollTo(hit.sourceRow, { disableFollow: true });
				return { handled: true, render: true };
			}
			return { handled: true, render: event.type === "move" && clearToolMouseHover() };
		},
	};
	const owner = {
		refresh() {
			const tui = gesture?.tui ?? frame?.tui;
			if (tui) {
				const capture = tui.mouseCapture?.component;
				const press = tui.mousePressTarget?.component;
				if ((capture === target || press === target) && (!capture || capture === target) && (!press || press === target)) {
					tui.clearComponentMouseGesture();
				}
				if (tui.lastComponentClick?.component === target) tui.lastComponentClick = undefined;
			}
			frame = undefined;
			gesture = undefined;
		},
		dispose() {
			if (!active) return;
			owner.refresh();
			active = false;
			for (const step of steps.reverse()) step.dispose();
			patchRegistry.dispose(ownerKey, owner);
		},
	};
	try {
		patchRegistry.installOwned(ownerKey, owner);
		steps.push(installMethodStep(proto, "compositeScrollToEndIndicator", (next) => function (
			this: any, screen: string[], layout: LayoutFrame, width: number,
		) {
			const result = next.call(this, screen, layout, width) as string[];
			if (!active || !patchRegistry.owns(ownerKey, owner) || !isCurrentRenderer(this)) return result;
			const pressed = gesture;
			gesture = undefined;
			frame = undefined;
			if (config.mode === "off" || !config.stickyUserMessage) return result;
			const scrollView = layout.primaryScrollView;
			if (!scrollView) return result;
			const box = scrollViewBox(layout.root, scrollView);
			if (!box?.scrollContentLines || box.clip.height < 1) return result;
			const row = Math.max(0, box.clip.y);
			// Native jump-to-end input runs before component dispatch. If both
			// decorations share the only row, retain its visible native target.
			if (this.scrollToEndIndicatorRect?.row === row) return result;
			const top = scrollView.scrollTop + row - box.rect.y;
			const instruction = instructionAbove(box, scrollView, top, this);
			if (!instruction) return result;
			const x = Math.max(0, box.clip.x);
			let right = Math.min(width, box.clip.x + box.clip.width);
			const contentHeight = box.children[0]?.rect.height ?? box.scrollContentLines.length;
			const hasScrollbar = scrollView.isScrollbarVisible ||
				(scrollView.scrollbar === "auto" && contentHeight > box.rect.height);
			const scrollbarColumn = box.rect.x + box.rect.width - 1;
			if (hasScrollbar && scrollbarColumn >= x && scrollbarColumn < right) right = scrollbarColumn;
			const available = right - x;
			if (available < 1 || row >= result.length) return result;
			const padding = available > 1 ? 1 : 0;
			const body = sliceByColumn(instruction.text, 0, available - padding, true);
			const line = " ".repeat(padding) + body;
			const styled = ctx.ui.theme.bg("userMessageBg", ctx.ui.theme.fg("userMessageText", line + " ".repeat(Math.max(0, available - visibleWidth(line)))));
			const painted = result.slice();
			painted[row] = compositeTuiLine(result[row] ?? "", styled, x, available, width);
			frame = { tui: this, layout, scrollView, top: scrollView.scrollTop, row, x: x + padding,
				right: x + padding + visibleWidth(body), sourceRow: instruction.sourceRow, text: instruction.text };
			if (sameTarget(pressed, frame)) gesture = frame;
			return painted;
		}));
		steps.push(installMethodStep(proto, "dispatchMouseToLayout", (next) => function (this: any, event: TuiMouseEvent) {
			const hit = frame;
			if (this !== hit?.tui || !valid(hit, event) || !["press", "click", "move"].includes(event.type)) return next.call(this, event);
			const result = target.handleMouse?.(event);
			if (!result) return next.call(this, event);
			return { ...result, handled: true, target: { component: target, originX: hit.x, originY: hit.row, width: hit.right - hit.x, height: 1 } };
		}));
		return owner;
	} catch (error) {
		owner.dispose();
		throw error;
	}
}
