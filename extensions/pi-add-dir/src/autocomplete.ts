import { isAbsolute, sep } from "node:path";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { isWithinDir, type AddedDir } from "./directories.ts";
import { hasUnsafeDisplayCharacters, sanitize } from "./presentation.ts";

// Mirrors the separators Pi 1.0.0 treats as prose/path boundaries: whitespace (including the
// non-ASCII spaces `\s` matches), `"'=`, and punctuation in CJK scripts.
const PATH_DELIMITERS = new Set(['"', "'", "="]);
const WHITESPACE = /\s/u;
const CJK_BREAK = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u;
const CJK_PUNCTUATION = new RegExp(`(?:(?=\\p{Punctuation})${CJK_BREAK.source}|[，．：；！？（）［］｛｝“”‘’…—])`, "u");
const PATH_WRAPPERS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">", "`": "`" };
/** The host's boundary test is anchored on the whole prefix, so astral punctuation must match too. */
const BOUNDARY_AT_END = new RegExp(`(?:${WHITESPACE.source}|${CJK_PUNCTUATION.source})$`, "u");

function isSeparator(character: string): boolean {
	return WHITESPACE.test(character) || PATH_DELIMITERS.has(character) || CJK_PUNCTUATION.test(character);
}

function stripLeadingWrappers(token: string): string {
	let result = token;
	while (result.length > 0) {
		const closer = PATH_WRAPPERS[result[0]];
		if (!closer || result.includes(closer, 1)) break;
		result = result.slice(1);
	}
	return result;
}

/**
 * Mirrors the host: a quote that is still open starts its own token, and a token only starts
 * at a boundary rather than inside a word.
 */
function findUnclosedQuoteStart(text: string): number | null {
	let inQuotes = false;
	let quoteStart = -1;
	for (let index = 0; index < text.length; index += 1) {
		if (text[index] === '"') {
			inQuotes = !inQuotes;
			if (inQuotes) quoteStart = index;
		}
	}
	return inQuotes ? quoteStart : null;
}

function isTokenStart(text: string, index: number): boolean {
	let start = index;
	while (start > 0 && PATH_WRAPPERS[text[start - 1] as string]) start -= 1;
	if (start === 0) return true;
	if (PATH_DELIMITERS.has(text[start - 1] as string)) return true;
	return BOUNDARY_AT_END.test(text.slice(0, start));
}

/**
 * Fallback used only when the host provider produced no suggestions: the host's own
 * extraction, so a query the host would recognise is never completed differently.
 */
function extractAtToken(textBeforeCursor: string): string | undefined {
	const quoteStart = findUnclosedQuoteStart(textBeforeCursor);
	if (
		quoteStart !== null &&
		quoteStart > 0 &&
		textBeforeCursor[quoteStart - 1] === "@" &&
		isTokenStart(textBeforeCursor, quoteStart - 1)
	) {
		return textBeforeCursor.slice(quoteStart - 1);
	}
	let lastSeparator = -1;
	let index = 0;
	for (const character of textBeforeCursor) {
		index += character.length;
		if (isSeparator(character)) lastSeparator = index - 1;
	}
	const token = stripLeadingWrappers(
		lastSeparator === -1 ? textBeforeCursor : textBeforeCursor.slice(lastSeparator + 1),
	);
	return token.startsWith("@") ? token : undefined;
}

/**
 * Pi quotes an @ candidate whenever the path itself contains one of its separators.
 */
function needsQuoting(path: string): boolean {
	return [...path].some((character) => isSeparator(character));
}

/**
 * The host builds external candidates from file names inside the directory, so they are as
 * untrusted as the directory's contents: a candidate that could move the terminal cursor or
 * reorder the rendered line is dropped rather than rewritten into a different path, and the
 * description this module adds is escaped like every other string it prints.
 */
