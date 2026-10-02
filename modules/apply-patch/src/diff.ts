import { structuredPatch } from "diff";

export interface DiffBudget {
	maxEditLength: number;
	timeout: number;
}

export interface BoundedDiff {
	diff: string;
	added: number;
	removed: number;
}

/**
 * One budgeted jsdiff search, then a display-only projection of its hunks.
 * Inputs are the report's normalized copies, never text read from disk here.
 * No second (unbounded) search is needed to format Pi-compatible display rows.
 * jsdiff checks its deadline between search iterations, not as a hard interrupt.
 */
export function generateBoundedDiff(before: string, after: string, budget: DiffBudget): BoundedDiff | undefined {
	if (!Number.isSafeInteger(budget.maxEditLength) || budget.maxEditLength <= 0 ||
			!Number.isFinite(budget.timeout) || budget.timeout <= 0) return undefined;
	const patch = structuredPatch("", "", before, after, undefined, undefined, {
		context: 4,
		maxEditLength: budget.maxEditLength,
		timeout: budget.timeout,
	});
	if (!patch) return undefined;

	// Pi's display format includes the split's final empty element in the
	// number-column width, but does not render it as an extra logical line.
	const beforeCount = before.split("\n").length;
	const afterCount = after.split("\n").length;
	const width = String(Math.max(beforeCount, afterCount)).length;
	const logicalBefore = before === "" ? 0 : beforeCount - Number(before.endsWith("\n"));
	const logicalAfter = after === "" ? 0 : afterCount - Number(after.endsWith("\n"));
	const rows: string[] = [];
	const gap = ` ${" ".repeat(width)} ...`;
	let oldLine = 1;
	let newLine = 1;
	let added = 0;
	let removed = 0;
	for (const hunk of patch.hunks) {
		if (hunk.oldStart > oldLine || hunk.newStart > newLine) rows.push(gap);
		oldLine = hunk.oldStart;
		newLine = hunk.newStart;
		for (const line of hunk.lines) {
			const sign = line[0];
			// Newline/BOM information is represented by the report's facts, not
			// unified-patch "\ No newline at end of file" rows.
			if (sign !== "+" && sign !== "-" && sign !== " ") continue;
			const number = sign === "+" ? newLine : oldLine;
			rows.push(`${sign}${String(number).padStart(width, " ")} ${line.slice(1)}`);
			if (sign === "+") {
				added++;
				newLine++;
			} else if (sign === "-") {
				removed++;
				oldLine++;
			} else {
				oldLine++;
				newLine++;
			}
		}
	}
	if (patch.hunks.length > 0 && (oldLine <= logicalBefore || newLine <= logicalAfter)) rows.push(gap);
	return { diff: rows.join("\n"), added, removed };
}
