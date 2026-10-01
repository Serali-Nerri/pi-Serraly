// Adapted from pi-cc-extensions v0.8.69; see THIRD_PARTY_NOTICES.md.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fixBareUrlBoundaries } from "./url-boundaries.ts";

interface Fence {
	marker: "`" | "~";
	length: number;
}

type Span = [number, number];
// Native HTML block forms that may interrupt an existing paragraph.
const HTML_INTERRUPT_RE = /^ {0,3}(?:<(?:script|pre|style|textarea)(?:[ \t]|>)|<!--|<\?|<![A-Z]|<!\[CDATA\[|<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]|\/?>))/i;
const LAZY_INTERRUPT_RE = /^ {0,3}(?:>|(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)|#{1,6}(?:[ \t]|$)|`{3,}|~{3,}|(?:=+|-+)[ \t]*$|(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$)/;
const HTML_COMPLETE_TAG_RE = /^ {0,3}(?:<(?!script|pre|style|textarea)[a-z][\w-]*(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)*? *\/?>|<\/(?!script|pre|style|textarea)[a-z][\w-]*\s*>)[ \t]*$/i;
type HtmlEnd = RegExp | "blank";
function htmlBlockEnd(content: string, paragraph: boolean): HtmlEnd | null {
	const raw = /^ {0,3}<(script|pre|style|textarea)[\s>]/i.exec(content);
	if (raw) return new RegExp(`</${raw[1]}>`, "i");
	if (/^ {0,3}<!--/.test(content)) return /-->/;
	if (/^ {0,3}<\?/.test(content)) return /\?>/;
	if (/^ {0,3}<!\[CDATA\[/.test(content)) return /\]\]>/;
	if (/^ {0,3}<![A-Z]/i.test(content)) return />/;
	if (HTML_INTERRUPT_RE.test(content) || (!paragraph && HTML_COMPLETE_TAG_RE.test(content))) return "blank";
	return null;
}
type Container = { quote: true } | { indent: number };
function stripKnownContainers(line: string, containers: readonly Container[]): string | undefined {
	let offset = 0;
	for (const container of containers) {
		const rest = line.slice(offset);
		if ("quote" in container) {
			const prefix = /^ {0,3}>[ \t]?/.exec(rest);
			if (!prefix) return undefined;
			offset += prefix[0].length;
		} else {
			if (!rest.trim()) continue;
			let width = 0;
			let length = 0;
			while (width < container.indent && /[ \t]/.test(rest[length] ?? "\0")) {
				width += rest[length++] === "\t" ? 4 - width % 4 : 1;
			}
			if (width < container.indent) {
				// Native lists retain eligible unindented paragraph continuations.
				// An actual new block/container is not such a continuation.
				if (LAZY_INTERRUPT_RE.test(rest) || HTML_INTERRUPT_RE.test(rest)) return undefined;
				continue;
			}
			offset += length;
		}
	}
	return line.slice(offset);
}

interface BlockLine {
	start: number;
	end: number;
	contentStart: number;
	content: string;
	code: boolean;
	fenced: boolean;
	definitionStart: boolean;
	definition?: { key: string; span: Span };
}

/** Source offsets stay original; only the block-classification view drops containers. */
function classifyBlockLines(markdown: string, definitions?: ReadonlyMap<number, number>, discoverContainers = false): BlockLine[] {
	const lines: BlockLine[] = [];
	let containers: Container[] = [];
	let fence: Fence | null = null;
	let html: HtmlEnd | null = null;
	let paragraph = false;
	let table = false;
	let previousContent = "";
	let definitionEnd = -1;
	let start = 0;
	const rawLines = markdown.split("\n");
	for (const line of rawLines) {
		let offset = 0;
		let matched = 0;
		for (const container of containers) {
			const rest = line.slice(offset);
			if ("quote" in container) {
				const prefix = /^ {0,3}>[ \t]?/.exec(rest);
				if (!prefix) break;
				offset += prefix[0].length;
			} else {
				// Blank list continuation lines need not carry their content indent.
				if (rest.trim() === "") { matched++; continue; }
				let width = 0;
				let length = 0;
				while (width < container.indent && /[ \t]/.test(rest[length] ?? "\0")) {
					width += rest[length++] === "\t" ? 4 - width % 4 : 1;
				}
				if (width < container.indent) break;
				offset += length;
			}
			matched++;
		}
		if (matched < containers.length) {
			containers = containers.slice(0, matched);
			fence = null;
			html = null;
			paragraph = false;
			table = false;
		}
		// Inside a fence, new quote/list markers are literal code, not containers.
		if ((!fence && !html || discoverContainers) && lines.length > definitionEnd) {
			while (true) {
				const rest = line.slice(offset);
				const quote = /^ {0,3}>[ \t]?/.exec(rest);
				if (quote) {
					containers.push({ quote: true });
					offset += quote[0].length;
				} else {
					const list = /^( {0,3})(?:[-+*]|\d{1,9}[.)])([ \t]+|$)/.exec(rest);
					if (!list) break;
					// Five or more padding spaces mean one list space plus indented code.
					const padding = list[2].replace(/\t/g, "    ").length;
					const length = list[0].length - list[2].length + (padding > 4 ? 1 : list[2].length);
					containers.push({ indent: length });
					offset += length;
				}
				paragraph = false;
				table = false;
			}
		}
		const content = line.slice(offset);
		const candidateEnd = definitions?.get(lines.length);
		let validatedDefinition: BlockLine["definition"];
		let definitionStart = lines.length > definitionEnd && candidateEnd !== undefined &&
			!fence && !html && !paragraph && !/^(?: {4}|\t)/.test(content);
		if (definitionStart) {
			// Validate only the containers already open at the header. A new quote
			// or list cannot be stripped to manufacture its destination or title.
			const effective = [content];
			const sourceStarts = [start + offset];
			let nextStart = start + line.length + 1;
			for (let i = lines.length + 1; i <= candidateEnd!; i++) {
				const next = stripKnownContainers(rawLines[i], containers);
				if (next === undefined) break;
				effective.push(next);
				sourceStarts.push(nextStart + rawLines[i].length - next.length);
				nextStart += rawLines[i].length + 1;
			}
			const match = REFERENCE_DEFINITION_PREFIX_RE.exec(effective.join("\n"));
			definitionStart = match !== null;
			if (match) {
				let last = 0;
				let end = match[0].length;
				while (last + 1 < effective.length && end > effective[last].length + 1) end -= effective[last++].length + 1;
				definitionEnd = lines.length + last;
				validatedDefinition = { key: referenceKey(match[1]), span: [start + offset, sourceStarts[last] + end] };
			}
		}
		const definition = lines.length <= definitionEnd;
		let code = false;
		let fenced = fence !== null;
		if (definition) {
			// A complete definition owns title text even when it resembles fences.
			code = false;
			fenced = false;
		} else if (fence) {
			code = true;
			const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(content);
			if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) fence = null;
		} else if (html || (html = htmlBlockEnd(content, paragraph))) {
			// Protect actual HTML blocks and their termination. A marker outside
			// an open HTML block cannot interrupt prose or manufacture references.
			code = true;
			if (html === "blank" ? !content.trim() : html.test(content)) html = null;
		} else {
			const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
			if (opening && !(opening[1][0] === "`" && opening[2].includes("`"))) {
				fence = { marker: opening[1][0] as "`" | "~", length: opening[1].length };
				code = true;
				fenced = true;
			} else code = /^(?: {4}|\t)/.test(content) && !paragraph && !definition;
		}
		// These native block endings cannot keep an indented block inside prose.
		const blockEnding = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:=+|-+)[ \t]*$|(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$)/.test(content) ||
			HTML_INTERRUPT_RE.test(content);
		const tableDelimiter = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/.test(content);
		if (code || definition || !content.trim() || blockEnding) table = false;
		else if (tableDelimiter && previousContent.includes("|")) table = true;
		// Definitions do not start paragraphs; following indented blocks are code.
		paragraph = !code && !definition && !blockEnding && !table && content.trim() !== "";
		previousContent = content;
		lines.push({ start, end: start + line.length, contentStart: start + offset, content, code, fenced, definitionStart, definition: validatedDefinition });
		start += line.length + 1;
	}
	return lines;
}

