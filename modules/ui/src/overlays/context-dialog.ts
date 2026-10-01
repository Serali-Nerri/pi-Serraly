// Adapted from pi-cc-extensions v0.8.69; see THIRD_PARTY_NOTICES.md.
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { formatTokens, type ContextInspector, type ContextPreview, type PreviewKey } from "../state/context.ts";
import { contextSourceLabel } from "../state/context-snapshot.ts";
import { escCloseHitbox, mouseInput, normalizePreviewText, showTextPreview, withTextPreviewActivity } from "./text-preview.ts";
import { mouseBaseButton, parseSgrMousePacket } from "../utils/sgr-mouse.ts";
import { padLine } from "../utils/format.ts";

export async function showContextDialog(ctx: ExtensionCommandContext, inspector: ContextInspector): Promise<void> {
	const { snapshot, breakdown, parts: allParts } = inspector;
	const { tokens: used, contextWindow } = snapshot;
	const rawPreviews: ContextPreview[] = [
		{
			key: "systemPrompt",
			label: "System prompt",
			title: "System Prompt",
			content: breakdown.previews.systemPrompt,
		},
		{
			key: "memoryFiles",
			label: "Memory",
			title: "Memory Files",
			content: breakdown.previews.memoryFiles,
		},
		{
			key: "skills",
			label: "Skills",
			title: "Skills",
			content: breakdown.previews.skills,
		},
		{
			key: "tools",
			label: "Tools definition",
			title: "Tools definition",
			content: breakdown.previews.tools,
		},
		{
			key: "toolResults",
			label: "Tool results",
			title: "Tool Results",
			content: breakdown.previews.toolResults,
		},
		{
			key: "contextFiles",
			label: "Context",
			title: "Context",
			content: breakdown.previews.contextFiles,
		},
	];
	const previews = rawPreviews.map((preview) => ({
		...preview,
		content: normalizePreviewText(preview.content),
	}));
	const previewByKey = new Map(previews.map((preview) => [preview.key, preview]));
	const visiblePreviews = previews.filter((preview) =>
		allParts.some((part) => part.label === preview.label),
	);
	let selectedPreviewIndex = 0;

	while (true) {
		// Share overlay activity with the text preview and mouse input router.
		const action = await withTextPreviewActivity(() => ctx.ui.custom<PreviewKey | undefined>(
			(tui, theme, _keybindings, done) => {
				let previewHitboxes: Array<{
					key: PreviewKey;
					row: number;
					startCol: number;
					endCol: number;
				}> = [];
				let escHitbox: { row: number; startCol: number; endCol: number } | undefined;
				let escHovered = false;
				let hoveredKey: PreviewKey | undefined;

				return {
					handleMouse(this: { handleInput(data: string): void }, event: TuiMouseEvent) {
						const data = mouseInput(event);
						if (data) this.handleInput(data);
						return { handled: true, render: event.type !== "move" };
					},
					invalidate() {},
					handleInput(data: string) {
						if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
							done(undefined);
							return;
						}
						if (matchesKey(data, Key.up) && visiblePreviews.length > 0) {
							selectedPreviewIndex =
								(selectedPreviewIndex - 1 + visiblePreviews.length) % visiblePreviews.length;
							tui.requestRender();
							return;
						}
						if (matchesKey(data, Key.down) && visiblePreviews.length > 0) {
							selectedPreviewIndex = (selectedPreviewIndex + 1) % visiblePreviews.length;
							tui.requestRender();
							return;
						}
						if (matchesKey(data, Key.enter)) {
							done(visiblePreviews[selectedPreviewIndex]?.key);
							return;
						}

						const mouse = parseSgrMousePacket(data);
						if (!mouse || mouse.final !== "M") return;
						if ((mouse.code & 32) !== 0) {
							// SGR 1003 的无按键 hover code 为 35，不能按左键事件过滤。
							const overEsc = Boolean(
								escHitbox &&
									mouse.row === escHitbox.row &&
									mouse.col >= escHitbox.startCol &&
									mouse.col <= escHitbox.endCol,
							);
							const hovered = previewHitboxes.find(
								(candidate) =>
									mouse.row === candidate.row &&
									mouse.col >= candidate.startCol &&
									mouse.col <= candidate.endCol,
							);
							if (overEsc !== escHovered || hovered?.key !== hoveredKey) {
								escHovered = overEsc;
								hoveredKey = hovered?.key;
								tui.requestRender();
							}
							return;
						}
						if (mouseBaseButton(mouse.code) !== 0) return;
						if (
							escHitbox &&
							mouse.row === escHitbox.row &&
							mouse.col >= escHitbox.startCol &&
							mouse.col <= escHitbox.endCol
						) {
							done(undefined);
							return;
						}
						const hitbox = previewHitboxes.find(
							(candidate) =>
								mouse.row === candidate.row &&
								mouse.col >= candidate.startCol &&
								mouse.col <= candidate.endCol,
						);
						if (hitbox) {
							selectedPreviewIndex = Math.max(
								0,
								visiblePreviews.findIndex((preview) => preview.key === hitbox.key),
							);
							done(hitbox.key);
						}
					},
					render(width: number) {
						const inner = Math.max(1, width - 2);
						const escWidth = visibleWidth("[esc]");
						const percent = snapshot.percent;
						const title = theme.bold(theme.fg("accent", "Context Usage"));
						const subtitle = `${used === undefined ? "?" : formatTokens(used)} / ${formatTokens(contextWindow)} tokens (${percent === undefined ? "?" : percent.toFixed(1)}%)`;
						const barWidth = Math.max(1, Math.min(60, inner - 2));
						let remaining = barWidth;
						const segments = allParts
							.map((part, index) => {
								const cells =
									index === allParts.length - 1
										? remaining
										: Math.min(
												remaining,
												Math.round((part.tokens / Math.max(1, contextWindow)) * barWidth),
											);
								remaining -= cells;
								return theme.fg(part.color, "█".repeat(Math.max(0, cells)));
							})
							.join("");
						const labelWidth = Math.min(
							24,
							Math.max(...allParts.map((part) => part.label.length)),
						);
						const selectedLabel = visiblePreviews[selectedPreviewIndex]?.label;
						const partRows = allParts.map((part) => {
							const pct = contextWindow > 0 ? (part.tokens / contextWindow) * 100 : 0;
							const swatch = theme.fg(part.color, "■");
							const label = part.label.padEnd(labelWidth);
							const amount = `${formatTokens(part.tokens).padStart(7)}  ${pct.toFixed(1).padStart(5)}%`;
							const selected = part.label === selectedLabel;
							const hoverLabel = visiblePreviews.find((p) => p.key === hoveredKey)?.label;
							const prefix = selected ? "› " : "  ";
							const row = padLine(`${prefix}${swatch} ${label} ${amount}`, inner);
							if (selected) return theme.bg("selectedBg", row);
							return part.label === hoverLabel ? theme.bg("customMessageBg", row) : row;
						});
						const border = (text: string) => theme.fg("border", text);
						const lines = [
							border(`╭${"─".repeat(inner)}╮`),
							`${border("│")}${padLine(` ${title}  ${theme.fg("muted", subtitle)}`, inner - escWidth)}${theme.fg(escHovered ? "text" : "muted", "[esc]")}${border("│")}`,
							`${border("├")}${border("─".repeat(inner))}${border("┤")}`,
							`${border("│")}${padLine(` ${segments}`, inner)}${border("│")}`,
							`${border("│")}${padLine(theme.fg("muted", ` Source: ${contextSourceLabel(snapshot.source)} · category estimates`), inner)}${border("│")}`,
							...partRows.map((row) => `${border("│")}${row}${border("│")}`),
							`${border("├")}${border("─".repeat(inner))}${border("┤")}`,
							`${border("│")}${padLine(theme.fg("dim", " ↑↓ select · Click / Enter to preview · [esc] close"), inner)}${border("│")}`,
							border(`╰${"─".repeat(inner)}╯`),
						];

						const terminalHeight = Math.max(1, tui.terminal.rows);
						const maxHeight = Math.min(
							Math.max(1, Math.floor(terminalHeight * 0.9)),
							Math.max(1, terminalHeight - 2),
						);
						const visibleHeight = Math.min(lines.length, maxHeight);
						const overlayTop =
							1 + Math.floor((Math.max(1, terminalHeight - 2) - visibleHeight) / 2);
						const overlayLeft = Math.floor((Math.max(1, tui.terminal.columns) - width) / 2);
						escHitbox = escCloseHitbox({ left: overlayLeft, top: overlayTop, width });
						previewHitboxes = visiblePreviews.flatMap((preview) => {
							const partIndex = allParts.findIndex((part) => part.label === preview.label);
							const line = 5 + partIndex;
							return partIndex >= 0 && line < visibleHeight
								? [
										{
											key: preview.key,
											row: overlayTop + line + 1,
											startCol: overlayLeft + 1,
											endCol: overlayLeft + width,
										},
									]
								: [];
						});

						return lines;
					},
				};
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: 64,
					minWidth: 44,
					maxHeight: "90%",
					margin: 1,
				},
			},
		));

		if (!action) break;
		const preview = previewByKey.get(action as PreviewKey);
		if (!preview) continue;

		await showTextPreview(ctx, preview.title, preview.content);
	}
}
