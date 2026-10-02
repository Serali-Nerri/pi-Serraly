import { defineTool, truncateHead, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { applyPatchWithSnapshots } from "./files.ts";
import { PATCH_GRAMMAR } from "./grammar.ts";
import { buildPatchReport } from "./report.ts";

function bounded(text: string): string {
	const result = truncateHead(text, { maxLines: 200, maxBytes: 16 * 1024 });
	// truncateHead returns no content if its first line alone exceeds the cap.
	const content = result.firstLineExceedsLimit ? text.slice(0, 2000) : result.content;
	return content + (result.truncated ? "\n[Patch result truncated.]" : "");
}

/** The single source of truth for the model-facing contract and execution. */
export function createApplyPatchTool() {
	return defineTool({
		name: "apply_patch",
		exposure: "direct",
		namespace: {
			name: "patches",
			description: "Apply patches to add, edit, move and delete local files",
		},
		label: "apply_patch",
		description: `Apply a patch to local UTF-8 text files. Supply patch text as input.
Use *** Begin Patch / *** End Patch around one or more file operations:
*** Add File: path (each new line starts with +)
*** Delete File: path
*** Update File: path (optional *** Move to: destination, then @@ chunks)
Within update chunks, prefix context lines with a space, deletions with -, and additions with +.
Use @@ context text to locate a section; *** End of File matches a chunk at the file end.
This is not a git/unified diff: do not use ---/+++ file headers or numeric @@ ranges.
Paths resolve from the session cwd; absolute paths are allowed. Add and Move may overwrite existing files.
Read the relevant file first. File symlinks, hard links, directories and binary files are rejected.
All chunks are checked before writes, but I/O failures can leave a partially applied multi-file patch.`,
		promptSnippet: "Apply patches to add, update, delete, or move files",
		promptGuidelines: [
			"Use apply_patch for file changes; inspect existing text before constructing update chunks.",
			"apply_patch: @@ context anchors are text, not line numbers. Keep chunks in source order and include enough context to target the intended occurrence.",
		],
		parameters: Type.Object({
			input: Type.String({ description: "The complete *** Begin Patch ... *** End Patch text" }),
		}, { additionalProperties: false }),
		constrainedSampling: { type: "grammar", variants: { openai_lark: PATCH_GRAMMAR } },
		async execute(_id, { input }, signal, _onUpdate, ctx) {
			try {
				const outcome = await applyPatchWithSnapshots(input, ctx.cwd, { signal, withFileLock: withFileMutationQueue });
				const { changes } = outcome;
				// The commit's locks have been released; rendering uses immutable
				// snapshots, not potentially newer contents read from disk.
				const details = buildPatchReport(outcome, { signal });
				// A valid patch can leave every target byte-identical; report that
				// distinctly instead of listing no-op updates as successful writes.
				if (changes.length === 0) {
					return {
						content: [{ type: "text", text: "No files were modified." }],
						details,
					};
				}
				const lines = changes.map((change) => {
					const code = { add: "A", update: "M", delete: "D" }[change.kind];
					return `${code} ${change.path}${change.moveFrom ? ` (from ${change.moveFrom})` : ""}`;
				});
				return {
					content: [{ type: "text", text: bounded(`Success. Updated the following files:\n${lines.join("\n")}`) }],
					details,
				};
			} catch (error) {
				throw new Error(bounded(error instanceof Error ? error.message : String(error)), { cause: error });
			}
		},
	});
}
