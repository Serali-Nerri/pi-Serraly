// apply_patch 结果视图：只校验工具返回的版本化 details 契约，并组合文件卡组件。
// 本模块不解析输入补丁生成 diff、不读取文件、不执行或重放补丁。
import { visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { config } from "../../config/config.ts";
import { oneLine } from "../../utils/format.ts";
import { sanitizeToolResultText } from "../../utils/tool-result-sanitize.ts";
import { toolLoadingIcon } from "../../utils/tool-loading-icon.ts";
import {
	COLOR,
	CONTENT_INDENT,
	FileResultView,
	RenderLines,
	diffPreview,
	errorResultView,
	fit,
	foreground,
	pendingResult,
	resultHead,
	singleLine,
	textOf,
	toolHeaderText,
} from "./files.ts";
import { describePatchTitle, fitPatchPaths, formatPatchTitle, patchDisplayPath, type PatchTitle } from "./apply-patch-title.ts";
import { scheduleAnimation } from "./result.ts";

const FORMAT = "apply_patch.v1";
const MAX_CHANGES = 128;
const MAX_VIEWS_PER_CHANGE = 2;
const MAX_DIFF_BYTES_PER_VIEW = 16 * 1024;
const MAX_DIFF_BYTES_TOTAL = 64 * 1024;
const MAX_DIFF_ROWS_PER_VIEW = 200;
const MAX_DIFF_ROWS_TOTAL = 600;
const MAX_NOTICE_ROWS = 8;

export type ApplyPatchRole = "file" | "move" | "source-delete" | "destination";
export type ApplyPatchAvailability = "complete" | "truncated" | "omitted";
export type ApplyPatchReason = "work-limit" | "result-limit" | "diff-error" | "cancelled";

export interface ApplyPatchFileFacts {
	exists: boolean;
	bytes: number;
	lines: number;
	bom: boolean;
	endings: { lf: number; crlf: number; cr: number };
	finalNewline: boolean;
}

export interface ApplyPatchView {
	role: ApplyPatchRole;
	before: ApplyPatchFileFacts;
	after: ApplyPatchFileFacts;
	added: number | null;
	removed: number | null;
	diff?: string;
	availability: ApplyPatchAvailability;
	reason?: ApplyPatchReason;
	diffTotalLines?: number;
	lineEndingsChanged: boolean;
}

export interface ApplyPatchChange {
	kind: "add" | "update" | "delete";
	path: string;
	moveFrom?: string;
	contentChanged?: boolean;
	views: ApplyPatchView[];
}

export interface ApplyPatchDetails {
	format: typeof FORMAT;
	changes: ApplyPatchChange[];
	reportUnavailable?: "diff-error";
}

export function isApplyPatchTool(name: unknown): boolean {
	return name === "apply_patch";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteCount(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
	return value;
}

function parseFacts(value: unknown): ApplyPatchFileFacts | undefined {
	if (!isRecord(value)) return undefined;
	const bytes = finiteCount(value.bytes);
	const lines = finiteCount(value.lines);
	if (bytes === undefined || lines === undefined) return undefined;
	if (
		typeof value.exists !== "boolean" ||
		typeof value.bom !== "boolean" ||
		typeof value.finalNewline !== "boolean" ||
		!isRecord(value.endings)
	) {
		return undefined;
	}
	const lf = finiteCount(value.endings.lf);
	const crlf = finiteCount(value.endings.crlf);
	const cr = finiteCount(value.endings.cr);
	if (lf === undefined || crlf === undefined || cr === undefined) return undefined;
	return {
		exists: value.exists,
		bytes,
		lines,
		bom: value.bom,
		endings: { lf, crlf, cr },
		finalNewline: value.finalNewline,
	};
}

function parseNullableCount(value: unknown): number | null | undefined {
	if (value === null) return null;
	return finiteCount(value);
}

function parseView(value: unknown): ApplyPatchView | undefined {
	if (!isRecord(value)) return undefined;
	const role = value.role;
	if (role !== "file" && role !== "move" && role !== "source-delete" && role !== "destination") {
		return undefined;
	}
	const before = parseFacts(value.before);
	const after = parseFacts(value.after);
	if (!before || !after) return undefined;
	const added = parseNullableCount(value.added);
	const removed = parseNullableCount(value.removed);
	if (added === undefined || removed === undefined) return undefined;
	const availability = value.availability;
	if (availability !== "complete" && availability !== "truncated" && availability !== "omitted") {
		return undefined;
	}
	let reason: ApplyPatchReason | undefined;
	if (value.reason !== undefined) {
		if (
			value.reason !== "work-limit" &&
			value.reason !== "result-limit" &&
			value.reason !== "diff-error" &&
			value.reason !== "cancelled"
		) {
			return undefined;
		}
		reason = value.reason;
	}
	let diff: string | undefined;
	if (value.diff !== undefined) {
		if (typeof value.diff !== "string" || value.diff.length > MAX_DIFF_BYTES_PER_VIEW ||
			Buffer.byteLength(value.diff, "utf8") > MAX_DIFF_BYTES_PER_VIEW) return undefined;
		if (value.diff !== "" && value.diff.split("\n").length > MAX_DIFF_ROWS_PER_VIEW) return undefined;
		// sanitize 只作用于展示副本；工具已经在磁盘提交后生成该文本。
		diff = sanitizeToolResultText(value.diff, MAX_DIFF_BYTES_PER_VIEW);
		if (diff !== "" && diff.split("\n").length > MAX_DIFF_ROWS_PER_VIEW) return undefined;
	}
	if (availability === "omitted" ? diff !== undefined : diff === undefined) return undefined;
	let diffTotalLines: number | undefined;
	if (value.diffTotalLines !== undefined) {
		diffTotalLines = finiteCount(value.diffTotalLines);
		if (diffTotalLines === undefined) return undefined;
	}
	if (typeof value.lineEndingsChanged !== "boolean") return undefined;
	return { role, before, after, added, removed, diff, availability, reason, diffTotalLines, lineEndingsChanged: value.lineEndingsChanged };
}

/**
 * 契约校验：工具名/format/数组/枚举/非负有限统计值/大小上限。
 * 任何未知、旧版或非法形状都返回 undefined，交给通用渲染器安全降级；
 * 容忍未来新增的可选字段。
 */
export function parseApplyPatchDetails(value: unknown): ApplyPatchDetails | undefined {
	if (!isRecord(value) || value.format !== FORMAT) return undefined;
	if (!Array.isArray(value.changes) || value.changes.length > MAX_CHANGES) return undefined;
	if (value.reportUnavailable !== undefined && value.reportUnavailable !== "diff-error") return undefined;
	const reportUnavailable = value.reportUnavailable === "diff-error" ? "diff-error" as const : undefined;
	let totalDiffBytes = 0;
	let totalDiffRows = 0;
	const changes: ApplyPatchChange[] = [];
	for (const item of value.changes) {
		if (!isRecord(item)) return undefined;
		const kind = item.kind;
		if (kind !== "add" && kind !== "update" && kind !== "delete") return undefined;
		if (typeof item.path !== "string" ||
			(item.moveFrom !== undefined && typeof item.moveFrom !== "string")) return undefined;
		const path = oneLine(item.path, 4096);
		if (!path) return undefined;
		const moveFrom = item.moveFrom === undefined ? undefined : oneLine(item.moveFrom, 4096) || undefined;
		if (item.moveFrom !== undefined && (!moveFrom || kind !== "update")) return undefined;
		if (item.contentChanged !== undefined && (!moveFrom || typeof item.contentChanged !== "boolean")) return undefined;
		if (!Array.isArray(item.views) || item.views.length > MAX_VIEWS_PER_CHANGE) return undefined;
		const views: ApplyPatchView[] = [];
		for (const rawView of item.views) {
			const view = parseView(rawView);
			if (!view) return undefined;
			if (view.diff) {
				totalDiffBytes += Buffer.byteLength(view.diff, "utf8");
				totalDiffRows += view.diff.split("\n").length;
				if (totalDiffBytes > MAX_DIFF_BYTES_TOTAL || totalDiffRows > MAX_DIFF_ROWS_TOTAL) return undefined;
			}
			views.push(view);
		}
		if (reportUnavailable) {
			if (views.length !== 0) return undefined;
		} else if (moveFrom) {
			if (!(views.length === 1 && views[0]!.role === "move") &&
				!(views.length === 2 && views[0]!.role === "source-delete" && views[1]!.role === "destination")) return undefined;
		} else if (views.length !== 1 || views[0]!.role !== "file") return undefined;
		changes.push({
			kind, path, moveFrom, views,
			...(item.contentChanged === undefined ? {} : { contentChanged: item.contentChanged as boolean }),
		});
	}
	return { format: FORMAT, changes, reportUnavailable };
}

const HEADLINE = Symbol("ccstyle.apply-patch.headline");

function setTitle(context: any, title: PatchTitle): void {
	if (context?.state) context.state[HEADLINE] = title;
}

type ViewEntry = { change: ApplyPatchChange; view: ApplyPatchView };

function collectViews(details: ApplyPatchDetails): ViewEntry[] {
	const entries: ViewEntry[] = [];
	for (const change of details.changes) {
		for (const view of change.views) entries.push({ change, view });
	}
	return entries;
}

function viewLabel(change: ApplyPatchChange, view: ApplyPatchView, display: (path: string) => string, width?: number): string {
	const target = display(change.path);
	const source = change.moveFrom ? display(change.moveFrom) : "";
	const paths = view.role === "move" && source ? [source, target]
		: [view.role === "source-delete" ? source || target : target];
	return width === undefined ? paths.join(" → ") : fitPatchPaths(paths, width);
}

function statsPhrase(views: ApplyPatchView[]): string {
	if (views.length === 0) return "no diff data";
	const anyAdded = views.some((view) => view.added !== null);
	const anyRemoved = views.some((view) => view.removed !== null);
	if (!anyAdded && !anyRemoved) return "statistics unavailable";
	const addedKnown = views.every((view) => view.added !== null);
	const removedKnown = views.every((view) => view.removed !== null);
	let added = 0;
	let removed = 0;
	for (const view of views) {
		added += view.added ?? 0;
		removed += view.removed ?? 0;
	}
	// 部分统计可用时保留已知合计并用 ? 标记未知项，再附 (partial) 避免看起来完整。
	const addedText = anyAdded ? `${added}${addedKnown ? "" : "?"}` : "?";
	const removedText = anyRemoved ? `${removed}${removedKnown ? "" : "?"}` : "?";
	const partial = !addedKnown || !removedKnown;
	return `+${addedText} -${removedText}${partial ? " (partial)" : ""}`;
}

/** 折叠/展开标题行：操作、角色感知路径、精确或明确未知的统计。 */
function summaryContent(details: ApplyPatchDetails): string {
	const changes = details.changes;
	if (changes.length === 0) return foreground(COLOR.secondary,
		details.reportUnavailable ? "Patch diff data unavailable." : "No files were modified.");
	const stats = details.reportUnavailable ? "diff data unavailable" : statsPhrase(collectViews(details).map((entry) => entry.view));
	if (changes.length === 1) {
		const change = changes[0]!;
		const moved = Boolean(change.moveFrom);
		const destination = moved ? change.views.find((view) => view.role === "destination" && view.before.exists) : undefined;
		const overwrote = destination
			? unchangedContent(destination) ? " (existing target unchanged)"
				: destination.added === null || destination.removed === null ? " (existing target; diff unavailable)"
					: " (overwrote existing file)"
			: "";
		return foreground(COLOR.secondary, `${overwrote ? overwrote.trim() + " · " : ""}${stats}`);
	}
	const counts = { added: 0, updated: 0, deleted: 0, moved: 0 };
	for (const change of changes) {
		if (change.moveFrom) counts.moved++;
		else if (change.kind === "add") counts.added++;
		else if (change.kind === "delete") counts.deleted++;
		else counts.updated++;
	}
	const kinds = [
		counts.added ? `${counts.added} added` : "",
		counts.updated ? `${counts.updated} updated` : "",
		counts.deleted ? `${counts.deleted} deleted` : "",
		counts.moved ? `${counts.moved} moved` : "",
	].filter(Boolean).join(", ");
	return foreground(COLOR.secondary, [kinds, stats].filter(Boolean).join(" · "));
}

function viewStatsText(view: ApplyPatchView): string {
	if (view.added === null || view.removed === null) return "";
	return `(${foreground(COLOR.added, `+${view.added}`)} ${foreground(COLOR.removed, `-${view.removed}`)})`;
}

function unchangedContent(view: ApplyPatchView): boolean {
	const { before, after } = view;
	return view.added === 0 && view.removed === 0 && !view.lineEndingsChanged &&
		before.exists === after.exists && before.bytes === after.bytes && before.bom === after.bom &&
		before.finalNewline === after.finalNewline && before.endings.lf === after.endings.lf &&
		before.endings.crlf === after.endings.crlf && before.endings.cr === after.endings.cr;
}

/** 文件格式附注（BOM/末尾换行/换行风格）与角色说明，只显示事实。 */
function viewNotes(view: ApplyPatchView): string[] {
	const notes: string[] = [];
	if (view.role === "source-delete") notes.push("source removed");
	if (view.role === "destination" && view.before.exists) {
		notes.push(
			view.added === null || view.removed === null
				? "existing target; content diff unavailable"
				: unchangedContent(view)
				? "target content unchanged"
				: "existing target replaced",
		);
	}
	if (view.role === "move" && unchangedContent(view)) {
		notes.push("content unchanged");
	}
	if (view.availability === "complete" && (view.added === null || view.removed === null)) {
		notes.push("statistics unavailable");
	}
	// 创建/删除的前后事实描述的是文件存在性，不是附加的格式变化。
	if (view.before.exists === view.after.exists) {
		if (view.before.bom !== view.after.bom) notes.push(view.after.bom ? "BOM added" : "BOM removed");
		if (view.before.finalNewline !== view.after.finalNewline) {
			notes.push(view.after.finalNewline ? "final newline added" : "final newline removed");
		}
		if (view.lineEndingsChanged) notes.push("line endings changed");
	} else {
		const present = view.after.exists ? view.after : view.before;
		if (present.bom) notes.push("UTF-8 BOM");
		if (present.lines > 0 && !present.finalNewline) notes.push("no final newline");
		if (present.endings.crlf || present.endings.cr) {
			const styles = [
				present.endings.lf ? "LF" : "",
				present.endings.crlf ? "CRLF" : "",
				present.endings.cr ? "CR" : "",
			].filter(Boolean);
			notes.push(`line endings: ${styles.join("/")}`);
		}
	}
	return notes;
}

function viewHeaderLine(change: ApplyPatchChange, view: ApplyPatchView, display: (path: string) => string, width?: number): string {
	const stats = viewStatsText(view);
	const code = view.role === "source-delete" ? "D" : changeCode(change);
	const prefix = `${CONTENT_INDENT}${foreground(COLOR.secondary, code)} `;
	const suffix = stats ? ` ${stats}` : "";
	const available = width === undefined ? undefined : Math.max(0, width - visibleWidth(prefix + suffix));
	let line = `${prefix}${foreground(COLOR.title, viewLabel(change, view, display, available))}${suffix}`;
	for (const note of viewNotes(view)) line += foreground(COLOR.gutter, ` · ${note}`);
	return line;
}

const REASON_TEXT: Record<ApplyPatchReason, string> = {
	"work-limit": "computation limit",
	"result-limit": "result size limit",
	"diff-error": "diff error",
	"cancelled": "cancelled",
};

function retainedDiffLines(view: ApplyPatchView): number {
	return view.diff ? Math.max(1, view.diff.split("\n").length) : 0;
}

/** 工具已丢弃的数据（truncated/omitted/未知统计）必须始终可见，不能藏在展开层后面。 */
function collectNotices(details: ApplyPatchDetails, display: (path: string) => string): string[] {
	const notices: string[] = [];
	for (const { change, view } of collectViews(details)) {
		const label = viewLabel(change, view, display);
		if (view.availability === "truncated") {
			const retained = retainedDiffLines(view);
			const total = view.diffTotalLines === undefined ? "" : ` of ${view.diffTotalLines}`;
			notices.push(`${label}: diff truncated (showing ${retained}${total} lines)`);
		} else if (view.availability === "omitted") {
			notices.push(`${label}: diff omitted (${view.reason ? REASON_TEXT[view.reason] : "unavailable"})`);
		} else if (view.added === null || view.removed === null) {
			notices.push(`${label}: line statistics unavailable`);
		}
	}
	if (details.reportUnavailable) notices.push("patch diff data unavailable (the tool could not summarize this patch)");
	return notices;
}

function changeCode(change: ApplyPatchChange): string {
	return { add: "A", update: "M", delete: "D" }[change.kind];
}

function changeRow(change: ApplyPatchChange, display: (path: string) => string, width?: number): string {
	const color = change.kind === "add" ? COLOR.added : change.kind === "delete" ? COLOR.removed : COLOR.secondary;
	const paths = change.moveFrom ? [display(change.moveFrom), display(change.path)] : [display(change.path)];
	const prefix = `${CONTENT_INDENT}${foreground(color, changeCode(change))} `;
	const label = width === undefined ? paths.join(" → ") : fitPatchPaths(paths, Math.max(0, width - visibleWidth(prefix)));
	return prefix + foreground(COLOR.title, label);
}

type CardBuild = { lines: string[]; clipped: boolean };

/**
 * 折叠/展开卡片正文：视图标题 + 短 diff，整体共用全局行预算（editPreviewLines /
 * fileExpandedMaxLines）；超预算的视图、diff 行和通知通过展开与 overlay 查看。
 */
function buildCardLines(
	width: number,
	details: ApplyPatchDetails,
	expanded: boolean,
	display: (path: string) => string,
): CardBuild {
	const lines: string[] = [];
	const changes = details.changes;
	const views = collectViews(details);
	const budget = Math.max(1, expanded ? config.fileExpandedMaxLines : config.editPreviewLines);
	const share = Math.max(1, Math.floor(budget / Math.max(1, views.length)));
	let remaining = budget;
	let hiddenViews = 0;
	let sliced = false;

	if (details.reportUnavailable) {
		for (const change of changes) {
			if (remaining < 1) {
				hiddenViews++;
				continue;
			}
			const row = changeRow(change, display, width);
			if (row !== changeRow(change, display)) sliced = true;
			lines.push(row);
			remaining--;
		}
	} else {
		for (const { change, view } of views) {
			if (remaining < 1) {
				hiddenViews++;
				continue;
			}
			const header = viewHeaderLine(change, view, display, width);
			if (header !== viewHeaderLine(change, view, display)) sliced = true;
			lines.push(header);
			remaining--;
			if (!view.diff) continue;
			const preview = diffPreview(view.diff, expanded);
			const rows = preview.render(width);
			if (preview.hasHiddenContent()) sliced = true;
			const take = Math.max(0, Math.min(share, remaining, rows.length));
			if (take < rows.length) sliced = true;
			if (take > 0) {
				lines.push(...rows.slice(0, take));
				remaining -= take;
			}
		}
	}

	if (hiddenViews > 0) {
		lines.push(foreground(COLOR.gutter, `${CONTENT_INDENT}… +${hiddenViews} more ${hiddenViews === 1 ? "entry" : "entries"}`));
	}
	const notices = collectNotices(details, display);
	const shown = notices.slice(0, MAX_NOTICE_ROWS);
	for (const notice of shown) lines.push(foreground(COLOR.gutter, `${CONTENT_INDENT}${notice}`));
	if (notices.length > shown.length) {
		lines.push(foreground(COLOR.gutter, `${CONTENT_INDENT}… +${notices.length - shown.length} more notices`));
	}
	return {
		lines: lines.map((line) => fit(line, width)),
		clipped: sliced || hiddenViews > 0 || notices.length > shown.length ||
			lines.some((line) => visibleWidth(line) > width),
	};
}

function hasIncompleteData(details: ApplyPatchDetails): boolean {
	return Boolean(details.reportUnavailable) ||
		details.changes.some((change) => change.views.some((view) => view.availability !== "complete"));
}

/** overlay：只展示该次调用已保留的数据，并重复截断/省略通知，不承诺完整源码 diff。 */
function buildOverlayLines(width: number, details: ApplyPatchDetails, display: (path: string) => string): string[] {
	const lines: string[] = [];
	if (hasIncompleteData(details)) {
		lines.push(...wrapTextWithAnsi(foreground(COLOR.gutter, `${CONTENT_INDENT}showing retained tool data only; not a complete source diff`), width));
	}
	if (details.reportUnavailable) {
		for (const change of details.changes) lines.push(...wrapTextWithAnsi(changeRow(change, display), width));
	} else {
		for (const { change, view } of collectViews(details)) {
			lines.push(...wrapTextWithAnsi(viewHeaderLine(change, view, display), width));
			if (view.diff) lines.push(...diffPreview(view.diff, true, true).render(width));
		}
	}
	for (const notice of collectNotices(details, display)) {
		lines.push(...wrapTextWithAnsi(foreground(COLOR.gutter, `${CONTENT_INDENT}${notice}`), width));
	}
	return lines;
}

function previewContent(details: ApplyPatchDetails, display: (path: string) => string): { title: string; content: Component } {
	const title = details.changes.length === 1
		? `apply_patch: ${display(details.changes[0]!.path)}`
		: `apply_patch: ${details.changes.length} changes`;
	return { title, content: new RenderLines((width) => buildOverlayLines(width, details, display)) };
}

function buildResultView(details: ApplyPatchDetails, expanded: boolean, context: any): FileResultView {
	const display = (path: string) => patchDisplayPath(path, context?.cwd);
	let clipped = false;
	const body = new RenderLines((width) => {
		const built = buildCardLines(width, details, expanded, display);
		clipped = built.clipped;
		return built.lines;
	});
	return new FileResultView(
		resultHead(summaryContent(details)),
		body,
		previewContent(details, display),
		"",
		context?.toolCallId,
		() => clipped,
	);
}

/**
 * apply_patch 专用适配：契约合法时渲染文件卡；off 或未知/旧版/非法 details
 * 时委托给通用 ccstyle renderer（不猜测输入补丁，也不伪造成成功 diff）。
 */
export function createApplyPatchRenderer(
	original: any,
	createFallback: (tool: any) => any,
): any {
	const fallback = createFallback(original);
	const fallbackCall = (args: any, theme: any, context: any) =>
		typeof fallback?.renderCall === "function"
			? fallback.renderCall(args, theme, context)
			: singleLine(String(original?.name ?? "apply_patch"));
	const fallbackResult = (result: any, options: any, theme: any, context: any) =>
		typeof fallback?.renderResult === "function"
			? fallback.renderResult(result, options, theme, context)
			: singleLine("Result unavailable");
	return {
		...original,
		renderShell: "self",
		renderCall(args: any, theme: any, context: any) {
			if (config.mode === "off") return fallbackCall(args, theme, context);
			if (context?.isPartial && context?.executionStarted) scheduleAnimation(context);
			const dot = context?.isPartial && context?.executionStarted ? toolLoadingIcon() : "●";
			// Pi builds the call slot before the result slot. Read shared state
			// lazily at paint time, using a fresh component on every update.
			return new RenderLines((width) => {
				const title: PatchTitle = context?.state?.[HEADLINE] ??
					{ status: context?.executionStarted ? "Applying patch" : "Patch" };
				const available = Math.max(0, width - visibleWidth(toolHeaderText(context, "apply_patch", "", true, dot)));
				return [fit(toolHeaderText(context, "apply_patch", formatPatchTitle(title, available), true, dot), width)];
			});
		},
		renderResult(result: any, options: any, theme: any, context: any) {
			if (config.mode === "off") return fallbackResult(result, options, theme, context);
			if (options?.isPartial) {
				setTitle(context, { status: "Applying patch" });
				return pendingResult("Applying patch…");
			}
			// 失败走 Pi 错误通道（details 为空）：只显示错误诊断，绝不画成功 diff。
			if (options?.isError || context?.isError || result?.isError) {
				setTitle(context, { status: "Failed" });
				return errorResultView("apply_patch: error", textOf(result), context?.toolCallId);
			}
			const details = parseApplyPatchDetails(result?.details);
			setTitle(context, details ? describePatchTitle(details, context?.cwd) : { status: "Result unavailable" });
			if (!details) return fallbackResult(result, options, theme, context);
			return buildResultView(details, Boolean(options?.expanded), context);
		},
	};
}
