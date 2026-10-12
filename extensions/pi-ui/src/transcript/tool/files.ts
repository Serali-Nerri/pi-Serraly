import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { getCapabilities, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { RenderLines, renderToolHeader, renderToolStatus, type ToolCardState, type ToolCardTheme } from "pi-ui-kit";
import { config } from "../../config/config.ts";
import { sanitizeToolResultText } from "../../utils/tool-result-sanitize.ts";
import { resolveToolVisualState, scheduleAnimation, setToolVisualState } from "./result.ts";
import { toolLoadingIcon } from "../../utils/tool-loading-icon.ts";
import { showMoreHintText } from "./show-more-hint.ts";
import { isToolCallHovered } from "../../overlays/mouse-state.ts";
type Rgb = readonly [number, number, number];

interface ToolState {
	isPartial: boolean;
	isError: boolean;
}

// Palette sampled from the reference Claude tool rendering.
export const COLOR = {
	dotSuccess: [135, 215, 135],
	dotPending: [215, 215, 95],
	title: [242, 242, 242],
	secondary: [204, 204, 204],
	gutter: [127, 127, 127],
	summary: [148, 148, 148],
	body: [255, 255, 255],
	added: [95, 215, 95],
	removed: [215, 95, 95],
	addedBg: [0, 95, 0],
	removedBg: [95, 0, 0],
} satisfies Record<string, Rgb>;

export const CONTENT_INDENT = "      ";
const DIFF_INDENT = "     ";

const ANSI_256_CUBE_VALUES = [0, 95, 135, 175, 215, 255] as const;
const ANSI_256_GRAY_VALUES = Array.from({ length: 24 }, (_, index) => 8 + index * 10);

function closestColorIndex(value: number, candidates: readonly number[]): number {
	let closestIndex = 0;
	let closestDistance = Number.POSITIVE_INFINITY;
	for (let index = 0; index < candidates.length; index++) {
		const distance = Math.abs(value - candidates[index]!);
		if (distance < closestDistance) {
			closestIndex = index;
			closestDistance = distance;
		}
	}
	return closestIndex;
}

function colorDistance(left: Rgb, right: Rgb): number {
	const red = left[0] - right[0];
	const green = left[1] - right[1];
	const blue = left[2] - right[2];
	return red * red * 0.299 + green * green * 0.587 + blue * blue * 0.114;
}

// Match Pi's theme conversion so the extension follows terminal.trueColor.
function rgbToAnsi256(color: Rgb): number {
	const redIndex = closestColorIndex(color[0], ANSI_256_CUBE_VALUES);
	const greenIndex = closestColorIndex(color[1], ANSI_256_CUBE_VALUES);
	const blueIndex = closestColorIndex(color[2], ANSI_256_CUBE_VALUES);
	const cubeColor: Rgb = [
		ANSI_256_CUBE_VALUES[redIndex]!,
		ANSI_256_CUBE_VALUES[greenIndex]!,
		ANSI_256_CUBE_VALUES[blueIndex]!,
	];
	const cubeIndex = 16 + 36 * redIndex + 6 * greenIndex + blueIndex;

	const gray = Math.round(0.299 * color[0] + 0.587 * color[1] + 0.114 * color[2]);
	const grayOffset = closestColorIndex(gray, ANSI_256_GRAY_VALUES);
	const grayValue = ANSI_256_GRAY_VALUES[grayOffset]!;
	const grayColor: Rgb = [grayValue, grayValue, grayValue];
	const spread = Math.max(...color) - Math.min(...color);
	if (spread < 10 && colorDistance(color, grayColor) < colorDistance(color, cubeColor)) {
		return 232 + grayOffset;
	}
	return cubeIndex;
}

export function foreground(color: Rgb, text: string): string {
	const code = getCapabilities().trueColor ? `38;2;${color.join(";")}` : `38;5;${rgbToAnsi256(color)}`;
	return `\x1b[${code}m${text}\x1b[39m`;
}

function backgroundCode(color: Rgb): string {
	const code = getCapabilities().trueColor ? `48;2;${color.join(";")}` : `48;5;${rgbToAnsi256(color)}`;
	return `\x1b[${code}m`;
}

function bold(text: string): string {
	return `\x1b[1m${text}\x1b[22m`;
}

export function fit(text: string, width: number): string {
	return visibleWidth(text) > width ? truncateToWidth(text, width, "…") : text;
}

export function singleLine(text: string): Component {
	return new RenderLines((width) => [fit(text, width)]);
}

function cardState(state: ToolState): ToolCardState {
	return state.isError ? "error" : state.isPartial ? "running" : "success";
}

/** 公共卡头 `● title (summary)`；动画帧由调用方传入，kit 不持有 timer。 */
export function toolHeaderLines(
	theme: ToolCardTheme,
	state: ToolState,
	name: string,
	argument: string | undefined,
	width: number,
	glyph = "●",
): string[] {
	return renderToolHeader(theme, {
		title: name,
		summary: argument === undefined ? undefined : `(${argument})`,
		state: cardState(state),
		glyph,
	}, width);
}

/** 用公共卡头实测同一 name 的固定宽度，供标题内容自行裁剪时预留空间。 */
export function toolHeaderReservedWidth(
	theme: ToolCardTheme,
	state: ToolState,
	name: string,
	glyph = "●",
): number {
	return visibleWidth(toolHeaderLines(theme, state, name, "", Number.MAX_SAFE_INTEGER, glyph)[0] ?? "");
}

export function pendingResult(theme: ToolCardTheme, label: string): Component {
	return new RenderLines((width) => renderToolStatus(theme, { state: "running", message: label }, width));
}

function textFromContent(content: readonly { type: string; text?: string }[]): string {
	return content
		.filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n");
}

export function textOf(result: AgentToolResult<unknown>): string {
	return textFromContent(result.content);
}

function lineCount(text: string, emptyValue = 0): number {
	return text.length === 0 ? emptyValue : text.split("\n").length;
}

export interface NumberedPreview extends Component {
	hasHiddenContent(): boolean;
}

export function numberedPreview(content: string, expanded: boolean, full = false): NumberedPreview {
	let hidden = false;
	const component = new RenderLines((width) => {
		const source = content ? content.split("\n") : [];
		// 行预算按渲染后的行数计算：长行换行会占用预算，卡片高度仍然有界。
		const limit = full
			? Number.POSITIVE_INFINITY
			: expanded ? Math.max(1, config.fileExpandedMaxLines) : config.writePreviewLines;
		const gutterWidth = String(source.length).length;
		const available = Math.max(1, width - visibleWidth(CONTENT_INDENT) - gutterWidth - 1);
		const output: string[] = [];
		let completed = 0;

		for (const [index, text] of source.entries()) {
			if (output.length >= limit) break;
			// 折叠预览跳过空行（不占用行预算），展开与完整视图保留原始行号。
			if (!expanded && text.trim().length === 0) continue;
			const gutter = foreground(COLOR.gutter, `${String(index + 1).padStart(gutterWidth)} `);
			// 长行按可见宽度换行，续行留空行号列，而不是截断成 …。
			const chunks = wrapTextWithAnsi(text.replace(/\t/g, "   "), available);
			let rendered = 0;
			for (const [chunkIndex, part] of chunks.entries()) {
				if (output.length >= limit) break;
				output.push(`${CONTENT_INDENT}${chunkIndex ? " ".repeat(gutterWidth + 1) : gutter}${foreground(COLOR.body, part)}`);
				rendered++;
			}
			if (rendered < chunks.length) break;
			completed++;
		}

		hidden = completed < source.length;
		if (hidden) {
			output.push(foreground(COLOR.gutter, `${CONTENT_INDENT}…  +${source.length - completed} lines`));
		}
		return output.map((line) => fit(line, width));
	});
	return Object.assign(component, { hasHiddenContent: () => hidden });
}

interface DiffLine {
	sign: "+" | "-" | " ";
	lineNumber: string;
	content: string;
	omission?: boolean;
}

// EditToolDetails.diff uses "+17 text", "-17 text", and " 17 text" rows.
function parseDiff(diff: string): DiffLine[] {
	const rows: DiffLine[] = diff.split("\n").map((line) => {
		// Native Pi pads an omitted context row with a blank number gutter.
		// Numbered source text, including literal ellipses, never matches this.
		if (/^ {3,}\.\.\.$/.test(line)) return { sign: " ", lineNumber: "", content: "", omission: true };
		const match = line.match(/^([+\- ])(\s*\d*)\s(.*)$/);
		if (!match) return { sign: " ", lineNumber: "", content: line };
		return {
			sign: match[1] as DiffLine["sign"],
			lineNumber: match[2].trim(),
			content: match[3],
		};
	});
	// A terminal marker only says the file continues; it is not another piece
	// of retained diff that expansion can reveal.
	while (rows.at(-1)?.omission) rows.pop();
	return rows;
}

function fullWidthBackground(color: Rgb, text: string, width: number): string {
	const clipped = fit(text, width);
	const padding = " ".repeat(Math.max(0, width - visibleWidth(clipped)));
	return `${backgroundCode(color)}${clipped}${padding}\x1b[49m`;
}

export interface DiffPreview extends Component {
	hasHiddenContent(): boolean;
}

export function diffPreview(diff: string, expanded: boolean, full = false): DiffPreview {
	const parsed = parseDiff(diff);
	let hidden = false;
	const component = new RenderLines((width) => {
		// 行预算按渲染后的行数计算：长行换行会占用预算，卡片高度仍然有界。
		const limit = full
			? Number.POSITIVE_INFINITY
			: Math.max(1, expanded ? config.fileExpandedMaxLines : config.editPreviewLines);
		const gutterWidth = parsed.reduce((width, row) => Math.max(width, row.lineNumber.length), 2);
		const outerWidth = visibleWidth(DIFF_INDENT);
		const rowWidth = Math.max(1, width - outerWidth);
		const contentWidth = Math.max(1, rowWidth - gutterWidth - 4);
		const output: string[] = [];
		let completed = 0;

		for (const row of parsed) {
			if (output.length >= limit) break;
			if (row.omission) {
				output.push(foreground(COLOR.gutter, `${DIFF_INDENT} ${"⋮".padStart(gutterWidth)}`));
				completed++;
				continue;
			}

			const text = row.content.replace(/\t/g, "   ");
			// 长行按可见宽度换行，续行保留 +/- 标记与背景，而不是截断成 …。
			const chunks = wrapTextWithAnsi(text, contentWidth);
			let rendered = 0;
			for (const [index, content] of chunks.entries()) {
				if (output.length >= limit) break;
				const number = (index ? "" : row.lineNumber).padStart(gutterWidth);
				if (row.sign === "+" || row.sign === "-") {
					const markerColor = row.sign === "+" ? COLOR.added : COLOR.removed;
					const background = row.sign === "+" ? COLOR.addedBg : COLOR.removedBg;
					const styled =
						` ${foreground(markerColor, `${number} ${row.sign} `)}` + foreground(COLOR.body, content);
					output.push(`${DIFF_INDENT}${fullWidthBackground(background, styled, rowWidth)}`);
				} else {
					output.push(
						`${DIFF_INDENT} ${foreground(COLOR.gutter, number)}   ${foreground(COLOR.body, content)}`,
					);
				}
				rendered++;
			}
			if (rendered < chunks.length) break;
			completed++;
		}

		hidden = completed < parsed.length;
		if (hidden) {
			output.push(foreground(COLOR.gutter, `${DIFF_INDENT}…  +${parsed.length - completed} lines`));
		}
		return output.map((line) => fit(line, width));
	});
	return Object.assign(component, { hasHiddenContent: () => hidden });
}

function diffStats(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

export function isFileTool(name: unknown): boolean {
	return name === "write" || name === "edit";
}

/** 需要文件卡布局（self-shell、展开背景、compact 独立卡）的工具；与 isFileTool 的 edit/write 分派分开。 */
export function isFileLayoutTool(name: unknown): boolean {
	return name === "write" || name === "edit" || name === "apply_patch";
}

export class FileResultView implements Component {
	private moreRow = -1;
	constructor(
		private readonly status: (width: number) => string[],
		private readonly body: Component,
		readonly fullPreview: { title: string; content: Component },
		private readonly source: string,
		private readonly toolCallId?: string,
		/** 显式“还有已保留内容”标记；传函数时在 body 渲染后求值。 */
		private readonly reveal?: boolean | (() => boolean),
	) {}

	render(width: number): string[] {
		const safe = Math.max(1, width);
		const body = this.body.render(safe);
		const explicitReveal = typeof this.reveal === "function" ? this.reveal() : this.reveal;
		const clipped = explicitReveal ?? (body.some((line) => line.includes("…")) || this.source.split("\n").some((line) => visibleWidth(line) > safe - 12));
		const lines = [...this.status(safe), ...body];
		this.moreRow = clipped ? lines.length : -1;
		if (clipped) lines.push(fit(foreground(isToolCallHovered(this.toolCallId) ? COLOR.title : COLOR.gutter, `${CONTENT_INDENT}${showMoreHintText()}`), safe));
		return lines;
	}

	actionAtRow(row: number): "reveal" | undefined {
		return row === this.moreRow ? "reveal" : undefined;
	}

	previewAtRow(row: number): { title: string; content: Component } | undefined {
		return row === this.moreRow ? this.fullPreview : undefined;
	}

	invalidate(): void { this.body.invalidate(); this.fullPreview.content.invalidate(); }
}

/** 错误结果统一为红色诊断；展开查看完整错误，不把输入补丁当作成功 diff。 */
export function errorResultView(theme: ToolCardTheme, title: string, message: string, toolCallId?: string): FileResultView {
	const text = sanitizeToolResultText(message);
	const body = new RenderLines((width) =>
		text.split("\n").flatMap((line) => wrapTextWithAnsi(foreground(COLOR.removed, line), width)),
	);
	return new FileResultView(
		(width) => renderToolStatus(theme, { state: "error", message: text.split("\n")[0] || "Error" }, width),
		new RenderLines(() => (text.includes("\n") ? [`${CONTENT_INDENT}…`] : [])),
		{ title, content: body },
		text,
		toolCallId,
	);
}

export function createFileRenderer(original: any): any {
	const name = original.name as "write" | "edit";
	const fallback = (slot: string, args: any[]) => typeof original[slot] === "function"
		? original[slot](...args) : singleLine("Result unavailable");
	const valid = (args: any) => typeof args?.path === "string" && (name !== "write" || typeof args.content === "string");
	return {
		...original,
		renderShell: "self",
		renderCall(args: any, theme: any, context: any) {
			const nativeCall = valid(args) ? undefined : fallback("renderCall", [args, theme, context]);
			const path = typeof args?.path === "string" ? sanitizeToolResultText(args.path) : undefined;
			return {
				render(width: number) {
					const pending = resolveToolVisualState(context) === "pending";
					if (nativeCall && !pending) return nativeCall.render(width);
					if (pending) scheduleAnimation(context);
					return toolHeaderLines(theme, context, name, path, width, pending ? toolLoadingIcon() : "●");
				},
				invalidate() { nativeCall?.invalidate?.(); },
			};
		},
		renderResult(result: AgentToolResult<any>, options: any, theme: any, context: any) {
			if (!valid(context.args)) return fallback("renderResult", [result, options, theme, context]);
			if (options.isPartial) return pendingResult(theme, name === "write" ? "Writing…" : "Editing…");
			setToolVisualState(context, context.isError ? "error" : "success");
			if (context.isError) {
				return errorResultView(theme, `${name}: ${context.args.path}`, textOf(result), context.toolCallId);
			}
			if (name === "write") {
				const content = sanitizeToolResultText(context.args.content);
				const count = lineCount(content);
				const message = `Wrote ${count} ${count === 1 ? "line" : "lines"} to ${sanitizeToolResultText(context.args.path)}`;
				const status = (width: number) => renderToolStatus(theme, { state: "success", message }, width);
				const preview = numberedPreview(content, options.expanded);
				return new FileResultView(status, preview,
					{ title: `write: ${context.args.path}`, content: numberedPreview(content, true, true) }, content, context.toolCallId,
					() => preview.hasHiddenContent());
			}
			if (typeof result.details?.diff !== "string") return fallback("renderResult", [result, options, theme, context]);
			const diff = sanitizeToolResultText(result.details.diff);
			const { added, removed } = diffStats(diff);
			const message = `Added ${added} ${added === 1 ? "line" : "lines"}, removed ${removed} ${removed === 1 ? "line" : "lines"}`;
			const status = (width: number) => renderToolStatus(theme, { state: "success", message }, width);
			const preview = diffPreview(diff, options.expanded);
			// 换行后不再用源行宽度推断裁切；只有行预算真正丢弃内容时才显示查看更多。
			return new FileResultView(status, preview,
				{ title: `edit: ${context.args.path}`, content: diffPreview(diff, true, true) }, diff, context.toolCallId,
				() => preview.hasHiddenContent());
		},
	};
}
