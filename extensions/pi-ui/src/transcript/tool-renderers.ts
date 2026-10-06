// Adapted from pi-cc-extensions; see licenses/claude-style-tools-THIRD_PARTY_NOTICES.md.
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { config } from "../config/config.ts";
import { oneLine } from "../utils/format.ts";
import { isToolCallHovered } from "../overlays/mouse-state.ts";
import { createApplyPatchRenderer } from "./tool/apply-patch.ts";
import { createFileRenderer } from "./tool/files.ts";
import { fitToolCallSummary, humanizeToolLabel, toolCallSummary } from "./tool/names.ts";
import { showMoreHintText } from "./tool/show-more-hint.ts";
import {
	countLines, hasExpandableDetail, isToolExpanded, outputLineCount, pendingIcon,
	renderCollapsedToolResultToWidth, renderExpandedToolResult, resolveToolVisualState,
	scheduleAnimation, settledIcon, setToolVisualState, textFromResult, toolIconColor, toolViewportWidth,
} from "./tool/result.ts";

export function isMcpToolDefinition(definition: any, name: string): boolean {
	const label = typeof definition?.label === "string" ? definition.label.trim() : "";
	if (/^MCP(?::|$)/i.test(label)) return true;
	if (name === "mcp" || /^mcp[_:-]|[_:-]mcp[_:-]/i.test(name)) return true;
	if (label) return false;
	return /\bModel Context Protocol\b/i.test(String(definition?.description ?? ""));
}

export function humanizeMcpToolName(name: string): string {
	const words = name.replace(/^mcp(?:[_:-]+)+/i, "").split(/[_:-]+/).filter(Boolean);
	return words.length ? words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ") : "MCP";
}

function fallback(tool: any, slot: "renderCall" | "renderResult", args: any[], text: string) {
	try { if (typeof tool?.[slot] === "function") return tool[slot](...args); } catch {}
	return new Text(text, 0, 0);
}

/** Presentation functions only; never register or mutate the original definition. */
function createGenericRenderer(original: any): any {
	const name = original.name;
	const label = isMcpToolDefinition(original, name) ? humanizeMcpToolName(name) : original.label || name;
	return {
		renderShell: "self",
		renderCall(args: any, theme: any, context: any) {
			if (config.mode === "off") return fallback(original, "renderCall", [args, theme, context], String(name));
			const summary = toolCallSummary(name, args, {
				title: label === name ? humanizeToolLabel(label) : label, variant: "default", cwd: context?.cwd,
			});
			const expanded = Boolean(context?.expanded);
			let cachedWidth: number | undefined;
			let cachedLine: string | undefined;
			return {
				render(width: number) {
					const state = resolveToolVisualState(context);
					const pending = state === "pending" || (!state && (context?.isPartial || context?.executionStarted));
					if (!pending && cachedWidth === width && cachedLine !== undefined) return [cachedLine];
					if (pending && context?.executionStarted) scheduleAnimation(context);
					const glyph = pending ? pendingIcon(name) : settledIcon(name, state);
					const icon = state === "success" ? `\x1b[38;2;80;220;100m${glyph}\x1b[39m` : theme.fg(toolIconColor(context), glyph);
					const viewport = toolViewportWidth(width);
					const lead = expanded ? "" : " ";
					const available = Math.max(0, viewport - visibleWidth(icon) - 1 - (expanded ? 0 : 1) - visibleWidth(summary.detail));
					cachedWidth = width;
					cachedLine = truncateToWidth(`${lead}${icon} ${theme.fg("toolTitle", fitToolCallSummary(summary, available))}${theme.fg("dim", summary.detail)}`, viewport, "");
					return [cachedLine];
				},
				invalidate() { cachedWidth = undefined; cachedLine = undefined; },
			};
		},
		renderResult(result: any, options: any, theme: any, context: any) {
			if (config.mode === "off") return fallback(original, "renderResult", [result, options, theme, context], textFromResult(result));
			const expanded = isToolExpanded(options, context);
			const error = Boolean(options?.isError || context?.isError);
			setToolVisualState(context, options?.isPartial ? "pending" : error ? "error" : "success");
			const text = textFromResult(result, expanded);
			if (options?.isPartial && !text.trim()) return new Text(theme.fg("muted", expanded ? "↳ Pending…" : "   ↳ Pending…"), 0, 0);
			const args = context?.args;
			if (expanded) return renderExpandedToolResult(text, theme, error, context?.lastComponent, args, true);
			const count = outputLineCount(result) || countLines(text);
			const summary = error ? text ? oneLine(text, 72) : "Failed" :
				count ? `${count} ${count === 1 ? "line" : "lines"} ${name === "read" ? "loaded" : "returned"}` : "Done";
			const expandable = hasExpandableDetail(text, args);
			const prefix = expandable ? theme.fg("dim", " • ") : "";
			const hint = expandable ? prefix + theme.fg("dim", showMoreHintText()) : "";
			const hoveredHint = expandable ? prefix + theme.fg("text", showMoreHintText()) : "";
			let cachedWidth: number | undefined;
			let normal: string | undefined;
			let hovered: string | undefined;
			return {
				actionAtRow(row: number) { return expandable && row === 0 ? "expand" : undefined; },
				render(width: number) {
					if (cachedWidth !== width || normal === undefined) {
						cachedWidth = width;
						normal = theme.fg(error ? "error" : "muted", renderCollapsedToolResultToWidth(summary, hint, width));
						hovered = theme.fg(error ? "error" : "muted", renderCollapsedToolResultToWidth(summary, hoveredHint, width));
					}
					return [isToolCallHovered(context?.toolCallId) ? hovered! : normal];
				},
				invalidate() { cachedWidth = undefined; normal = undefined; hovered = undefined; },
			};
		},
	};
}

export function createCcstyleTool(original: any, kind: "generic" | "file" | "patch"): any {
	if (kind === "patch") return createApplyPatchRenderer(original, createGenericRenderer);
	if (kind === "file") return createFileRenderer(original);
	return createGenericRenderer(original);
}
