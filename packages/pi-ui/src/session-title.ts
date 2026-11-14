import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { clampThinkingLevel, cleanupSessionResources } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { UiConfig } from "./config.js";
import { normalizeSessionName, showRenamePrompt, type TitleSuggestion } from "./rename-prompt.js";
import { automaticTitlePrompt, recentTitlePrompt, userText, type TitlePrompt } from "./session-title-prompt.js";

const ENTRY_TYPE = "pi-ui-session-title-v1";
const MAX_INPUT = 4_000;
const MAX_TITLE = 36;
const TIMEOUT_MS = 20_000;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const quotePairs = new Map([["\"", "\""], ["'", "'"], ["“", "”"], ["‘", "’"], ["«", "»"], ["「", "」"], ["『", "』"]]);

type Ownership = { sessionId: string; nameEntryId: string; phase: "fallback" | "complete" };
type Session = {
	manager: ExtensionContext["sessionManager"];
	registry: ExtensionContext["modelRegistry"];
	model: ExtensionContext["model"];
	notify: ExtensionContext["ui"]["notify"];
	getConfig: () => UiConfig;
	settings: string;
	ownership: Ownership | undefined;
	manual: boolean;
};
type Request = { cancel(): void; result: Promise<TitleSuggestion> };

function title(text: string): string {
	let plain = stripVTControlCharacters(text.slice(0, MAX_INPUT))
		.replace(/```[^\n]*\n([\s\S]*?)\n?```/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/(^|\n)[ \t]*(?:#{1,6}[ \t]+|>[ \t]*|[-+*][ \t]+)/g, "$1")
		.replace(/[\p{Cc}\p{Cf}]/gu, (character) => character === "\u200c" || character === "\u200d" ? character : " ")
		.replace(/\s+/gu, " ")
		.trim();
	let previous: string;
	do {
		previous = plain;
		plain = plain.replace(/[.!?,;:…。！？、，；：]+$/u, "").trim();
		if (plain.length > 1 && quotePairs.get(plain[0]!) === plain.at(-1)) plain = plain.slice(1, -1).trim();
		plain = plain.replace(/(?<![\p{L}\p{N}_`])(\*{1,3}|_{1,3}|~~)(?=\S)(.*?\S)\1(?![\p{L}\p{N}_`])/gu, "$2").trim();
	} while (plain !== previous);
	plain = plain.replace(/(`+)([^`]+)\1/g, "$2").replace(/[.!?,;:…。！？、，；：]+$/u, "").trim();
	let result = "";
	let characters = 0;
	for (const { segment } of graphemes.segment(plain)) {
		const length = [...segment].length;
		if (characters + length > MAX_TITLE) break;
		characters += length;
		result += segment;
	}
	return result.replace(/[.!?,;:…。！？、，；：\s]+$/u, "");
}

function readOwnership(entries: SessionEntry[], sessionId: string): Ownership | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
		const data: unknown = entry.data;
		if (!data || typeof data !== "object") continue;
		const value = data as Record<string, unknown>;
		if (value["sessionId"] === sessionId && typeof value["nameEntryId"] === "string"
			&& (value["phase"] === "fallback" || value["phase"] === "complete")) {
			return { sessionId, nameEntryId: value["nameEntryId"], phase: value["phase"] };
		}
	}
	return undefined;
}

function settings(config: UiConfig): string {
	return JSON.stringify([config.autoSessionName, config.sessionNameModel?.provider, config.sessionNameModel?.id]);
}

function cleanup(sessionId: string): void {
	try { cleanupSessionResources(sessionId); }
	catch { /* One provider's cleanup must not interrupt session replacement or a manual rename. */ }
}

