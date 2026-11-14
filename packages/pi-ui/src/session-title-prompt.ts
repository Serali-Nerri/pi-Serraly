import type { UserMessage } from "@earendil-works/pi-ai";
import { parseSkillBlock, type SessionProjection } from "@earendil-works/pi-coding-agent";

// Codex's title instructions and recent-message framing, adapted to Pi transcripts.
// Pinned source and Apache-2.0 attribution: ../UPSTREAM.md.
const INSTRUCTIONS = "Generate a concise, single-line task title of at most 36 characters and under five words where possible. Start with an imperative verb. Capitalize only the first word unless the user's language, proper nouns, acronyms, or code terms require otherwise. Preserve ticket references exactly. Write in the user's language. Do not use quotes, markdown, or trailing punctuation. Do not answer the request.";
const RECENT_INSTRUCTIONS = `${INSTRUCTIONS}\nPrioritize the current task and latest substantive user request.`;
const MAX_PROMPT_BYTES = 960;
const MAX_SOURCE_CHARS = 4_000;

export interface TitlePrompt {
	instructions: string;
	input: string;
}

function boundedText(text: string, bytes: number, escape = false): string {
	let result = "";
	for (const character of text) {
		const next = escape ? character === "&" ? "&amp;" : character === "<" ? "&lt;" : character === ">" ? "&gt;" : character : character;
		bytes -= Buffer.byteLength(next);
		if (bytes < 0) break;
		result += next;
	}
	return result;
}

export function userText(content: UserMessage["content"]): string {
	let text = "";
	for (const part of typeof content === "string" ? [{ type: "text" as const, text: content }] : content) {
		if (part.type !== "text") continue;
		const skill = parseSkillBlock(part.text);
		text += `${text ? "\n" : ""}${skill ? skill.userMessage ?? "" : part.text}`.slice(0, MAX_SOURCE_CHARS - text.length);
		if (text.length >= MAX_SOURCE_CHARS) break;
	}
	text = text.replace(/[\uD800-\uDBFF]$/u, "").trim();
	return /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(text) ? text : "";
}

export function automaticTitlePrompt(text: string): TitlePrompt {
	const prefix = "User prompt:\n";
	return { instructions: INSTRUCTIONS, input: prefix + boundedText(text.trim(), MAX_PROMPT_BYTES - Buffer.byteLength(`${INSTRUCTIONS}\n\n${prefix}`)) };
}

function isCommentary(signature: string | undefined): boolean {
	if (!signature?.startsWith("{")) return false;
	try {
		const value: unknown = JSON.parse(signature);
		return value !== null && typeof value === "object" && "phase" in value && value.phase === "commentary";
	} catch { return false; }
}

export function recentTitlePrompt(messages: Readonly<SessionProjection["messages"]>): TitlePrompt | undefined {
	const recent: { role: "user" | "assistant"; text: string }[] = [];
	for (let index = messages.length - 1; index >= 0 && recent.length < 8; index--) {
		const message = messages[index]!;
		let text = "";
		if (message.role === "user") text = userText(message.content);
		else if (message.role === "assistant" && (message.stopReason === "stop" || message.stopReason === "length")) {
			for (const part of message.content) {
				if (part.type !== "text" || isCommentary(part.textSignature)) continue;
				text += `${text ? "\n" : ""}${part.text}`.slice(0, MAX_SOURCE_CHARS - text.length);
				if (text.length >= MAX_SOURCE_CHARS) break;
			}
			text = text.replace(/[\uD800-\uDBFF]$/u, "").trim();
		} else continue;
		if (text) recent.push({ role: message.role, text });
	}
	if (!recent.length) return undefined;
	recent.reverse();
	const prefix = "Recent conversation messages:\n<conversation>\n";
	const suffix = "\n</conversation>";
	const overhead = Buffer.byteLength(`${RECENT_INSTRUCTIONS}\n\n${prefix}${suffix}`)
		+ recent.length - 1 + recent.reduce((total, message) => total + Buffer.byteLength(`<message role="${message.role}"></message>`), 0);
	const remaining = Math.max(0, MAX_PROMPT_BYTES - overhead);
	const escaped = recent.map((message) => ({ ...message, text: boundedText(message.text, remaining, true) }));
	const truncate = escaped.reduce((total, message) => total + Buffer.byteLength(message.text), 0) > remaining;
	const perMessage = Math.floor(remaining / recent.length);
	const content = recent.map((message, index) => `<message role="${message.role}">${truncate ? boundedText(message.text, perMessage, true) : escaped[index]!.text}</message>`).join("\n");
	return { instructions: RECENT_INSTRUCTIONS, input: `${prefix}${content}${suffix}` };
}
