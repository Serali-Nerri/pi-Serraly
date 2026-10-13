// Adapted from pi-cc-extensions v0.8.69; see THIRD_PARTY_NOTICES.md.
import { type ExtensionCommandContext, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, visibleWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { mouseBaseButton, parseSgrMousePacket } from "../utils/sgr-mouse.ts";
import { padLine } from "../utils/format.ts";

function normalizePreviewText(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, "  ")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

type DialogBounds = { left: number; top: number; width: number };

/** 1-based terminal hitbox of the [esc] close button on the dialog title row (row 2 of the box). */
export function escCloseHitbox(bounds: DialogBounds): {
	row: number;
	startCol: number;
	endCol: number;
} {
	return {
		row: bounds.top + 2,
		startCol: bounds.left + bounds.width - 5,
		endCol: bounds.left + bounds.width - 1,
	};
}

let activeTextPreviews = 0;

/** fullscreen 输入包装用于把鼠标事件继续传给当前文本预览 overlay。 */
export function hasActiveTextPreview(): boolean {
	return activeTextPreviews > 0;
}

export async function showTextPreview(
	ctx: Pick<ExtensionCommandContext, "ui">,
	title: string,
	rawContent: string | Component,
): Promise<void> {
	const content = typeof rawContent === "string" ? normalizePreviewText(rawContent) : "";
	activeTextPreviews++;
	try {
		await ctx.ui.custom(
			(tui, theme, _keybindings, done) => {
				let scrollOffset = 0;
				let pageSize = 1;
				let totalLines = 1;
				let escHovered = false;
				let overlayTop = 0;
				let overlayLeft = 0;
				let escHitbox: { row: number; startCol: number; endCol: number } | undefined;
				let scrollbarHitbox:
					| {
							col: number;
							startRow: number;
							endRow: number;
							thumbStart: number;
							thumbSize: number;
							maxOffset: number;
					  }
					| undefined;
				let scrollbarDragOffset: number | null = null;
				let renderedGeometry: readonly number[] = [];
				const markdownView = typeof rawContent === "string" ? new Markdown(content, 0, 0, getMarkdownTheme()) : rawContent;

				const scrollTo = (nextOffset: number): void => {
					const next = Math.max(0, Math.min(nextOffset, Math.max(0, totalLines - pageSize)));
					if (next === scrollOffset) return;
					scrollOffset = next;
					tui.requestRender();
				};

				const setEscHovered = (hovered: boolean): void => {
					if (hovered === escHovered) return;
					escHovered = hovered;
					tui.requestRender();
				};

				const dragScrollbarTo = (mouseRow: number): void => {
					if (!scrollbarHitbox || scrollbarDragOffset === null) return;
					const trackSize = scrollbarHitbox.endRow - scrollbarHitbox.startRow + 1;
					const maxThumbStart = Math.max(0, trackSize - scrollbarHitbox.thumbSize);
					const thumbStart = Math.max(
						0,
						Math.min(mouseRow - scrollbarHitbox.startRow - scrollbarDragOffset, maxThumbStart),
					);
					const nextOffset =
						maxThumbStart > 0
							? Math.round((thumbStart / maxThumbStart) * scrollbarHitbox.maxOffset)
							: 0;
					scrollTo(nextOffset);
				};

				const handleMouse = (event: Pick<TuiMouseEvent, "type" | "button" | "x" | "y" | "wheelDelta">): TuiMouseEventResult => {
					if (event.type === "release") {
						const handled = scrollbarDragOffset !== null;
						scrollbarDragOffset = null;
						return { handled, render: false };
					}
					const overEsc = Boolean(
						escHitbox && event.y === escHitbox.row &&
						event.x >= escHitbox.startCol && event.x <= escHitbox.endCol,
					);
					setEscHovered(overEsc);
					if (event.type === "wheel") {
						scrollTo(scrollOffset + (event.wheelDelta ?? 0));
						return { handled: true, render: false };
					}
					if (event.type === "press" && event.button === "left") {
						if (overEsc) {
							done(undefined);
							return { handled: true, render: false };
						}
						if (
							scrollbarHitbox && event.x === scrollbarHitbox.col &&
							event.y >= scrollbarHitbox.startRow && event.y <= scrollbarHitbox.endRow
						) {
							const trackRow = event.y - scrollbarHitbox.startRow;
							const inThumb = trackRow >= scrollbarHitbox.thumbStart &&
								trackRow < scrollbarHitbox.thumbStart + scrollbarHitbox.thumbSize;
							scrollbarDragOffset = inThumb
								? trackRow - scrollbarHitbox.thumbStart
								: Math.floor(scrollbarHitbox.thumbSize / 2);
							dragScrollbarTo(event.y);
							return { capture: true, render: false };
						}
					}
					if (event.type === "drag" && scrollbarDragOffset !== null) {
						dragScrollbarTo(event.y);
						return { handled: true, render: false };
					}
					return { handled: false, render: false };
				};

				return {
					handleMouse,
					invalidate() {
						markdownView.invalidate();
					},
					handleInput(data: string) {
						if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
							done(undefined);
							return;
						}
						if (matchesKey(data, Key.up)) scrollTo(scrollOffset - 1);
						else if (matchesKey(data, Key.down)) scrollTo(scrollOffset + 1);
						else if (matchesKey(data, "pageUp")) scrollTo(scrollOffset - pageSize);
						else if (matchesKey(data, "pageDown")) scrollTo(scrollOffset + pageSize);
						else if (matchesKey(data, Key.home)) scrollTo(0);
						else if (matchesKey(data, Key.end)) scrollTo(totalLines - pageSize);
						else {
							const mouse = parseSgrMousePacket(data);
							if (!mouse) return;
							const button = mouseBaseButton(mouse.code);
							const motion = (mouse.code & 32) !== 0;
							// Regular-mode input still arrives as raw, 1-based terminal SGR.
							handleMouse({
								type: mouse.final === "m" ? "release" : button === 64 || button === 65 ? "wheel"
									: motion ? button === 0 ? "drag" : "move" : "press",
								button: button === 0 ? "left" : "none",
								x: mouse.col - overlayLeft - 1,
								y: mouse.row - overlayTop - 1,
								wheelDelta: button === 64 ? -3 : button === 65 ? 3 : 0,
							});
						}
					},

					render(width: number) {
						const inner = Math.max(1, width - 2);
						const escWidth = visibleWidth("[esc]");
						const bodyInner = Math.max(1, inner - 1);
						const bodyWidth = Math.max(1, bodyInner - 1);
						const terminalHeight = Math.max(1, tui.terminal.rows);
						const availableHeight = Math.max(1, terminalHeight - 4);
						const viewportHeight = Math.min(
							30,
							Math.max(1, Math.floor(terminalHeight * 0.8)),
							availableHeight,
						);
						pageSize = Math.max(1, viewportHeight - 6);
						const wrapped = markdownView.render(bodyWidth);
						totalLines = wrapped.length;
						scrollOffset = Math.min(scrollOffset, Math.max(0, totalLines - pageSize));
						// Centered overlay with margin 2: mirror TUI resolveOverlayLayout for anchor "center".
						overlayTop = 2 + Math.floor((availableHeight - viewportHeight) / 2);
						overlayLeft = Math.floor((Math.max(1, tui.terminal.columns) - width) / 2);
						// The helper is 1-based; component-local hitboxes are 0-based.
						const esc = escCloseHitbox({ left: 0, top: 0, width });
						escHitbox = { row: esc.row - 1, startCol: esc.startCol - 1, endCol: esc.endCol - 1 };
						const visible = wrapped.slice(scrollOffset, scrollOffset + pageSize);
						const border = (text: string) => theme.fg("border", text);
						const scrollable = totalLines > pageSize;
						const thumbSize = scrollable
							? Math.max(1, Math.floor((pageSize * pageSize) / totalLines))
							: 0;
						const maxScrollOffset = Math.max(0, totalLines - pageSize);
						const geometry = [terminalHeight, tui.terminal.columns, width, pageSize, thumbSize, maxScrollOffset];
						// Pi retains the press-time capture origin through resize. Cancel
						// dragging when geometry changes, not when the thumb merely moves.
						if (geometry.some((value, index) => value !== renderedGeometry[index])) scrollbarDragOffset = null;
						renderedGeometry = geometry;
						const thumbStart =
							scrollable && maxScrollOffset > 0
								? Math.round((scrollOffset / maxScrollOffset) * (pageSize - thumbSize))
								: 0;
						scrollbarHitbox = scrollable
							? {
									col: width - 2,
									startRow: 3,
									endRow: 2 + pageSize,
									thumbStart,
									thumbSize,
									maxOffset: maxScrollOffset,
								}
							: undefined;
						const scrollbar = (row: number): string => {
							if (!scrollable) return " ";
							const inThumb = row >= thumbStart && row < thumbStart + thumbSize;
							return theme.fg(inThumb ? "accent" : "borderMuted", inThumb ? "█" : "│");
						};
						const bodyRows = Array.from({ length: pageSize }, (_, row) => {
							const line = visible[row] ?? "";
							return `${border("│")}${padLine(` ${line}`, bodyInner)}${scrollbar(row)}${border("│")}`;
						});
						const start = totalLines === 0 ? 0 : scrollOffset + 1;
						const end = Math.min(totalLines, scrollOffset + pageSize);
						const status = `${start}-${end} / ${totalLines} lines · ↑↓ PgUp/PgDn Home/End · [esc] close`;

						return [
							border(`╭${"─".repeat(inner)}╮`),
							`${border("│")}${padLine(` ${theme.bold(theme.fg("accent", title))}`, inner - escWidth)}${theme.fg(escHovered ? "text" : "muted", "[esc]")}${border("│")}`,
							`${border("├")}${border("─".repeat(inner))}${border("┤")}`,
							...bodyRows,
							`${border("├")}${border("─".repeat(inner))}${border("┤")}`,
							`${border("│")}${padLine(theme.fg("dim", ` ${status}`), inner)}${border("│")}`,
							border(`╰${"─".repeat(inner)}╯`),
						];
					},
				};
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "85%",
					minWidth: 50,
					maxHeight: "80%",
					margin: 2,
				},
			},
		);
	} finally {
		activeTextPreviews--;
	}
}