/** Keep code blocks byte-for-byte; group prose so inline code may span lines. */
function mapProse(markdown: string, transform: (prose: string, offset: number) => string): string {
	const output: string[] = [];
	let proseStart = 0;
	for (const line of blockLines(markdown)) {
		if (!line.code) continue;
		if (line.start > proseStart) output.push(transform(markdown.slice(proseStart, line.start - 1), proseStart));
		output.push(markdown.slice(line.start, line.end));
		proseStart = line.end + 1;
	}
	if (proseStart <= markdown.length) output.push(transform(markdown.slice(proseStart), proseStart));
	return output.join("\n");
}

// Definition grammar adapted from pinned host Marked; see licenses/LICENSES/marked.txt.
// Match complete definitions, including titles that open beside the destination
// and close on a later line. Null sentinels cannot become definition content.
const REFERENCE_LABEL = String.raw`((?!\s*\])(?:\\[^\0]|[^\[\]\\\0])+)`;
const REFERENCE_DESTINATION = String.raw`(?:[^<\s\0][^\s\0]*|<[^\r\n\u2028\u2029\0]*?>)`;
const REFERENCE_TITLE = String.raw`(?:"(?:\\"?|[^"\\\0])*"|'[^'\n\0]*(?:\n[^'\n\0]+)*\n?'|\([^()\0]*\))`;
const REFERENCE_TITLE_SPACE = String.raw`(?:[ \t]+(?:\n[ \t]*)?|[ \t]*\n[ \t]*)`;
const REFERENCE_DEFINITION_PATTERN = String.raw`^ {0,3}\[${REFERENCE_LABEL}\]:[ \t]*(?:\n[ \t]*)?${REFERENCE_DESTINATION}(?:${REFERENCE_TITLE_SPACE}${REFERENCE_TITLE})?[ \t]*(?:\n+|$)`;
// Lookahead keeps a literal definition inside genuine code from hiding a later
// valid one through an overlapping title match.
const REFERENCE_DEFINITION_RE = new RegExp(String.raw`(?=(${REFERENCE_DEFINITION_PATTERN}))`, "gm");
const REFERENCE_DEFINITION_PREFIX_RE = new RegExp(REFERENCE_DEFINITION_PATTERN);
const referenceKey = (label: string) => label.trim().replace(/\s+/g, " ").toLowerCase();

