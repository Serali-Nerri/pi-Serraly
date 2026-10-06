import { stripTerminalSequences } from "@earendil-works/pi-tui";

const OMITTED = "\n[… content omitted by reference byte budget]";

/** Prefix clipping at code-point boundaries; the omission notice is inside the budget. */
export function boundedText(text: string, bytes: number): string {
	// UTF-8 encoding replaces any lone surrogates originating in escaped JSON strings.
	const valid = Buffer.from(text, "utf8").toString("utf8");
	if (Buffer.byteLength(valid) <= bytes) return valid;
	const available = Math.max(0, bytes - Buffer.byteLength(OMITTED));
	let used = 0;
	let end = 0;
	for (const point of valid) {
		const size = Buffer.byteLength(point);
		if (used + size > available) break;
		used += size;
		end += point.length;
	}
	return valid.slice(0, end) + OMITTED;
}

/** Metadata is a single plain terminal-safe line, never a control sequence or bidi override. */
export function plainLabel(value: string): string {
	return stripTerminalSequences(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim();
}