/** Independent, session-scoped naming; no context or title request enters the agent conversation. */
export function registerSessionTitle(pi: ExtensionAPI): { start(ctx: ExtensionContext, getConfig: () => UiConfig): void; refresh(): void; stop(): void } {
	let active: Session | undefined;
	let pending: Request | undefined;
	let renameDialog: AbortController | undefined;
	let writing = false;
	const cancel = (): void => {
		const request = pending;
		pending = undefined;
		request?.cancel();
		renameDialog?.abort();
		renameDialog = undefined;
	};
	const stop = (): void => { active = undefined; cancel(); };
	const latestName = (session: Session) => session.manager.getEntries().findLast((entry) => entry.type === "session_info");
	const ownsFallback = (session: Session): boolean => !session.manual && session.ownership?.phase === "fallback"
		&& latestName(session)?.id === session.ownership.nameEntryId;

	function saveName(session: Session, name: string, phase: Ownership["phase"]): void {
		// Pi appends session_info synchronously, but extension notifications may arrive after the setter returns.
		writing = true;
		try { pi.setSessionName(name); }
		finally { writing = false; }
		const entry = latestName(session);
		if (!entry || session.manager.getSessionName() !== name) return;
		session.ownership = { sessionId: session.manager.getSessionId(), nameEntryId: entry.id, phase };
		pi.appendEntry<Ownership>(ENTRY_TYPE, session.ownership);
	}

	function requestTitle(session: Session, prompt: TitlePrompt): Request {
		const config = session.getConfig();
		const model = config.sessionNameModel ? session.registry.find(config.sessionNameModel.provider, config.sessionNameModel.id) : session.model;
		if (!model) return { cancel() {}, result: Promise.resolve({ error: "The naming model is unavailable. Choose a model in /ui." }) };
		const controller = new AbortController();
		const sessionId = randomUUID();
		let cancelled!: () => void;
		const cancellation = new Promise<undefined>((resolve) => { cancelled = () => resolve(undefined); });
		let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; cancelRequest(); }, TIMEOUT_MS);
		const cancelRequest = (): void => { clearTimeout(timer); controller.abort(); cancelled(); cleanup(sessionId); };
		const result = (async (): Promise<TitleSuggestion> => {
			try {
				const reasoning = clampThinkingLevel(model, "minimal");
				const maxTokens = reasoning === "off" ? 256 : 2_048;
				const result = session.registry.streamSimple(model, {
					messages: [
						{ role: "system", content: prompt.instructions, timestamp: Date.now() },
						{ role: "user", content: prompt.input, timestamp: Date.now() },
					],
				}, {
					signal: controller.signal, sessionId, maxTokens: Math.min(maxTokens, model.maxTokens || maxTokens),
					...(reasoning === "off" ? {} : { reasoning, thinkingBudgets: { minimal: 1_024, low: 1_024, medium: 1_024, high: 1_024 } }),
					timeoutMs: TIMEOUT_MS, maxRetries: 0, maxRetryDelayMs: 0,
					cacheRetention: "none", disableContinuation: true, transport: "sse",
				}).result();
				// Providers may finish after cancellation; release only this request's resources again then.
				void result.then(() => cleanup(sessionId), () => cleanup(sessionId));
				const response = await Promise.race([result, cancellation]);
				if (!response || controller.signal.aborted) return timedOut ? { error: "Naming timed out. You can enter a name manually." } : {};
				if (response.stopReason !== "stop" && response.stopReason !== "length") {
					return { error: "Could not generate a title. Check the naming model in /ui." };
				}
				const name = title(response.content.filter((block) => block.type === "text").map((block) => block.text).join(" "));
				return name ? { title: name } : { error: "No title was returned. You can enter a name manually." };
			} catch {
				return controller.signal.aborted ? {} : { error: "Could not generate a title. Check the naming model in /ui." };
			} finally { cancelRequest(); }
		})();
		return { cancel: cancelRequest, result };
	}

	async function generate(session: Session, text: string): Promise<void> {
		const request = requestTitle(session, automaticTitlePrompt(text));
		pending = request;
		try {
			const result = await request.result;
			if (active !== session || pending !== request || !ownsFallback(session)) return;
			if (result.title) saveName(session, result.title, "complete");
			else if (result.error) session.notify(`${result.error} Keeping the first-message title.`, "warning");
		} catch {
			if (active === session && pending === request) session.notify("Could not save the generated title. Use /rename to name the session.", "warning");
		} finally {
			if (pending === request) pending = undefined;
		}
	}

	function maybeStart(retry = false, candidate = ""): void {
		const session = active;
		if (!session || pending || renameDialog || session.manual) return;
		const config = session.getConfig();
		if (!config.autoSessionName) return;
		if (session.ownership ? !retry || !ownsFallback(session) : Boolean(session.manager.getSessionName())) return;
		let text = "";
		for (const entry of session.manager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "user") {
				text = userText(entry.message.content);
				if (text) break;
			}
		}
		text ||= candidate;
		if (!title(text)) return;
		if (!session.ownership) saveName(session, title(text), "fallback");
		if (!ownsFallback(session)) return;
		void generate(session, text);
	}

	pi.registerCommand("rename", {
		description: "Rename this session; omit the name for an editable suggestion from recent conversation",
		handler: async (args, ctx) => {
			const name = normalizeSessionName(args);
			if (args.trim()) {
				if (!name) { ctx.ui.notify("Session name cannot be empty.", "warning"); return; }
				cancel();
				if (active) active.manual = true;
				pi.setSessionName(name);
				return;
			}
			const session = active;
			if (!session || ctx.mode !== "tui") {
				ctx.ui.notify("Open /rename in the TUI for a suggestion, or use /rename <name>.", "warning");
				return;
			}
			cancel();
			const dialog = new AbortController();
			renameDialog = dialog;
			const originalNameEntry = latestName(session)?.id;
			const prompt = recentTitlePrompt(session.manager.buildSessionProjection().messages);
			const request = prompt ? requestTitle(session, prompt) : undefined;
			pending = request;
			try {
				const name = await showRenamePrompt(ctx.ui, session.manager.getSessionName() ?? "", request?.result, dialog.signal);
				if (name === undefined || dialog.signal.aborted || active !== session || latestName(session)?.id !== originalNameEntry) return;
				session.manual = true;
				pi.setSessionName(name);
			} finally {
				if (renameDialog === dialog) renameDialog = undefined;
				if (pending === request) pending = undefined;
				request?.cancel();
				dialog.abort();
			}
		},
	});

	pi.on("message_end", (event) => {
		if (active && !active.ownership && !active.manual && !pending && event.message.role === "user" && active.getConfig().autoSessionName) maybeStart(false, userText(event.message.content));
	});
	pi.on("model_select", (event) => { if (active) active.model = event.model; });
	pi.on("session_info_changed", () => {
		if (!active || writing || latestName(active)?.id === active.ownership?.nameEntryId) return;
		active.manual = true;
		cancel();
	});
	pi.on("session_before_tree", cancel);
	pi.on("session_tree", () => { cancel(); maybeStart(); });
	pi.on("session_shutdown", stop);
	return {
		start(ctx, getConfig) {
			stop();
			if (!ctx.hasUI || ctx.mode !== "tui") return;
			const { sessionManager: manager, modelRegistry: registry, model, ui: { notify } } = ctx;
			// The native session title is global across branches, so ownership/attempts are too.
			const ownership = readOwnership(manager.getEntries(), manager.getSessionId());
			active = { manager, registry, model, notify, getConfig, settings: settings(getConfig()), ownership, manual: !ownership && Boolean(manager.getSessionName()) };
			maybeStart();
		},
		refresh() {
			if (!active) return;
			const next = settings(active.getConfig());
			const changed = next !== active.settings;
			active.settings = next;
			if (changed) cancel();
			maybeStart(changed);
		},
		stop,
	};
}