/** Wrapped destinations/titles are definitions, not intervening paragraphs. */
function blockLines(markdown: string): BlockLine[] {
	const preliminary = classifyBlockLines(markdown, undefined, true);
	const views = preliminary.map((line) => line.content);
	const starts: number[] = [];
	let offset = 0;
	for (const view of views) {
		starts.push(offset);
		offset += view.length + 1;
	}
	const candidates = new Map<number, number>();
	let first = 0;
	for (const match of views.join("\n").matchAll(REFERENCE_DEFINITION_RE)) {
		while (first + 1 < starts.length && starts[first + 1] <= match.index) first++;
		let last = first;
		while (last + 1 < starts.length && starts[last + 1] < match.index + match[1].length) last++;
		candidates.set(first, last);
	}
	return classifyBlockLines(markdown, candidates);
}

function mergeSpans(spans: Span[]): Span[] {
	spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
	const merged: Span[] = [];
	for (const span of spans) {
		const previous = merged.at(-1);
		if (previous && span[0] <= previous[1]) previous[1] = Math.max(previous[1], span[1]);
		else merged.push(span);
	}
	return merged;
}

/** Pair delimiters once, keeping long incomplete streaming labels linear. */
function inlineCodeEnds(text: string): Map<number, number> {
	const runs: Array<{ start: number; length: number }> = [];
	for (let i = 0; i < text.length; i++) {
		// Backslashes are literal inside code spans, so even escaped runs may close one.
		if (text[i] !== "`") continue;
		const start = i;
		while (text[i + 1] === "`") i++;
		runs.push({ start, length: i - start + 1 });
	}
	const nextRun = new Map<number, number>();
	const codeEnds = new Map<number, number>();
	for (let i = runs.length - 1; i >= 0; i--) {
		const run = runs[i];
		const next = nextRun.get(run.length);
		if (next !== undefined) codeEnds.set(run.start, next + run.length);
		nextRun.set(run.length, run.start);
	}
	return codeEnds;
}