function externalItems(items: readonly AutocompleteItem[], dir: AddedDir): AutocompleteItem[] {
	return items.flatMap((item) => {
		if (hasUnsafeDisplayCharacters(item.value) || hasUnsafeDisplayCharacters(item.label)) return [];
		if (!item.value.startsWith("@")) return [];
		const path = item.value.startsWith('@"') && item.value.endsWith('"')
			? item.value.slice(2, -1)
			: item.value.slice(1);
		// Pi preserves the probe prefix even when a missing scope falls back to cwd.
		// Only absolute attachments under this base establish external ownership.
		if (!isAbsolute(path) || !isWithinDir(dir.absolutePath, path)) return [];
		return [{ ...item, description: `${sanitize(dir.label)}: ${sanitize(item.description ?? item.value)}` }];
	});
}

/**
 * Preserve the raw suffix for Pi to interpret. Normalizing empty or terminal-dot queries
 * would remove the base separator and make Pi search a parent directory instead.
 */
function externalToken(dir: AddedDir, query: string, quoted: boolean): string {
	const base = dir.absolutePath.endsWith(sep) ? dir.absolutePath : `${dir.absolutePath}${sep}`;
	const path = `${base}${query}`;
	return `${quoted || needsQuoting(path) ? '@"' : "@"}${path}`;
}

/**
 * Wraps whatever provider the host installed: relative `@` queries additionally offer
 * absolute candidates from the active external directories. The host's own returned prefix
 * decides whether an `@` token is being completed, so this wrapper never replaces more text
 * than the host intended.
 */
export function createExternalAutocompleteProvider(
	current: AutocompleteProvider,
	getAddedDirs: () => readonly AddedDir[],
): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const line = lines[cursorLine] ?? "";
			const local = await current.getSuggestions(lines, cursorLine, cursorCol, options);
			const token = local === null || local === undefined
				? extractAtToken(line.slice(0, cursorCol))
				: local.prefix.startsWith("@")
					? local.prefix
					: undefined;
			if (!token) return local ?? null;

			const quoted = token.startsWith('@"');
			const query = token.slice(quoted ? 2 : 1);
			// Pi treats every backslash as a separator, including on POSIX. Classify
			// its scope that way, but keep the ordinary probe's query suffix raw.
			const scopedQuery = query.replace(/\\/g, "/");
			if (isAbsolute(scopedQuery) || scopedQuery.startsWith("~/") || scopedQuery.startsWith("./") || scopedQuery.startsWith("../")) {
				return local ?? null;
			}

			const tokenStart = cursorCol - token.length;
			const external = await Promise.all(
				getAddedDirs().map(async (dir) => {
					// Pi normalizes backslashes even on POSIX, where they can be filename
					// characters. Do not attribute a different search directory to this base.
					if (sep === "/" && dir.absolutePath.includes("\\")) return null;
					const tokenText = externalToken(dir, query, quoted);
					const externalLines = [...lines];
					externalLines[cursorLine] = `${line.slice(0, tokenStart)}${tokenText}${line.slice(cursorCol)}`;
					const suggestions = await current.getSuggestions(
						externalLines,
						cursorLine,
						tokenStart + tokenText.length,
						options,
					);
					// Literal quotes can make the host parse a different token. Its returned
					// prefix must describe the complete probe before we reuse these candidates.
					return suggestions?.prefix === tokenText
						? { dir, suggestions }
						: null;
				}),
			);
			// Host suggestion requests are asynchronous. Re-sample ownership after they land:
			// a navigation or removal must not publish the captured directories' old results.
			const activePaths = new Set(getAddedDirs().map((dir) => dir.absolutePath));
			const sources = [
				local,
				...external.map((source) => source && activePaths.has(source.dir.absolutePath)
						? { ...source.suggestions, items: externalItems(source.suggestions.items, source.dir) }
					: null),
			];

			const itemCount = Math.max(...sources.map((source) => source?.items.length ?? 0));
			const items = Array.from({ length: itemCount }, (_, index) =>
				sources.flatMap((source) => (source?.items[index] ? [source.items[index]] : [])),
			).flat();
			return items.length > 0 ? { prefix: token, items } : null;
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}
