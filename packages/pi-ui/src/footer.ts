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
import { emptyGitStatus, readGitStatus, renderGitStatus } from "./git.js";

type ContextSnapshot = { tokens: number | null; contextWindow: number; percent: number | null };
type ModelSnapshot = { provider: string; id: string };
type UsageTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
type FooterFactory = NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;

const footerOwners = new WeakMap<ExtensionContext["ui"], symbol>();
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

	const gitCwd = ctx.cwd;
	const cwd = sanitize(gitCwd);
	let git = emptyGitStatus();
	let gitRequest: AbortController | undefined;
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

	function refreshGit(): void {
		if (!installed || latestDisposed) return;
		gitRequest?.abort();
		const request = new AbortController();
		gitRequest = request;
		void readGitStatus(gitCwd, request.signal).then((status) => {
			if (request.signal.aborted) return;
			gitRequest = undefined;
			git = status;
			notifyRender();
		});
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
				if (disposed) return;
				refreshGit();
				notifyRender();
			});
		} catch {
			// Tool completion and settlement still refresh Git without branch notifications.
		}
		branchUnsubscribe?.();
		branchUnsubscribe = unsubscribe;
		refreshGit();

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
				gitRequest?.abort();
				gitRequest = undefined;
				branchUnsubscribe = undefined;
				requestRender = undefined;
			},
			render(width: number): string[] {
				if (disposed || !installed) return [];
				const allowed = Math.max(0, Math.floor(width));
				if (allowed === 0) return [];

				const firstParts: string[] = [];
				if (cwd) firstParts.push(theme.fg("accent", shortenPath(formatCwd(cwd), 44)));
				const gitText = renderGitStatus(theme, git);
				if (gitText) firstParts.push(gitText);
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

				return [first, second, ...extensionStatusLines(footerData, theme, allowed)];
			},
		};
	};

	const unsubscribers: Array<() => void> = [];

	function cleanup(): void {
		if (cleanedUp) return;
		cleanedUp = true;
		installed = false;
		gitRequest?.abort();
		gitRequest = undefined;
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

		unsubscribers.push(pi.on("agent_settled", (_event, eventCtx) => {
			contextUsage = captureContext(eventCtx);
			refreshGit();
			notifyRender();
		}));
		unsubscribers.push(pi.on("tool_execution_end", refreshGit));
		unsubscribers.push(pi.on("message_end", (event, eventCtx) => {
			recordMessage(event.message, false);
			contextUsage = captureContext(eventCtx);
			notifyRender();
		}));
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
