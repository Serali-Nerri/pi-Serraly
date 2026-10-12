import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen, compositeTuiLine, sliceByColumn, stripTerminalSequences, visibleWidth, type Component, type ScrollView, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { LayoutBox, LayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { config } from "../config/config.ts";
import { getToolMouseTui } from "../overlays/mouse-state.ts";
import { requireReplaceableMethod } from "./host-capabilities.ts";
import { installMethodStep } from "./method-pipeline.ts";
import { clearToolMouseHover } from "./mouse/interaction.ts";
import { patchRegistry, STICKY_USER_MESSAGE_OWNER } from "./patch-keys.ts";

// Pi already marks user-message zones for prompt navigation. Consume those native
// zones from the layout's unpainted transcript; never decorate saved components.
const PROMPT_START = /^\x1b\]133;A(?:\x07|\x1b\\)/;
const PROMPT_END = /^\x1b\]133;[BC](?:\x07|\x1b\\)/;

function scrollViewBox(box: LayoutBox, scrollView: ScrollView): LayoutBox | undefined {
	if (box.scrollView === scrollView) return box;
	for (const child of box.children) {
		const found = scrollViewBox(child, scrollView);
		if (found) return found;
	}
	return undefined;
}

function instructionAbove(lines: readonly string[], top: number): { text: string; sourceRow: number } | undefined {
	let inPrompt = false;
	let sourceRow = 0;
	let selected: { text: string; sourceRow: number } | undefined;
	for (let row = 0; row < lines.length && row < top; row++) {
		const line = lines[row]!;
		if (PROMPT_START.test(line)) { inPrompt = true; sourceRow = row; }
		else if (PROMPT_END.test(line)) inPrompt = false;
		if (!inPrompt) continue;
		const text = stripTerminalSequences(line).trim();
		if (!text) continue;
		selected = { text, sourceRow };
		inPrompt = false;
	}
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
	function sameTarget(previous: Hit | undefined, current: Hit): boolean {
		return !!previous && previous.tui === current.tui && previous.scrollView === current.scrollView &&
			previous.layout.root.component === current.layout.root.component &&
			previous.layout.width === current.layout.width && previous.layout.height === current.layout.height &&
			previous.top === current.top && previous.row === current.row && previous.x === current.x &&
			previous.right === current.right && previous.sourceRow === current.sourceRow && previous.text === current.text;
	}
	function valid(hit: Hit | undefined, event: TuiMouseEvent): hit is Hit {
		return !!hit && active && patchRegistry.owns(ownerKey, owner) && frame === hit &&
			hit.tui === getToolMouseTui() && hit.tui.currentLayout === hit.layout &&
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
			if (!active || !patchRegistry.owns(ownerKey, owner) || this !== getToolMouseTui()) return result;
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
			const instruction = instructionAbove(box.scrollContentLines, top);
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
