/**
 * Ported from OpenAI Codex `codex-rs/tui/src/app/recap_history.rs`
 * (Copyright 2025 OpenAI, Apache-2.0). Pi-specific changes: the session branch
 * replaces TUI history cells, every user message opens an exchange even when it
 * only carries images, only exchanges closed by a terminal assistant stop count
 * as completed, and every size limit is measured in UTF-8 bytes.
 */
import { contentText } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { HISTORY_MAX_BYTES } from "./prompt.ts";

/** Most completed exchanges kept for a recap. */
const MAX_EXCHANGES = 8;

const OMITTED_HISTORY = "[Earlier exchanges omitted]\n\n";
const EXCERPT_MARKER = "\n[... excerpted ...]\n";

/** Stop reasons that close an exchange; `toolUse` waits for another turn. */
const TERMINAL_STOP_REASONS: ReadonlySet<string> = new Set(["stop", "length", "error", "aborted"]);

export interface RecapHistory {
	/** Recent visible conversation, or "" when nothing visible can be recapped. */
	text: string;
	/** Completed exchanges on the whole branch, independent of the history window. */
	completed: number;
	/** True only when the branch holds no visible user or assistant text at all. */
	empty: boolean;
}

interface Exchange {
	/** A user message opened this exchange, even without visible text. */
	submitted: boolean;
	user: string;
	assistant: string;
	/** Distinguishes an unanswered request from an exchange already in progress. */
	answered: boolean;
	terminal: boolean;
}

interface HistoryBlock extends Exchange {
	label: string;
	pending: boolean;
}

export function buildHistory(branch: readonly SessionEntry[]): RecapHistory {
	const exchanges = collectExchanges(branch);
	const completed = exchanges.filter((exchange) => exchange.terminal && exchange.submitted);
	const blocks = completed
		.slice(-MAX_EXCHANGES)
		.map((exchange): HistoryBlock => ({ ...exchange, label: "User", pending: false }));
	const leading = exchanges[0];
	if (leading && !leading.submitted && leading.assistant)
		blocks.unshift({ ...leading, label: "Assistant", pending: false });
	const latest = exchanges.at(-1);
	if (latest && latest.submitted && !latest.answered)
		blocks.push({ ...latest, label: "Pending user request", pending: true });
	return {
		text: renderHistory(blocks),
		completed: completed.length,
		empty: !exchanges.some((exchange) => exchange.user.length > 0 || exchange.assistant.length > 0),
	};
}

/**
 * Every user submission opens an exchange containing the assistant replies up
 * to the next submission. Tool calls, tool output, and reasoning are dropped;
 * assistant text before the first request stays its own block.
 */
function collectExchanges(branch: readonly SessionEntry[]): Exchange[] {
	const exchanges: Exchange[] = [];
	let current: Exchange | undefined;
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const { message } = entry;
		if (message.role === "user") {
			const text = contentText(message.content).trim();
			current = { submitted: true, user: text, assistant: "", answered: false, terminal: false };
			exchanges.push(current);
			continue;
		}
		if (message.role !== "assistant") continue;
		const text = contentText(message.content).trim();
		if (!current) {
			current = { submitted: false, user: "", assistant: "", answered: true, terminal: false };
			exchanges.push(current);
		}
		current.answered = true;
		if (TERMINAL_STOP_REASONS.has(message.stopReason)) current.terminal = true;
		if (text) current.assistant = current.assistant ? `${current.assistant}\n\n${text}` : text;
	}
	return exchanges;
}

/**
 * Joins labeled exchanges within the byte budget. Whole old exchanges are
 * dropped first, keeping the newest answer and any pending request; only the
 * remaining exchanges are excerpted to their head and tail.
 */
