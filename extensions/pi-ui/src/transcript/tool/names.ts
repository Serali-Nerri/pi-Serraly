// Adapted from pi-cc-extensions v0.8.69, plus the long-path summary from v0.8.70
// (minuque/pi-cc-extensions@26aa98df); see licenses/claude-style-tools-THIRD_PARTY_NOTICES.md.
import { posix, win32 } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { config } from "../../config/config.ts";
import { oneLine } from "../../utils/format.ts";

function clipLimit(): number {
	return config.inputClip > 0 ? config.inputClip : Number.POSITIVE_INFINITY;
}

function clip(value: unknown): string {
	const text = oneLine(value, Number.POSITIVE_INFINITY);
	const limit = clipLimit();
	if (text.length <= limit) return text;
	let head = "";
	for (const { segment } of pathSegmenter.segment(text)) {
		if (head.length + segment.length > limit - 1) break;
		head += segment;
	}
	return `${head}…`;
}

/**
 * 工具名/标签人性化：与 default-mode 的 humanizeToolLabel、grouping 的 humanizeToolName
 * 逐字相同，收敛为一个共享实现。
 */
export function humanizeToolLabel(label: string): string {
	if (label.toLowerCase() === "powershell") return "PowerShell";
	return label
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (char) => char.toUpperCase());
}

const AGENT_FAMILY_TOOL_NAMES = new Set([
	"Agent",
	"Agents",
	"get_subagent_result",
	"steer_subagent",
]);

/** 具名 agent 的标题变体；eligible 命令、检索与路径展示共享取值。 */
export type ToolCallSummaryVariant = "default" | "grouping";

export type ToolCallSummaryOptions = {
	/** 已解析标题；缺省为 humanizeToolLabel(toolName)。 */
	title?: string;
	/** 文案变体；缺省 "default"。 */
	variant?: ToolCallSummaryVariant;
	/** 工具执行目录；仅用于生成展示路径，不修改调用参数。 */
	cwd?: string;
};

export type ToolCallSummary = {
	main: string;
	detail: string;
	/** 路径摘要保留结构，供最终渲染按实际宽度优先保留文件名。 */
	path?: { prefix: string; value: string };
};

function pathApi(value: string) {
	// 与上游不同：posix 优先。win32.isAbsolute("/a/b") 同样为 true，
	// 按上游顺序在 Linux 下会把 posix 路径按 win32 相对化（反斜杠分隔）。
	if (posix.isAbsolute(value)) return posix;
	if (win32.isAbsolute(value)) return win32;
	return undefined;
}

/** cwd 内绝对路径转相对路径；cwd 外路径保持不变。 */
export function displayPath(value: unknown, cwd?: string): string {
	const text = oneLine(value, 4096);
	const base = cwd ? oneLine(cwd, 4096) : "";
	const api = pathApi(text);
	if (!api || !base || !api.isAbsolute(base)) return text;
	const relative = api.relative(base, text);
	if (!relative) return api.basename(text) || ".";
	if (relative === ".." || relative.startsWith(`..${api.sep}`) || api.isAbsolute(relative)) {
		return text;
	}
	return relative;
}

const pathSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function headToWidth(text: string, width: number, ellipsis = ""): string {
	if (visibleWidth(text) <= width) return text;
	if (width <= 0) return "";
	const suffix = visibleWidth(ellipsis) <= width ? ellipsis : "";
	const contentWidth = width - visibleWidth(suffix);
	let head = "";
	for (const { segment: char } of pathSegmenter.segment(text)) {
		if (visibleWidth(head + char) > contentWidth) break;
		head += char;
	}
	return head + suffix;
}

function tailToWidth(text: string, width: number): string {
	if (width <= 0) return "";
	let tail = "";
	for (const char of Array.from(pathSegmenter.segment(text), ({ segment }) => segment).reverse()) {
		if (visibleWidth(char + tail) > width) break;
		tail = char + tail;
	}
	return tail;
}

/** 中间截断路径：目录保留开头，末尾优先完整保留文件名。 */
export function truncatePathToWidth(path: string, width: number, ellipsis = "…"): string {
	if (visibleWidth(path) <= width) return path;
	const ellipsisWidth = visibleWidth(ellipsis);
	if (width <= ellipsisWidth) return headToWidth(ellipsis, Math.max(0, width));
	const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	const filename = separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
	const filenameWidth = visibleWidth(filename);
	// ASCII middle omission can retain the final parent as well as the name
	// when there is room for an identifiable starting path segment.
	if (ellipsis === "..." && separatorIndex > 0) {
		const directory = path.slice(0, separatorIndex);
		const parentStart = Math.max(directory.lastIndexOf("/"), directory.lastIndexOf("\\"));
		const start = path.match(/^(?:[A-Za-z]:[\\/]|[\\/]{1,2})?[^\\/]+/u)?.[0] ?? "";
		if (parentStart > 0 && visibleWidth(start + ellipsis + path.slice(parentStart)) <= width) {
			const suffix = path.slice(parentStart);
			return headToWidth(path.slice(0, parentStart), width - ellipsisWidth - visibleWidth(suffix)) + ellipsis + suffix;
		}
	}
	if (separatorIndex >= 0 && filenameWidth + ellipsisWidth <= width) {
		const separator = path[separatorIndex]!;
		const suffix = `${separator}${filename}`;
		const prefixWidth = width - visibleWidth(suffix) - ellipsisWidth;
		const prefix = headToWidth(path.slice(0, separatorIndex), Math.max(0, prefixWidth));
		return `${prefix}${ellipsis}${prefix ? suffix : filename}`;
	}
	if (ellipsis === "..." && filenameWidth <= width) return filename;
	const leftWidth = Math.max(1, Math.floor((width - ellipsisWidth) * 0.45));
	const rightWidth = Math.max(0, width - leftWidth - ellipsisWidth);
	return `${headToWidth(filename, leftWidth)}${ellipsis}${tailToWidth(filename, rightWidth)}`;
}

