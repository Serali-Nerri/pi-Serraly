import {
	UserMessageComponent,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	TuiAltScreen,
	compositeTuiLine,
	sliceByColumn,
	stripTerminalSequences,
	visibleWidth,
	type Component,
	type ScrollView,
	type TUI,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";

export interface StickyOptions {
	getTui: () => TUI | undefined;
	getTheme: () => Theme;
	enabled: () => boolean;
}

export interface StickyHandle {
	refresh(): void;
	dispose(): void;
}

interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

// Pi layout internals are imported as private shapes here. The methods below are
// the only host hooks this presentation depends on.
interface LayoutBox {
	component: Component;
	rect: Rect;
	clip: Rect;
	children: LayoutBox[];
	lines?: readonly string[];
	lineOffset?: number;
	scrollView?: ScrollView;
	scrollContentLines?: readonly string[];
}

interface LayoutFrame {
	root: LayoutBox;
	width: number;
	height: number;
	primaryScrollView?: ScrollView;
}

interface NativeContainerLayout {
	width: number;
	children: Array<{ component: Component; height: number }>;
}

interface ContainerChildLines {
	width: number;
	children: readonly Component[];
	parts: readonly (readonly string[])[];
}

interface PrivateTui {
	mode: string;
	terminal: { columns: number; rows: number };
	currentLayout?: LayoutFrame;
	implicitDocument?: Component;
	mouseLayout?: NativeContainerLayout;
	scrollToEndIndicatorRect?: { row: number };
	mouseCapture?: { component: Component };
	mousePressTarget?: { component: Component };
	lastComponentClick?: { component: Component } | undefined;
	getPrimaryScrollView(): ScrollView | undefined;
	clearComponentMouseGesture(): void;
}

interface Hit {
	tui: TuiAltScreen;
	layout: LayoutFrame;
	scrollView: ScrollView;
	top: number;
	row: number;
	x: number;
	right: number;
	sourceRow: number;
	text: string;
}

interface Instruction {
	text: string;
	sourceRow: number;
	bodyRow: number;
}

interface InstructionCache {
	tui: TuiAltScreen;
	scrollView: ScrollView;
	component: Component;
	width: number;
	top: number;
	scrollTop: number;
	contentHeight: number;
	childCount: number;
	instruction: Instruction | undefined;
}

type MethodDescriptor = PropertyDescriptor & {
	value: (...args: never[]) => unknown;
};

const METHOD_SIGNATURES = [
	["compositeScrollToEndIndicator", 3],
	["dispatchMouseToLayout", 1],
	["clearComponentMouseGesture", 0],
	["getPrimaryScrollView", 0],
] as const;

let activeInstallation: StickyHandle | undefined;

function requireMethods(proto: object): Map<string, MethodDescriptor> {
	const descriptors = new Map<string, MethodDescriptor>();
	for (const [name, arity] of METHOD_SIGNATURES) {
		const descriptor = Object.getOwnPropertyDescriptor(proto, name);
		if (
			!descriptor ||
			typeof descriptor.value !== "function" ||
			!descriptor.writable
		) {
			throw new Error(
				`Sticky user message requires a writable TuiAltScreen.${name} method`,
			);
		}
		if (descriptor.value.length !== arity) {
			throw new Error(
				`Sticky user message is incompatible with TuiAltScreen.${name}: expected ${arity} arguments, received ${descriptor.value.length}`,
			);
		}
		descriptors.set(name, descriptor as MethodDescriptor);
	}
	return descriptors;
}

function scrollViewBox(
	box: LayoutBox,
	scrollView: ScrollView,
): LayoutBox | undefined {
	if (box.scrollView === scrollView) return box;
	for (const child of box.children) {
		const found = scrollViewBox(child, scrollView);
		if (found) return found;
	}
	return undefined;
}

/**
 * Finds the newest user body line above the viewport. Transcript Containers are opaque
 * layout leaves, so their cached child line partitions supply provenance without a
 * second render or a scan over stored messages.
 */
function instructionAbove(
	box: LayoutBox,
	scrollView: ScrollView,
	top: number,
	tui: TuiAltScreen,
): Instruction | undefined {
	let selected: Instruction | undefined;
	let blocked = false;
	const privateTui = tui as unknown as PrivateTui;
	function visitBox(child: LayoutBox) {
		if (blocked || child.scrollView) return;
		const sourceRow = child.rect.y - box.rect.y + scrollView.scrollTop;
		if (
			sourceRow >= top ||
			(selected && sourceRow + child.rect.height <= selected.sourceRow)
		)
			return;
		if (child.children.length > 0) {
			for (
				let index = child.children.length - 1;
				index >= 0 && !blocked;
				index--
			) {
				visitBox(child.children[index]!);
			}
			return;
		}
		const lines = child.lines ?? [];
		const offset = child.lineOffset ?? 0;
		const limit = Math.min(lines.length, offset + child.rect.height);
		function visitComponent(component: Component, start: number, end: number) {
			if (blocked) return;
			const row = sourceRow + start - offset;
			if (
				row >= top ||
				end <= offset ||
				start >= limit ||
				(selected && sourceRow + end - offset <= selected.sourceRow)
			)
				return;
			if (component instanceof UserMessageComponent) {
				let first: Instruction | undefined;
				for (let index = Math.max(start, offset); index < end; index++) {
					const text = stripTerminalSequences(lines[index] ?? "").trim();
					if (!text) continue;
					first = { text, sourceRow: row, bodyRow: sourceRow + index - offset };
					break;
				}
				if (!first) return;
				if (first.bodyRow >= top) {
					blocked = true;
					return;
				}
				if (!selected || first.bodyRow > selected.bodyRow) selected = first;
				blocked = true;
				return;
			}
			const container =
				component === privateTui.implicitDocument ? tui : component;
			if (
				!(container instanceof Container) ||
				(container !== tui && container.render !== Container.prototype.render)
			)
				return;
			const childLines = (
				container as unknown as { childLines?: ContainerChildLines }
			).childLines;
			if (childLines?.width === child.rect.width) {
				let childEnd = end;
				for (
					let index = childLines.children.length - 1;
					index >= 0 && !blocked;
					index--
				) {
					if (selected && sourceRow + childEnd - offset <= selected.sourceRow)
						break;
					const componentLines = childLines.parts[index];
					const component = childLines.children[index];
					if (!componentLines || !component) continue;
					const childStart = childEnd - componentLines.length;
					visitComponent(component, childStart, childEnd);
					childEnd = childStart;
				}
				return;
			}
			const native = (
				container as unknown as { mouseLayout?: NativeContainerLayout }
			).mouseLayout;
			if (native?.width !== child.rect.width) return;
			let childEnd = end;
			for (
				let index = native.children.length - 1;
				index >= 0 && !blocked;
				index--
			) {
				if (selected && sourceRow + childEnd - offset <= selected.sourceRow)
					break;
				const entry = native.children[index]!;
				const childStart = childEnd - entry.height;
				visitComponent(entry.component, childStart, childEnd);
				childEnd = childStart;
			}
		}
		visitComponent(child.component, 0, lines.length);
	}
	for (let index = box.children.length - 1; index >= 0 && !blocked; index--)
		visitBox(box.children[index]!);
	return selected;
}

function cacheKey(
	box: LayoutBox,
	scrollView: ScrollView,
	top: number,
	tui: TuiAltScreen,
): Omit<InstructionCache, "instruction"> | undefined {
	const content = box.children[0];
	if (!content) return undefined;
	const native =
		content.component instanceof Container
			? (
					content.component as unknown as {
						mouseLayout?: NativeContainerLayout;
					}
				).mouseLayout
			: undefined;
	return {
		tui,
		scrollView,
		component: content.component,
		width: content.rect.width,
		top,
		scrollTop: scrollView.scrollTop,
		contentHeight: content.rect.height,
		childCount: native?.children.length ?? 0,
	};
}

function sameCache(
	cache: InstructionCache,
	key: Omit<InstructionCache, "instruction">,
): boolean {
	return (
		cache.tui === key.tui &&
		cache.scrollView === key.scrollView &&
		cache.component === key.component &&
		cache.width === key.width &&
		cache.top === key.top &&
		cache.scrollTop === key.scrollTop &&
		cache.contentHeight === key.contentHeight &&
		cache.childCount === key.childCount
	);
}

function cachedLineStillMatches(
	cache: InstructionCache,
	box: LayoutBox,
): boolean {
	if (!cache.instruction) return true;
	const line = box.scrollContentLines?.[cache.instruction.bodyRow];
	return (
		line !== undefined &&
		stripTerminalSequences(line).trim() === cache.instruction.text
	);
}

export function installSticky(options: StickyOptions): StickyHandle {
	if (activeInstallation)
		throw new Error("Sticky user message is already installed");
	const proto = TuiAltScreen.prototype;
	const descriptors = requireMethods(proto);
	const compositeDescriptor = descriptors.get("compositeScrollToEndIndicator")!;
	const dispatchDescriptor = descriptors.get("dispatchMouseToLayout")!;
	const originalComposite = compositeDescriptor.value as unknown as (
		this: TuiAltScreen,
		screen: string[],
		layout: LayoutFrame,
		width: number,
	) => string[];
	const originalDispatch = dispatchDescriptor.value as unknown as (
		this: TuiAltScreen,
		event: TuiMouseEvent,
	) => unknown;

	let active = true;
	let frame: Hit | undefined;
	let gesture: Hit | undefined;
	let instructionCache: InstructionCache | undefined;

	function isCurrentRenderer(tui: TuiAltScreen): boolean {
		const forwarded = options.getTui();
		if (!forwarded) return false;
		if ((forwarded as unknown) === tui) return true;
		const current = forwarded as unknown as PrivateTui;
		const renderer = tui as unknown as PrivateTui;
		if (
			typeof current.getPrimaryScrollView !== "function" ||
			typeof renderer.getPrimaryScrollView !== "function"
		) {
			return false;
		}
		return (
			current.mode === "fullscreen" &&
			current.currentLayout === renderer.currentLayout &&
			current.getPrimaryScrollView() === renderer.getPrimaryScrollView()
		);
	}

	function sameTarget(previous: Hit | undefined, current: Hit): boolean {
		return (
			!!previous &&
			previous.tui === current.tui &&
			previous.scrollView === current.scrollView &&
			previous.layout.root.component === current.layout.root.component &&
			previous.layout.width === current.layout.width &&
			previous.layout.height === current.layout.height &&
			previous.top === current.top &&
			previous.row === current.row &&
			previous.x === current.x &&
			previous.right === current.right &&
			previous.sourceRow === current.sourceRow &&
			previous.text === current.text
		);
	}

	function valid(hit: Hit | undefined, event: TuiMouseEvent): hit is Hit {
		const privateTui = hit?.tui as unknown as PrivateTui | undefined;
		return (
			!!hit &&
			active &&
			frame === hit &&
			isCurrentRenderer(hit.tui) &&
			privateTui?.currentLayout === hit.layout &&
			options.enabled() &&
			hit.scrollView.scrollTop === hit.top &&
			hit.layout.width === privateTui.terminal.columns &&
			hit.layout.height === privateTui.terminal.rows &&
			!event.shift &&
			!event.alt &&
			!event.ctrl &&
			event.screenY === hit.row &&
			event.screenX >= hit.x &&
			event.screenX < hit.right
		);
	}

	const target: Component = {
		render: () => [],
		invalidate() {},
		handleMouse(event) {
			if (event.type === "press") gesture = frame;
			const hit = event.type === "move" ? frame : gesture;
			if (
				!valid(hit, event) ||
				(event.button !== "left" && event.type !== "move")
			)
				return undefined;
			if (event.type === "click") {
				hit.scrollView.scrollTo(hit.sourceRow, { disableFollow: true });
				return { handled: true, render: true };
			}
			return { handled: true };
		},
	};

	const owner: StickyHandle = {
		refresh() {
			const tui = gesture?.tui ?? frame?.tui;
			if (tui) {
				const privateTui = tui as unknown as PrivateTui;
				const capture = privateTui.mouseCapture?.component;
				const press = privateTui.mousePressTarget?.component;
				if (
					(capture === target || press === target) &&
					(!capture || capture === target) &&
					(!press || press === target)
				) {
					privateTui.clearComponentMouseGesture();
				}
				if (privateTui.lastComponentClick?.component === target)
					privateTui.lastComponentClick = undefined;
			}
			frame = undefined;
			gesture = undefined;
			instructionCache = undefined;
		},
		dispose() {
			if (!active) return;
			owner.refresh();
			active = false;
			if (
				Object.getOwnPropertyDescriptor(proto, "dispatchMouseToLayout")
					?.value === dispatchWrapper
			) {
				Object.defineProperty(
					proto,
					"dispatchMouseToLayout",
					dispatchDescriptor,
				);
			}
			if (
				Object.getOwnPropertyDescriptor(proto, "compositeScrollToEndIndicator")
					?.value === compositeWrapper
			) {
				Object.defineProperty(
					proto,
					"compositeScrollToEndIndicator",
					compositeDescriptor,
				);
			}
			if (activeInstallation === owner) activeInstallation = undefined;
		},
	};

	const compositeWrapper = function (
		this: TuiAltScreen,
		screen: string[],
		layout: LayoutFrame,
		width: number,
	): string[] {
		const result = originalComposite.call(this, screen, layout, width);
		if (!active || !isCurrentRenderer(this)) return result;
		const pressed = gesture;
		gesture = undefined;
		frame = undefined;
		if (!options.enabled()) {
			instructionCache = undefined;
			return result;
		}
		const scrollView = layout.primaryScrollView;
		if (!scrollView) return result;
		const box = scrollViewBox(layout.root, scrollView);
		if (!box?.scrollContentLines || box.clip.height < 1) return result;
		const row = Math.max(0, box.clip.y);
		if ((this as unknown as PrivateTui).scrollToEndIndicatorRect?.row === row)
			return result;
		const top = scrollView.scrollTop + row - box.rect.y;
		const key = cacheKey(box, scrollView, top, this);
		let instruction: Instruction | undefined;
		let cacheHit = false;
		if (key && instructionCache && sameCache(instructionCache, key)) {
			cacheHit = true;
			if (cachedLineStillMatches(instructionCache, box))
				instruction = instructionCache.instruction;
			else cacheHit = false;
		}
		if (!cacheHit) instruction = instructionAbove(box, scrollView, top, this);
		if (key) instructionCache = { ...key, instruction };
		if (!instruction) return result;
		const x = Math.max(0, box.clip.x);
		let right = Math.min(width, box.clip.x + box.clip.width);
		const contentHeight =
			box.children[0]?.rect.height ?? box.scrollContentLines.length;
		const hasScrollbar =
			scrollView.isScrollbarVisible ||
			(scrollView.scrollbar === "auto" && contentHeight > box.rect.height);
		const scrollbarColumn = box.rect.x + box.rect.width - 1;
		if (hasScrollbar && scrollbarColumn >= x && scrollbarColumn < right)
			right = scrollbarColumn;
		const available = right - x;
		if (available < 1 || row >= result.length) return result;
		const padding = available > 1 ? 1 : 0;
		const body = sliceByColumn(instruction.text, 0, available - padding, true);
		const line = " ".repeat(padding) + body;
		const theme = options.getTheme();
		const styled = theme.bg(
			"userMessageBg",
			theme.fg(
				"userMessageText",
				line + " ".repeat(Math.max(0, available - visibleWidth(line))),
			),
		);
		const painted = result.slice();
		painted[row] = compositeTuiLine(
			result[row] ?? "",
			styled,
			x,
			available,
			width,
		);
		frame = {
			tui: this,
			layout,
			scrollView,
			top: scrollView.scrollTop,
			row,
			x: x + padding,
			right: x + padding + visibleWidth(body),
			sourceRow: instruction.sourceRow,
			text: instruction.text,
		};
		if (sameTarget(pressed, frame)) gesture = frame;
		return painted;
	};

	const dispatchWrapper = function (
		this: TuiAltScreen,
		event: TuiMouseEvent,
	): unknown {
		const hit = frame;
		if (
			this !== hit?.tui ||
			!valid(hit, event) ||
			!["press", "click", "move"].includes(event.type)
		) {
			return originalDispatch.call(this, event);
		}
		const result = target.handleMouse?.(event);
		if (!result) return originalDispatch.call(this, event);
		return {
			...result,
			handled: true,
			target: {
				component: target,
				originX: hit.x,
				originY: hit.row,
				width: hit.right - hit.x,
				height: 1,
			},
		};
	};

	try {
		Object.defineProperty(proto, "compositeScrollToEndIndicator", {
			...compositeDescriptor,
			value: compositeWrapper,
		});
		Object.defineProperty(proto, "dispatchMouseToLayout", {
			...dispatchDescriptor,
			value: dispatchWrapper,
		});
		activeInstallation = owner;
		return owner;
	} catch (error) {
		owner.dispose();
		throw error;
	}
}