function renderHistory(blocks: readonly HistoryBlock[]): string {
	const visibleBlocks = blocks.filter((block) => labelFields(block).length > 0);
	if (visibleBlocks.length === 0) return "";
	const texts = visibleBlocks.map(formatBlock);
	let bytes = joinedBytes(texts);
	if (bytes <= HISTORY_MAX_BYTES) return texts.join("\n\n");
	const retained = visibleBlocks.at(-1)?.pending ? 2 : 1;
	const oldestRetained = Math.max(0, visibleBlocks.length - retained);
	const dropLimit = HISTORY_MAX_BYTES - Buffer.byteLength(OMITTED_HISTORY);
	let start = 0;
	while (bytes > dropLimit && start < oldestRetained) {
		bytes -= Buffer.byteLength(texts[start] ?? "") + 2;
		start += 1;
	}
	const omission = start > 0 ? OMITTED_HISTORY : "";
	const budget = HISTORY_MAX_BYTES - Buffer.byteLength(omission);
	if (bytes <= budget) return omission + texts.slice(start).join("\n\n");
	return omission + excerptFields(visibleBlocks.slice(start), budget);
}

function formatBlock(block: HistoryBlock): string {
	return labelFields(block)
		.map(([label, text]) => `${label}: ${text}`)
		.join("\n\n");
}

/** Labeled text fields of one exchange, skipping fields without visible text. */
function labelFields(block: HistoryBlock): (readonly [string, string])[] {
	const fields: (readonly [string, string])[] = [];
	if (block.user) fields.push([block.label, block.user]);
	if (block.assistant) fields.push(["Assistant", block.assistant]);
	return fields;
}

/** Splits the byte budget across label and text fields, then excerpts each. */
function excerptFields(blocks: readonly HistoryBlock[], budget: number): string {
	const fields = blocks.flatMap(labelFields);
	const overhead =
		fields.reduce((total, [label]) => total + Buffer.byteLength(label) + 2, 0) + 2 * (fields.length - 1);
	let remaining = Math.max(0, budget - overhead);
	const parts = fields.map(([label, text], index) => {
		const share = Math.floor(remaining / (fields.length - index));
		const reserved = fields
			.slice(index + 1)
			.reduce((total, [, later]) => total + Math.min(Buffer.byteLength(later), share), 0);
		const body = excerpt(text, remaining - reserved);
		remaining -= Buffer.byteLength(body);
		return `${label}: ${body}`;
	});
	return parts.join("\n\n");
}

/** Byte length of `texts` joined by blank lines. */
function joinedBytes(texts: readonly string[]): number {
	return texts.reduce((total, text) => total + Buffer.byteLength(text), 2 * Math.max(0, texts.length - 1));
}

/** Keeps the head and tail of `text` within `maxBytes` without splitting characters. */
function excerpt(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text) <= maxBytes) return text;
	const contentBytes = Math.max(0, maxBytes - Buffer.byteLength(EXCERPT_MARKER));
	const headBytes = Math.floor(contentBytes / 2);
	return floorCharBoundary(text, headBytes) + EXCERPT_MARKER + tailWithinBytes(text, contentBytes - headBytes);
}

/** Keeps the longest prefix that still fits in `maxBytes`. */
function floorCharBoundary(text: string, maxBytes: number): string {
	let bytes = 0;
	let end = 0;
	for (const character of text) {
		const width = Buffer.byteLength(character);
		if (bytes + width > maxBytes) break;
		bytes += width;
		end += character.length;
	}
	return text.slice(0, end);
}

/** Keeps the longest suffix within `maxBytes`, walking only the retained tail. */
function tailWithinBytes(text: string, maxBytes: number): string {
	let bytes = 0;
	let start = text.length;
	while (start > 0) {
		let next = start - 1;
		const last = text.charCodeAt(next);
		if (last >= 0xdc00 && last <= 0xdfff && next > 0) {
			const first = text.charCodeAt(next - 1);
			if (first >= 0xd800 && first <= 0xdbff) next -= 1;
		}
		const width = Buffer.byteLength(text.slice(next, start));
		if (bytes + width > maxBytes) break;
		bytes += width;
		start = next;
	}
	return text.slice(start);
}
