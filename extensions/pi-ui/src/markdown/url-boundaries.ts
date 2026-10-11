// Display-only compatibility for Pi 1.1.0's GFM bare-URL punctuation boundaries.
// Ordinary URLs still go through the host tokenizer without modification.
const BOUNDARIES = "，。；：！？、（）【】《》〈〉「」『』〔〕［］｛｝";
const BARE_URL = new RegExp(`(?:https?:\\/\\/|ftp:\\/\\/|www\\.)[a-z\\d-][^\\s<>\x60${BOUNDARIES}]*`, "gi");
const ASCII_SUFFIX = /[?!.,:;*_"'~]/;

/** Trim only the ASCII suffix exposed by cutting at a CJK punctuation boundary. */
function urlEnd(url: string): number {
	const openings: number[] = [];
	const unmatchedClosings = new Set<number>();
	for (let i = 0; i < url.length; i++) {
		if (url[i] === "(") openings.push(i);
		else if (url[i] === ")" && openings.pop() === undefined) unmatchedClosings.add(i);
	}
	let end = url.length;
	while (end > 0) {
		const ch = url[end - 1];
		if (ASCII_SUFFIX.test(ch)) end--;
		else if (ch === ")" && unmatchedClosings.has(end - 1)) end--;
		else break;
	}
	return end;
}

/** Called only on prose outside code, existing links, autolinks and definitions. */
export function fixBareUrlBoundaries(prose: string): string {
	return prose.replace(BARE_URL, (candidate: string, offset: number) => {
		if (!BOUNDARIES.includes(prose[offset + candidate.length] ?? "\0")) return candidate;
		const end = urlEnd(candidate);
		const url = candidate.slice(0, end);
		// Autolinks keep URL characters literal. www has no autolink form; a native
		// code-span label shields Markdown/LaTeX syntax without USER-visible escapes.
		// Candidates contain no backticks or whitespace, so one delimiter suffices.
		if (/^www\./i.test(url)) {
			// The host unescapes bracket escapes before parsing even code-span labels.
			const label = /[\\$*_[\]~]/.test(url) ? `\`${url.replace(/\\(?=[\[\]])/g, "\\\\")}\`` : url;
			// Inline destinations unescape punctuation; retain literal URL backslashes.
			const target = url.replace(/\\/g, "\\\\");
			return `[${label}](<http://${target}>)${candidate.slice(end)}`;
		}
		return `<${url}>${candidate.slice(end)}`;
	});
}
