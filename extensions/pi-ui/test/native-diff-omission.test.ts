import assert from "node:assert/strict";
import test from "node:test";
import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { config, setConfig } from "../src/config/config.ts";
import { harness, strip } from "./harness.ts";

test("native leading/intermediate omissions use number gutters and terminal context is not hidden retained data", async () => {
	const h = await harness();
	try {
		const before = Array.from({ length: 40 }, (_, index) => index === 9 ? "..." : `line-${index + 1}`);
		const after = before.map((line, index) => index === 10 || index === 29 ? `${line} changed` : line);
		const native = generateDiffString(before.join("\n"), after.join("\n"));
		// Exactly enough space for all retained rows, excluding the host's terminal
		// continuation marker. Only a false retained-content budget can add a hint.
		setConfig({ editPreviewLines: native.diff.split("\n").length - 1 });
		const edit = h.tool("edit", "native-gaps", { path: "fixture.txt", oldText: "old", newText: "new" },
			{ content: [{ type: "text", text: "Successfully replaced text" }], isError: false, details: native });
		let lines = edit.render(100).map(strip);
		assert.ok(!lines.some((line: string) => line.includes("click to show more")), lines.join("\n"));
		const gaps = lines.filter((line: string) => line.includes("⋮"));
		assert.equal(gaps.length, 2, "leading and intermediate gaps remain, not the terminal gap");
		const numbered = lines.find((line: string) => /10\s+\.\.\.$/.test(line));
		assert.ok(numbered, "actual numbered ellipsis text is preserved");
		assert.ok(gaps.every((line: string) => line.indexOf("⋮") === numbered!.indexOf("0")), "gap glyphs align with the right edge of line numbers");

		setConfig({ editPreviewLines: 3, fileExpandedMaxLines: 5 });
		edit.invalidate();
		assert.match(edit.render(100).map(strip).join("\n"), /click to show more/);
		edit.setExpanded(true);
		lines = edit.render(100).map(strip);
		assert.match(lines.join("\n"), /click to show more/);
		assert.ok(lines.length <= config.fileExpandedMaxLines + 5, "expanded diff remains bounded");
	} finally { await h.close(); }
});
