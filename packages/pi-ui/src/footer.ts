import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	SessionEntry,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	stripTerminalSequences,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

type ContextSnapshot = { tokens: number | null; contextWindow: number; percent: number | null };
type ModelSnapshot = { provider: string; id: string };
type UsageTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
type FooterFactory = NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;

const footerOwners = new WeakMap<ExtensionContext["ui"], symbol>();
const MAX_TOOL_NAMES = 16;
const MAX_RECENT_ASSISTANTS = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function finiteOrZero(value: unknown): number {
	return finite(value) ?? 0;
}

function nonNegative(value: unknown): number {
	return Math.max(0, finiteOrZero(value));
}

function sanitize(value: unknown): string {
	if (typeof value !== "string") return "";
	return stripTerminalSequences(value)
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function formatTokens(value: number): string {
	const n = Math.max(0, finiteOrZero(value));
	if (n < 1_000) return n.toString();
	if (n < 10_000) return `${(n / 1_000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
	if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.floor(Math.max(0, finiteOrZero(ms)) / 1_000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;
	const minutes = totalMinutes % 60;
	return `${Math.floor(totalMinutes / 60)}h ${minutes}m ${seconds}s`;
}

function formatCwd(cwd: string): string {
	const home = process.env["HOME"] || process.env["USERPROFILE"];
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const rel = relative(resolvedHome, resolvedCwd);
	const insideHome = rel === ""
		|| (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	if (!insideHome) return cwd;
	return rel === "" ? "~" : `~${sep}${rel}`;
}

/** Keep the home/root marker and final path segment when the available width is tight. */
function shortenPath(path: string, maxWidth: number): string {
	if (visibleWidth(path) <= maxWidth) return path;
	const separator = path.includes("\\") ? "\\" : "/";
	const parts = path.split(/[\\/]/).filter(Boolean);
	const tail = parts.at(-1);
	if (!tail) return truncateToWidth(path, maxWidth, "…");
	const head = path.startsWith(separator) ? separator : (parts[0] ?? "");
	const compact = head === tail ? tail : `${head}${separator}…${separator}${tail}`;
	return truncateToWidth(compact, maxWidth, "…");
}

function captureModel(model: ExtensionContext["model"]): ModelSnapshot | undefined {
	if (!model) return undefined;
	const id = sanitize(model.id);
	if (!id) return undefined;
	return { provider: sanitize(model.provider), id };
}

function captureSessionName(ctx: ExtensionContext): string | undefined {
	try {
		const name = ctx.sessionManager.getSessionName();
		return sanitize(name) || undefined;
	} catch {
		return undefined;
	}
}

function captureContext(ctx: ExtensionContext): ContextSnapshot | undefined {
	try {
		const usage = ctx.getContextUsage();
		if (!usage) return undefined;
		const contextWindow = finite(usage.contextWindow);
		if (contextWindow === undefined || contextWindow <= 0) return undefined;
		return {
			tokens: finite(usage.tokens) ?? null,
			contextWindow,
			percent: finite(usage.percent) ?? null,
		};
	} catch {
		return undefined;
	}
}

function readUsage(value: unknown): UsageTotals | undefined {
	if (!isRecord(value)) return undefined;
	const costValue = isRecord(value["cost"]) ? value["cost"] : undefined;
	const explicitCost = costValue ? finite(costValue["total"]) : undefined;
	const splitCost = costValue
		? nonNegative(costValue["input"]) + nonNegative(costValue["output"])
			+ nonNegative(costValue["cacheRead"]) + nonNegative(costValue["cacheWrite"])
		: 0;
	return {
		input: nonNegative(value["input"]),
		output: nonNegative(value["output"]),
		cacheRead: nonNegative(value["cacheRead"]),
		cacheWrite: nonNegative(value["cacheWrite"]),
		cost: explicitCost === undefined ? splitCost : Math.max(0, explicitCost),
	};
}

function contentFingerprint(content: unknown): string {
	let serialized: string;
	try {
		serialized = typeof content === "string" ? content : JSON.stringify(content) ?? String(content);
	} catch {
		serialized = String(content);
	}
	let hash = 2_166_136_261;
	for (let index = 0; index < serialized.length; index++) {
		hash ^= serialized.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return `${(hash >>> 0).toString(36)}:${serialized.length.toString(36)}`;
}

function assistantSignature(message: Record<string, unknown>, usage: UsageTotals): string {
	return [
		message["timestamp"],
		message["provider"],
		message["model"],
		message["responseId"],
		message["stopReason"],
		contentFingerprint(message["content"]),
		usage.input,
		usage.output,
		usage.cacheRead,
		usage.cacheWrite,
		usage.cost,
	].map((part) => String(part)).join("\u0000");
}

function alignRight(left: string, right: string, width: number, theme: Theme): string {
	if (width <= 0) return "";
	let rightText = right;
	if (visibleWidth(rightText) > width) {
		rightText = truncateToWidth(rightText, width, "");
	}
	if (!left) return rightText;
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(rightText);
	if (leftWidth + rightWidth + 1 <= width) {
		return left + " ".repeat(width - leftWidth - rightWidth) + rightText;
	}
	if (!rightText) return truncateToWidth(left, width, theme.fg("dim", "…"));
	// Keep a useful piece of both sides on very narrow terminals instead of
	// letting the right-hand statistics erase the model/cwd entirely.
	const leftReserve = Math.min(leftWidth, Math.floor((width - 1) / 2));
	const rightBudget = Math.max(1, width - leftReserve - 1);
	rightText = truncateToWidth(rightText, rightBudget, "");
	const available = width - visibleWidth(rightText) - 1;
	if (available <= 0) return rightText;
	const shortened = truncateToWidth(left, available, theme.fg("dim", "…"));
	return shortened ? `${shortened} ${rightText}` : rightText;
}

function renderContext(theme: Theme, context: ContextSnapshot | undefined): string {
	if (!context) return "";
	const window = formatTokens(context.contextWindow);
	if (context.percent !== null) {
		const color = context.percent >= 90 ? "warning" : "accent";
		const ratio = context.tokens === null ? "" : ` ${formatTokens(context.tokens)}/${window}`;
		return `${theme.fg("muted", "ctx")} ${theme.fg(color, `${context.percent.toFixed(1)}%`)}${theme.fg("dim", ratio)}`;
	}
	if (context.tokens !== null) {
		return `${theme.fg("muted", "ctx")} ${theme.fg("accent", `${formatTokens(context.tokens)}/${window}`)}`;
	}
	return `${theme.fg("muted", "ctx")} ${theme.fg("muted", `?/${window}`)}`;
}

function renderStats(theme: Theme, usage: UsageTotals, latestCacheHitRate: number | undefined): string {
	const cost = Math.max(0, finiteOrZero(usage.cost));
	const parts: string[] = [];
	if (usage.input) parts.push(theme.fg("accent", `↑${formatTokens(usage.input)}`));
	if (usage.output) parts.push(theme.fg("success", `↓${formatTokens(usage.output)}`));
	if (usage.cacheRead) parts.push(theme.fg("muted", `R${formatTokens(usage.cacheRead)}`));
	if (usage.cacheWrite) parts.push(theme.fg("muted", `W${formatTokens(usage.cacheWrite)}`));
	if ((usage.cacheRead > 0 || usage.cacheWrite > 0) && latestCacheHitRate !== undefined) {
		parts.push(theme.fg("muted", `cache ${latestCacheHitRate.toFixed(1)}%`));
	}
	if (cost) parts.push(theme.fg("warning", `$${cost.toFixed(3)}`));
	return parts.join(" ");
}

function extensionStatusLines(
	footerData: ReadonlyFooterDataProvider,
	theme: Theme,
	width: number,
): string[] {
	let values: Array<[string, string]>;
	try {
		values = Array.from(footerData.getExtensionStatuses().entries());
	} catch {
		return [];
	}
	const statuses = values
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([, text]) => sanitize(text))
		.filter((text) => text.length > 0);
	if (statuses.length === 0) return [];
	const separator = ` ${theme.fg("dim", "·")} `;
	const line = statuses.map((status) => theme.fg("muted", status)).join(separator);
	return wrapTextWithAnsi(line, width).map((part) => truncateToWidth(part, width, ""));
}

/**
 * Install a compact TUI footer. The caller owns the footer's session lifetime
 * and must invoke the returned cleanup idempotently on shutdown/replacement.
 */
export function installFooter(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	onMount: (tui: TUI) => void,
): () => void {
	const ui = ctx.ui;
	if (!ui || typeof ui.setFooter !== "function") return () => {};

	const owner = Symbol("pi-ui-footer");
	footerOwners.set(ui, owner);
	let installed = true;
	let cleanedUp = false;
	let requestRender: (() => void) | undefined;
	let componentGeneration = 0;
	let latestDisposed = false;
	let branchUnsubscribe: (() => void) | undefined;
	let interval: ReturnType<typeof setInterval> | undefined;

	let cwd = sanitize(ctx.cwd);
	let model = captureModel(ctx.model);
	let thinkingLevel = typeof ctx.thinkingLevel === "string" && ctx.thinkingLevel
		? ctx.thinkingLevel
		: undefined;
	let sessionName = captureSessionName(ctx);
	let contextUsage = captureContext(ctx);
	let totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let latestCacheHitRate: number | undefined;
	let seenMessages = new WeakSet<object>();
	const recentAssistantSignatures = new Set<string>();
	let activityActive = false;
	let activityStartedAt: number | undefined;
	let finalElapsedMs: number | undefined;
	const activeTools = new Map<string, string>();

	function addUsage(usage: UsageTotals): void {
		totals.input += usage.input;
		totals.output += usage.output;
		totals.cacheRead += usage.cacheRead;
		totals.cacheWrite += usage.cacheWrite;
		totals.cost += usage.cost;
	}

	function rememberAssistantSignature(signature: string): void {
		if (recentAssistantSignatures.has(signature)) return;
		recentAssistantSignatures.add(signature);
		if (recentAssistantSignatures.size > MAX_RECENT_ASSISTANTS) {
			const oldest = recentAssistantSignatures.values().next().value;
			if (oldest !== undefined) recentAssistantSignatures.delete(oldest);
		}
	}

	function recordMessage(message: unknown, rebuilding: boolean): void {
		if (!isRecord(message)) return;
		const usage = readUsage(message["usage"]);
		if (!usage) return;
		const role = message["role"];
		if (role === "assistant") {
			if (!rebuilding) {
				if (seenMessages.has(message)) return;
				seenMessages.add(message);
				const signature = assistantSignature(message, usage);
				if (recentAssistantSignatures.has(signature)) return;
				rememberAssistantSignature(signature);
			} else {
				seenMessages.add(message);
			}
			const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
			latestCacheHitRate = promptTokens > 0 ? usage.cacheRead / promptTokens * 100 : undefined;
			addUsage(usage);
			return;
		}
		if (role === "toolResult") {
			if (!rebuilding) {
				if (seenMessages.has(message)) return;
				seenMessages.add(message);
			}
			addUsage(usage);
			seenMessages.add(message);
		}
	}

	function rebuildUsage(entries: readonly SessionEntry[]): void {
		totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
		latestCacheHitRate = undefined;
		seenMessages = new WeakSet<object>();
		recentAssistantSignatures.clear();
		for (const entry of entries) {
			if (!isRecord(entry)) continue;
			if (entry["type"] === "message") {
				recordMessage(entry["message"], true);
				continue;
			}
			if (entry["type"] === "usage" || entry["type"] === "compaction" || entry["type"] === "branch_summary") {
				const usage = readUsage(entry["usage"]);
				if (usage) addUsage(usage);
			}
		}
	}

	function readEntries(sessionManager: ExtensionContext["sessionManager"]): readonly SessionEntry[] {
		try {
			const entries = sessionManager.getEntries();
			return Array.isArray(entries) ? entries : [];
		} catch {
			return [];
		}
	}

	function notifyRender(): void {
		if (!installed || !requestRender) return;
		try {
			requestRender();
		} catch {
			// The host may already have stopped the TUI; cleanup will release the rest.
		}
	}

	function stopTimer(): void {
		if (interval === undefined) return;
		clearInterval(interval);
		interval = undefined;
	}

	function ensureTimer(): void {
		if (interval !== undefined || !installed || !activityActive || !requestRender) return;
		interval = setInterval(() => {
			if (!installed || !activityActive) {
				stopTimer();
				return;
			}
			notifyRender();
		}, 1_000);
		if (typeof interval === "object" && interval !== null && "unref" in interval
			&& typeof interval.unref === "function") {
			interval.unref();
		}
	}

	function startActivity(): void {
		if (!activityActive) {
			activityActive = true;
			activityStartedAt = Date.now();
			finalElapsedMs = undefined;
		}
		ensureTimer();
		notifyRender();
	}

	function settleActivity(): void {
		if (!activityActive) {
			stopTimer();
			return;
		}
		const startedAt = activityStartedAt ?? Date.now();
		finalElapsedMs = Math.max(0, Date.now() - startedAt);
		activityActive = false;
		activityStartedAt = undefined;
		activeTools.clear();
		stopTimer();
		notifyRender();
	}

	function addTool(toolCallId: unknown, toolName: unknown): void {
		if (typeof toolCallId !== "string" || !toolCallId) return;
		const name = sanitize(toolName);
		if (!name) return;
		if (!activeTools.has(toolCallId) && activeTools.size >= MAX_TOOL_NAMES) {
			const oldest = activeTools.keys().next().value;
			if (oldest !== undefined) activeTools.delete(oldest);
		}
		activeTools.set(toolCallId, name);
		notifyRender();
	}

	function removeTool(toolCallId: unknown): void {
		if (typeof toolCallId !== "string") return;
		if (activeTools.delete(toolCallId)) notifyRender();
	}

	function renderActivity(theme: Theme, width: number): string | undefined {
		if (activityActive) {
			const elapsed = theme.fg(
				"dim",
				formatDuration(activityStartedAt === undefined ? 0 : Date.now() - activityStartedAt),
			);
			const head = `${theme.fg("accent", "●")} ${theme.fg("accent", "working")}`;
			const separator = theme.fg("dim", " · ");
			const suffix = `${separator}${elapsed}`;
			const tools = Array.from(activeTools.values()).filter((name) => name.length > 0);
			if (tools.length === 0) {
				const line = head + suffix;
				if (visibleWidth(line) <= width) return line;
				return truncateToWidth(`${theme.fg("accent", "●")} ${elapsed}`, width, "…");
			}
			const toolText = theme.fg("muted", tools.join(", "));
			const full = `${head}${separator}${toolText}${suffix}`;
			if (visibleWidth(full) <= width) return full;
			const available = width - visibleWidth(head) - visibleWidth(separator) - visibleWidth(suffix);
			if (available > 0) {
				const shortened = truncateToWidth(toolText, available, theme.fg("dim", "…"));
				return `${head}${separator}${shortened}${suffix}`;
			}
			return truncateToWidth(`${head}${suffix}`, width, "…");
		}
		if (finalElapsedMs !== undefined) {
			const elapsed = theme.fg("text", formatDuration(finalElapsedMs));
			const line = `${theme.fg("success", "✓")} ${theme.fg("muted", "done")} ${elapsed}`;
			if (visibleWidth(line) <= width) return line;
			return truncateToWidth(`${theme.fg("success", "✓")} ${elapsed}`, width, "…");
		}
		return undefined;
	}

	const factory: FooterFactory = (tui, theme, footerData) => {
		const generation = ++componentGeneration;
		latestDisposed = false;
		requestRender = () => tui.requestRender();
		onMount(tui);

		let disposed = false;
		let unsubscribe = () => {};
		try {
			unsubscribe = footerData.onBranchChange(() => {
				if (!disposed) notifyRender();
			});
		} catch {
			// A host without branch notifications still renders cwd, model and usage.
		}
		branchUnsubscribe?.();
		branchUnsubscribe = unsubscribe;
		ensureTimer();

		return {
			invalidate() {
				// Rendering derives everything from the current bounded snapshot.
			},
			dispose() {
				if (disposed) return;
				disposed = true;
				unsubscribe();
				if (generation !== componentGeneration) return;
				latestDisposed = true;
				branchUnsubscribe = undefined;
				requestRender = undefined;
				stopTimer();
			},
			render(width: number): string[] {
				if (disposed || !installed) return [];
				const allowed = Math.max(0, Math.floor(width));
				if (allowed === 0) return [];

				let branch: string | undefined;
				try {
					branch = sanitize(footerData.getGitBranch()) || undefined;
				} catch {
					branch = undefined;
				}

				const firstParts: string[] = [];
				if (cwd) firstParts.push(theme.fg("accent", shortenPath(formatCwd(cwd), 44)));
				if (branch) firstParts.push(theme.fg("muted", `git:${branch}`));
				if (sessionName) firstParts.push(theme.fg("dim", `session:${sessionName}`));
				const firstLeft = firstParts.join(theme.fg("dim", " · "));
				const first = alignRight(firstLeft, renderContext(theme, contextUsage), allowed, theme);

				const modelText = model
					? model.provider ? `${model.provider}/${model.id}` : model.id
					: "no-model";
				const leftParts = [theme.fg("text", modelText)];
				if (thinkingLevel) leftParts.push(theme.fg("muted", `thinking ${thinkingLevel}`));
				const secondLeft = leftParts.join(theme.fg("dim", " · "));
				const second = alignRight(secondLeft, renderStats(theme, totals, latestCacheHitRate), allowed, theme);

				const lines = [first, second];
				const activity = renderActivity(theme, allowed);
				if (activity) lines.push(truncateToWidth(activity, allowed, "…"));
				lines.push(...extensionStatusLines(footerData, theme, allowed));
				return lines;
			},
		};
	};

	const unsubscribers: Array<() => void> = [];

	function cleanup(): void {
		if (cleanedUp) return;
		cleanedUp = true;
		installed = false;
		stopTimer();
		for (const off of unsubscribers.splice(0)) {
			try {
				off();
			} catch {
				// Keep releasing the remaining subscriptions.
			}
		}
		branchUnsubscribe?.();
		branchUnsubscribe = undefined;
		requestRender = undefined;
		const ownsFooter = footerOwners.get(ui) === owner && !latestDisposed;
		if (footerOwners.get(ui) === owner) footerOwners.delete(ui);
		componentGeneration++;
		if (ownsFooter) {
			try {
				ui.setFooter(undefined);
			} catch {
				// The host is already shutting down.
			}
		}
	}

	try {
		rebuildUsage(readEntries(ctx.sessionManager));
		ui.setFooter(factory);

		unsubscribers.push(pi.on("before_agent_start", () => startActivity()));
		unsubscribers.push(pi.on("agent_start", () => startActivity()));
		unsubscribers.push(pi.on("agent_settled", (_event, eventCtx) => {
			settleActivity();
			contextUsage = captureContext(eventCtx);
			notifyRender();
		}));
		unsubscribers.push(pi.on("message_end", (event, eventCtx) => {
			recordMessage(event.message, false);
			contextUsage = captureContext(eventCtx);
			notifyRender();
		}));
		unsubscribers.push(pi.on("tool_execution_start", (event) => addTool(event.toolCallId, event.toolName)));
		unsubscribers.push(pi.on("tool_execution_end", (event) => removeTool(event.toolCallId)));
		unsubscribers.push(pi.on("model_select", (event, eventCtx) => {
			model = captureModel(event.model);
			contextUsage = captureContext(eventCtx);
			notifyRender();
		}));
		unsubscribers.push(pi.on("thinking_level_select", (event) => {
			thinkingLevel = typeof event.level === "string" && event.level ? event.level : undefined;
			notifyRender();
		}));
		unsubscribers.push(pi.on("session_info_changed", (event) => {
			sessionName = sanitize(event.name) || undefined;
			notifyRender();
		}));
		unsubscribers.push(pi.on("session_tree", (_event, eventCtx) => {
			rebuildUsage(readEntries(eventCtx.sessionManager));
			contextUsage = captureContext(eventCtx);
			notifyRender();
		}));
		unsubscribers.push(pi.on("session_compact", (_event, eventCtx) => {
			rebuildUsage(readEntries(eventCtx.sessionManager));
			contextUsage = captureContext(eventCtx);
			notifyRender();
		}));
	} catch (error) {
		cleanup();
		throw error;
	}

	return cleanup;
}
