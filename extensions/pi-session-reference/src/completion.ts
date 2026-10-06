import { truncateToWidth, type AutocompleteProvider } from "@earendil-works/pi-tui";
import { plainLabel } from "./text.ts";

export interface Candidate {
	id: string;
	title: string;
	workspace: string;
	updated: string;
}

function ownPrefix(lines: string[], line: number, column: number): string | undefined {
	return /(?:^|\s)(@session:(?:\[[^\]\n]*\]?|[^\s]*))$/.exec((lines[line] ?? "").slice(0, column))?.[1];
}

export function referenceCompletion(current: AutocompleteProvider, candidates: () => readonly Candidate[]): AutocompleteProvider {
	return {
		triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "@", ":"])],
		async getSuggestions(lines, line, column, options) {
			const prefix = ownPrefix(lines, line, column);
			if (prefix === undefined) return current.getSuggestions(lines, line, column, options);
			if (options.signal.aborted) return null;
			const query = prefix.slice("@session:".length).replace(/^\[|\]$/g, "").toLocaleLowerCase();
			return { prefix, items: candidates()
				.filter((candidate) => `${candidate.title} ${candidate.id} ${candidate.workspace}`.toLocaleLowerCase().includes(query))
				.map((candidate) => ({
					value: `@session:[${candidate.id}]`,
					label: plainLabel(truncateToWidth(candidate.title || "(no title)", 32, "…")),
					description: `Updated: ${candidate.updated} · Workspace: ${candidate.workspace} · ID: ${candidate.id}`,
				})) };
		},
		applyCompletion(lines, line, column, item, prefix) {
			if (!prefix.startsWith("@session:") || !/^@session:\[[A-Za-z0-9._-]+\]$/.test(item.value)) {
				return current.applyCompletion(lines, line, column, item, prefix);
			}
			const updated = [...lines];
			const text = lines[line] ?? "";
			const closingBracket = prefix.startsWith("@session:[") && !prefix.endsWith("]") ? text.indexOf("]", column) : -1;
			const end = closingBracket < 0 ? column : closingBracket + 1;
			updated[line] = text.slice(0, column - prefix.length) + item.value + text.slice(end);
			return { lines: updated, cursorLine: line, cursorCol: column - prefix.length + item.value.length };
		},
		shouldTriggerFileCompletion(lines, line, column) {
			return ownPrefix(lines, line, column) === undefined && (current.shouldTriggerFileCompletion?.(lines, line, column) ?? false);
		},
	};
}