function protectedSpans(text: string, wholeLinks: boolean, referenceKeys?: ReadonlySet<string>, definitions: Span[] = []): Span[] {
	const codeEnds = inlineCodeEnds(text);
	const spans: Span[] = [...definitions];
	const brackets: number[] = [];
	const parentheses: number[] = [];
	const labels: Span[] = [];
	const labelEnds = new Map<number, number>();
	const destinationEnds = new Map<number, number>();
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "\\") { i++; continue; }
		if (ch === "`") {
			const end = codeEnds.get(i);
			if (end !== undefined) {
				spans.push([i, end]);
				i = end - 1;
			} else while (text[i + 1] === "`") i++;
			continue;
		}
		if (ch === "[") brackets.push(i);
		else if (ch === "]") {
			const start = brackets.pop();
			if (start !== undefined) {
				labels.push([start, i]);
				labelEnds.set(start, i + 1);
			}
		} else if (ch === "(") parentheses.push(i);
		else if (ch === ")") {
			const start = parentheses.pop();
			if (start !== undefined) destinationEnds.set(start, i + 1);
		}
	}
	for (const [start, end] of labels) {
		if (text[end + 1] === "(") {
			spans.push([wholeLinks ? start : end + 1, destinationEnds.get(end + 1) ?? text.length]);
		} else if (!wholeLinks || referenceKeys) {
			const referenceEnd = labelEnds.get(end + 1);
			if (referenceEnd !== undefined) {
				spans.push([wholeLinks ? start : end + 1, referenceEnd]);
				// In a collapsed reference, the visible label also serves as its target key.
				if (text.slice(end + 2, referenceEnd - 1).trim() === "") spans.push([start, end + 1]);
			} else if (referenceKeys?.has(referenceKey(text.slice(start + 1, end)))) {
				spans.push([start, end + 1]);
			}
		}
	}
	if (!wholeLinks) {
		// Autolinks/HTML and host-native bare URLs are targets, not ordinary prose.
		for (const match of text.matchAll(/<(?:[a-z][a-z\d+.-]*:[^>\n]*|[^\s<>]+@[^\s<>]+|\/?[a-z][\w:-]*(?:\s[^>\n]*)?\/?)>|(?:(?:https?|ftp):\/\/|www\.)[^\s<>`，。；：！？、」』】（）【】《》『』「」]+/gi)) {
			spans.push([match.index, match.index + match[0].length]);
		}
	}
	return mergeSpans(spans);
}

const MULTILINE_LINK_RE = /^\[([\s\S]*?)\](?=\()/;

function normalizeLabel(label: string): string {
	let output = "";
	let cursor = 0;
	for (const [start, end] of protectedSpans(label, true)) {
		output += label.slice(cursor, start).replace(/[ \t]*\n[ \t]*/g, " ") + label.slice(start, end);
		cursor = end;
	}
	return (output + label.slice(cursor).replace(/[ \t]*\n[ \t]*/g, " ")).trim();
}

/** Prevent wrapped link labels from including line-padding in OSC 8 click areas. */
function normalizeMultilineLinks(markdown: string): string {
	const references = collectReferences(markdown);
	return mapProse(markdown, (text, offset) => {
		let output = "";
		let cursor = 0;
		for (const [start, end] of protectedSpans(text, true, references.keys, localDefinitions(references, offset, text.length))) {
			output += text.slice(cursor, start);
			output += text.slice(start, end).replace(MULTILINE_LINK_RE, (match, label: string) =>
				label.includes("\n") ? `[${normalizeLabel(label)}]` : match);
			cursor = end;
		}
		return output + text.slice(cursor);
	});
}

interface References {
	keys: ReadonlySet<string>;
	definitions: Span[];
}

/** Consume validated ownership ranges; discovery cannot expand them into new blocks. */
function collectReferences(markdown: string): References {
	const keys = new Set<string>();
	const definitions: Span[] = [];
	for (const line of blockLines(markdown)) {
		if (!line.definition) continue;
		keys.add(line.definition.key);
		definitions.push(line.definition.span);
	}
	return { keys, definitions };
}

function localDefinitions(references: References, offset: number, length: number): Span[] {
	return references.definitions.filter(([start, end]) => start < offset + length && end > offset)
		.map(([start, end]) => [Math.max(0, start - offset), Math.min(length, end - offset)]);
}

/** Bound only bare prose URLs; existing Markdown/HTML targets remain authoritative. */
function normalizeBareUrlBoundaries(markdown: string): string {
	const references = collectReferences(markdown);
	return mapProse(markdown, (text, offset) => {
		const spans = protectedSpans(text, true, references.keys, localDefinitions(references, offset, text.length));
		for (const match of text.matchAll(/<(a|pre|code)\b[^>]*>[\s\S]*?<\/\1\s*>|<[^<>\n]*>/gi)) {
			spans.push([match.index, match.index + match[0].length]);
		}
		let output = "";
		let cursor = 0;
		for (const [start, end] of mergeSpans(spans)) {
			output += fixBareUrlBoundaries(text.slice(cursor, start)) + text.slice(start, end);
			cursor = end;
		}
		return output + fixBareUrlBoundaries(text.slice(cursor));
	});
}

// Nerd Font's U+2460-U+2473 glyphs can overlap adjacent characters in DirectWrite.
const CIRCLED_RE = /[①-⑳]/g;
const deCircled = (text: string) => text.replace(CIRCLED_RE, (ch) => `(${ch.codePointAt(0)! - 0x2460 + 1})`);

/** Apply the font workaround only to prose, never code or link destinations. */
function deCircledProse(markdown: string): string {
	const references = collectReferences(markdown);
	return mapProse(markdown, (text, offset) => {
		let output = "";
		let cursor = 0;
		for (const [start, end] of protectedSpans(text, false, references.keys, localDefinitions(references, offset, text.length))) {
			output += deCircled(text.slice(cursor, start)) + text.slice(start, end);
			cursor = end;
		}
		return output + deCircled(text.slice(cursor));
	});
}

const ADMONITION = /^>\s*\[\s*!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\s*\]\s*(.*)$/i;
const ADMONITION_STYLE: Record<string, { icon: string; label: string }> = {
	NOTE: { icon: "💡", label: "NOTE" },
	TIP: { icon: "✅", label: "TIP" },
	IMPORTANT: { icon: "❗", label: "IMPORTANT" },
	WARNING: { icon: "⚠️", label: "WARNING" },
	CAUTION: { icon: "⚠️", label: "CAUTION" },
};

/** GitHub-style admonitions remain quoted, with a bold icon and label. */
function renderAdmonitions(markdown: string): string {
	return mapProse(markdown, (text) => {
		const lines = text.split("\n");
		const output: string[] = [];
		for (let i = 0; i < lines.length; i++) {
			const match = ADMONITION.exec(lines[i]);
			if (!match) { output.push(lines[i]); continue; }
			const style = ADMONITION_STYLE[match[1].toUpperCase()];
			const body = [match[2]];
			while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1]) && !ADMONITION.test(lines[i + 1])) {
				body.push(lines[++i].replace(/^>\s?/, ""));
			}
			while (body.length && body.at(-1)!.trim() === "") body.pop();
			const content = body.join(" ").trim();
			output.push(`> **${style.icon} ${style.label}**${content ? ` ${content}` : ""}`, "");
		}
		return output.join("\n");
	});
}

export default function registerMarkdown(pi: ExtensionAPI): void {
	// Pi has one transformer slot per extension: compose all retained features here.
	pi.registerMarkdownTransformer((markdown, context) => {
		if (context?.messageType === "assistant-thinking") return markdown;
		markdown = normalizeBareUrlBoundaries(normalizeMultilineLinks(markdown));
		if (context?.isStreaming) return markdown;
		return renderAdmonitions(deCircledProse(markdown));
	});
}