/** 按最终终端宽度渲染摘要；路径摘要不会再被整行截断隐藏文件名。 */
export function fitToolCallSummary(summary: ToolCallSummary, width: number): string {
	if (!summary.path) return headToWidth(summary.main, width, "…");
	const prefix = summary.path.prefix;
	const pathWidth = Math.max(0, width - visibleWidth(prefix) - 1);
	if (pathWidth <= 0) return headToWidth(prefix, width, "…");
	return `${prefix} ${truncatePathToWidth(summary.path.value, Math.min(pathWidth, clipLimit()))}`;
}

function pathSummary(
	prefix: string,
	value: unknown,
	cwd: string | undefined,
	detail = "",
): ToolCallSummary {
	const path = displayPath(value, cwd);
	return {
		main: `${prefix} ${truncatePathToWidth(path, clipLimit())}`,
		detail,
		path: { prefix, value: path },
	};
}

/**
 * 单工具调用摘要（{ main, detail }）。
 *
 * Eligible 工具共享命令、检索与路径取值；具名 agent 展示保留自己的标题语义。
 */
export function toolCallSummary(
	toolName: string,
	args: any,
	opts: ToolCallSummaryOptions = {},
): ToolCallSummary {
	const title = opts.title ?? humanizeToolLabel(toolName);
	const variant = opts.variant ?? "default";
	if (!args || typeof args !== "object") return { main: title, detail: "" };
	const name = toolName.toLowerCase();
	const value = (fallback: string, ...keys: string[]) => {
		const found = keys.map((key) => args[key]).find((item) => typeof item === "string" && item);
		return `${title} ${clip(found || fallback)}`;
	};

	if (variant === "default" && AGENT_FAMILY_TOOL_NAMES.has(toolName) && args.agent_id) {
		return { main: `${title} ${clip(args.agent_id)}`, detail: "" };
	}
	if (variant === "grouping" && (name === "agent" || name === "agents")) {
		const displayName = args.subagent_type ?? args.agent_type ?? args.agent;
		if (typeof displayName === "string" && displayName) {
			return { main: `${title} ${displayName}`, detail: "" };
		}
		return {
			main: value(name === "agent" ? "launch agent" : "launch agents", "description", "prompt"),
			detail: "",
		};
	}
	if (variant === "grouping" && (name === "get_subagent_result" || name === "steer_subagent")) {
		return {
			main: value(name === "get_subagent_result" ? "agent result" : "steer agent", "agent_id"),
			detail: "",
		};
	}
	if (variant === "default" && name === "agents") {
		return { main: value("launch agents", "description", "prompt"), detail: "" };
	}
	if (name === "skill") return { main: value("run skill", "name"), detail: "" };
	if (name === "enterplanmode" || name === "enter_plan_mode") {
		return { main: `${title} enable read-only planning`, detail: "" };
	}
	if (name === "exitplanmode" || name === "exit_plan_mode") {
		return { main: `${title} present plan`, detail: "" };
	}
	if (toolName === "read") {
		const details = [
			args.offset !== undefined ? `offset=${args.offset}` : "",
			args.limit !== undefined ? `limit=${args.limit}` : "",
		].filter(Boolean);
		const detail = details.length ? ` (${details.join(", ")})` : "";
		if (typeof args.path === "string" && args.path) {
			return pathSummary(variant === "grouping" ? "Read" : title, args.path, opts.cwd, detail);
		}
		return {
			main: variant === "grouping" ? "Read ..." : title,
			detail,
		};
	}
	if (name === "bash" || name === "powershell") return { main: value("...", "command"), detail: "" };
	if (name === "grep" || name === "find") {
		const pattern = clip(args.pattern || "...");
		const scope = typeof args.path === "string" && args.path ? ` in ${clip(args.path)}` : "";
		return { main: `${title} ${JSON.stringify(pattern)}${scope}`, detail: "" };
	}
	const preferredPath = args.path ?? args.file_path;
	if (typeof preferredPath === "string" && preferredPath) {
		return pathSummary(title, preferredPath, opts.cwd);
	}
	const preferred =
		args.command ?? args.query ?? args.question ?? args.pattern ?? args.url ?? args.name ??
		args.tool_use_id ?? args.toolCallId ?? args.id ?? args.message ?? args.description ?? args.prompt;
	return {
		main: preferred !== undefined && preferred !== null && typeof preferred !== "object"
			? `${title} ${clip(preferred)}` : title,
		detail: "",
	};
}
