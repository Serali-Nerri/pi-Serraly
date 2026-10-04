import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { setConfig } from "../src/config/config.ts";
import { describePatchTitle, fitPatchPaths, formatPatchTitle, patchDisplayPath } from "../src/transcript/tool/apply-patch-title.ts";
import { parseApplyPatchDetails, type ApplyPatchChange, type ApplyPatchDetails } from "../src/transcript/tool/apply-patch.ts";
import { truncatePathToWidth } from "../src/transcript/tool/names.ts";
import { harness, strip } from "./harness.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/apply-patch-v1.json", import.meta.url), "utf8"));
const entry = (path: string, kind: ApplyPatchChange["kind"] = "update"): ApplyPatchChange =>
	({ ...structuredClone(fixture.changes[kind === "add" ? 0 : 1]), kind, path });
const details = (...changes: ApplyPatchChange[]): ApplyPatchDetails => ({ format: "apply_patch.v1", changes });
const output = (details: unknown, isError = false) => ({ content: [{ type: "text", text: isError ? "Operation aborted" : "ok" }], details, isError });
const definition = { name: "apply_patch", label: "apply_patch" };
const args = { input: "*** Begin Patch\n*** Add File: WRONG_FIRST_FILE\n+intent only\n*** End Patch" };
const text = (tool: any, width = 100) => tool.render(width).map(strip).join("\n");
const header = (tool: any, width = 100) =>
	tool.render(width).map(strip).find((line: string) => line.includes("apply_patch")) ?? "";
const title = (value: ApplyPatchDetails, cwd = "/repo", width = 200) =>
	formatPatchTitle(describePatchTitle(value, cwd), width);

test("single-file titles use the final action, never the first input operation", async () => {
	const h = await harness();
	try {
		for (const [kind, action] of [["add", "Add"], ["update", "Update"], ["delete", "Delete"]] as const) {
			const tool = h.tool("apply_patch", kind, args, output(details(entry("batch_test/file.txt", kind))), definition);
			assert.match(header(tool), new RegExp(`apply_patch \\(${action} · batch_test/file\\.txt\\)`));
			assert.doesNotMatch(header(tool), /WRONG_FIRST_FILE|\*\*\*|Edit/);
		}
	} finally { await h.close(); }
});

test("batch titles use one/two parent directories or a directory count, including move endpoints", () => {
	const batch = details(
		entry("batch_test/new_1.txt", "add"), entry("batch_test/new_2.txt", "add"),
		entry("batch_test/update_a.txt"), entry("batch_test/update_b.txt"),
		entry("batch_test/del.txt", "delete"),
		{ ...entry("batch_test/moved.txt"), moveFrom: "batch_test/move_me.txt", contentChanged: true },
	);
	assert.equal(title(batch), "batch_test/ · 6 changes");
	assert.equal(title(details(entry("src/a.ts"), entry("test/a.ts"))), "src/, test/ · 2 changes");
	assert.equal(title(details(entry("src/a.ts"), entry("test/a.ts"), entry("docs/a.md"))), "3 changes · 3 directories");
	assert.equal(title(details(entry("a.ts"), entry("./b.ts"))), "./ · 2 changes");
	assert.equal(title(details(entry("src/nested/../a.ts"), entry("/repo/src/b.ts"))), "src/ · 2 changes");
	assert.equal(title(details(entry("src/a.ts"), {
		...entry("test/moved.ts"), moveFrom: "docs/old.ts", contentChanged: false,
	})), "2 changes · 3 directories");
});

test("move title uses source-to-final metadata, not overwritten destination statistics", () => {
	const overwritten = structuredClone(fixture.changes[2]) as ApplyPatchChange;
	assert.equal(title(details(overwritten)), "Move + Update · docs/old-name.md → docs/new-name.md");
	overwritten.contentChanged = false;
	assert.equal(title(details(overwritten)), "Move · docs/old-name.md → docs/new-name.md");
	delete overwritten.contentChanged;
	assert.equal(title(details(overwritten)), "Move · docs/old-name.md → docs/new-name.md", "old overwrite reports do not prove source content edits");

	const normal = entry("b.ts");
	normal.moveFrom = "a.ts";
	normal.views[0]!.role = "move";
	assert.equal(title(details(normal)), "Move + Update · a.ts → b.ts", "old new-destination reports can infer actual edits");
	normal.views[0]!.added = 0;
	normal.views[0]!.removed = 0;
	normal.views[0]!.diff = "";
	assert.equal(title(details(normal)), "Move · a.ts → b.ts");
	normal.views[0]!.after.bom = true;
	assert.equal(title(details(normal)), "Move + Update · a.ts → b.ts", "byte-format changes count as updates");
	normal.views[0]!.added = null;
	assert.equal(title(details(normal)), "Move · a.ts → b.ts", "unknown old stats are not a claim of an edit");
});

test("path display is cwd-relative inside and absolute outside, including relative traversal", () => {
	assert.equal(patchDisplayPath("/repo/src/a.ts", "/repo"), "src/a.ts");
	assert.equal(patchDisplayPath("src/../a.ts", "/repo"), "a.ts");
	assert.equal(patchDisplayPath("../external/a.ts", "/repo"), "/external/a.ts");
	assert.equal(patchDisplayPath("/other/a.ts", "/repo"), "/other/a.ts");
	assert.equal(patchDisplayPath("C:\\repo\\src\\a.ts", "C:\\repo"), "src\\a.ts");
	assert.equal(patchDisplayPath("..\\other\\a.ts", "C:\\repo"), "C:\\other\\a.ts");
	assert.equal(title(details(entry("C:\\repo\\src\\a.ts"), entry("C:\\repo\\test\\b.ts")), "C:\\repo"),
		"src\\, test\\ · 2 changes");
});

test("middle omission preserves filename, start, parent when possible, and both move endpoints", () => {
	assert.equal(formatPatchTitle({ action: "Update", paths: ["src/x.ts"] }, 8), "Update");
	assert.equal(formatPatchTitle({ action: "Move + Update", paths: ["src/a.ts", "dst/b.ts"] }, 20), "Move + Update");
	const path = "src/very-long-module/internal/rendering/file-renderer.ts";
	const clipped = truncatePathToWidth(path, 40, "...");
	assert.ok(clipped.startsWith("src"));
	assert.ok(clipped.endsWith("/rendering/file-renderer.ts"));
	assert.ok(clipped.includes("..."));
	assert.ok(visibleWidth(clipped) <= 40);
	const moved = fitPatchPaths([
		"/home/user/very-long-project/internal/old.ts",
		"/outside/other-long-project/compiled/new.ts",
	], 64);
	assert.match(moved, /old\.ts → .*new\.ts$/u);
	assert.ok(moved.startsWith("/home"));
	assert.ok(moved.includes("/outside"));
	assert.ok(visibleWidth(moved) <= 64);
	assert.match(fitPatchPaths(["src/long/directory/component/", "test/another/directory/snapshots/"], 42, ", "),
		/component\/, .*snapshots\/$/u);
	for (const value of [path, "/中文/👩‍💻/very-long-parent/中文文件.test.ts", "超长文件名".repeat(20) + ".test.ts"]) {
		for (let width = 0; width < 100; width++) {
			const shown = truncatePathToWidth(value, width, "...");
			assert.ok(visibleWidth(shown) <= width, `${width}: ${shown}`);
			assert.doesNotMatch(shown, /\uFFFD|\u200d\.\.\.|\.\.\.\u200d/u);
		}
	}
	assert.match(truncatePathToWidth("long".repeat(30) + ".test.ts", 24, "..."), /^long.*\.\.\..*\.ts$/u);
});

test("result-arrival, replay, expand, resize, error and legacy transitions update titles immediately", async () => {
	const h = await harness();
	try {
		const tool = h.tool("apply_patch", "lifecycle", args, undefined, definition);
		assert.match(header(tool), /Applying patch/);
		const batch = details(entry("src/a.ts"), entry("test/b.ts"));
		tool.updateResult(output(batch));
		assert.match(header(tool), /src\/, test\/ · 2 changes/);
		tool.setExpanded(true);
		assert.match(header(tool), /src\/, test\/ · 2 changes/);
		for (const width of [8, 40, 100, 200, 100]) {
			assert.ok(tool.render(width).every((line: string) => visibleWidth(line) <= width));
		}
		tool.invalidate();
		assert.match(header(tool), /src\/, test\/ · 2 changes/);
		tool.updateResult(output({}, true));
		assert.match(header(tool), /apply_patch \(Failed\)/);
		assert.doesNotMatch(header(tool), /2 changes/);
		tool.updateResult(output(details()));
		assert.match(header(tool), /apply_patch \(No changes\)/);
		tool.updateResult(output({ changes: [{ kind: "delete", path: "legacy.txt" }] }));
		assert.match(header(tool), /Result unavailable/);
		assert.doesNotMatch(header(tool), /Delete|legacy\.txt/);
		tool.setExpanded(false);
		assert.match(text(tool), /line returned/);
		tool.updateResult(output({ format: "unknown", changes: [] }));
		assert.match(header(tool), /Result unavailable/);
		tool.updateResult(output(details()), true);
		assert.match(header(tool), /Applying patch/);
		assert.doesNotMatch(header(tool), /No changes/);
		const replay = h.tool("apply_patch", "replay", args, output(batch), definition);
		assert.match(header(replay), /src\/, test\/ · 2 changes/);
		setConfig({ mode: "off" }); replay.invalidate();
		assert.doesNotMatch(header(replay), /src\/, test\/ · 2 changes/);
		setConfig({ mode: "on" }); replay.invalidate();
		assert.match(header(replay), /src\/, test\/ · 2 changes/);
	} finally { await h.close(); }
});

test("long paths shorten in titles and file rows but remain intact in the retained-data view", async () => {
	const h = await harness();
	try {
		const path = "src/" + "long-directory/".repeat(15) + "important-file.ts";
		const tool = h.tool("apply_patch", "long-path", args, output(details(entry(resolve(h.ctx.cwd, path)))), definition);
		const shown = text(tool, 100);
		assert.match(header(tool, 100), /Update · src.*\.\.\..*important-file\.ts\)/u);
		assert.match(shown, /M src.*\.\.\..*important-file\.ts/u);
		assert.match(shown, /click to show more/);
		tool.setExpanded(true);
		assert.match(text(tool), /important-file\.ts/);
		assert.match(tool.resultRendererComponent.fullPreview.content.render(10_000).map(strip).join("\n"),
			new RegExp(path.replaceAll(".", "\\.")));
		const move = entry("/outside/" + "very-long-directory/".repeat(8) + "new-name.ts");
		move.moveFrom = "/another/" + "long-parent/".repeat(8) + "old-name.ts";
		move.contentChanged = true;
		move.views[0]!.role = "move";
		const moved = h.tool("apply_patch", "long-move", args, output(details(move)), definition);
		assert.match(header(moved, 100), /old-name\.ts → .*new-name\.ts\)/u);
		for (const width of [1, 2, 8, 16, 40, 80, 100]) {
			assert.ok(moved.render(width).every((line: string) => visibleWidth(line) <= width));
		}
	} finally { await h.close(); }
});

test("the move-content metadata is optional but type checked", () => {
	const value = structuredClone(fixture);
	assert.equal(parseApplyPatchDetails(value)?.changes[2]?.contentChanged, true);
	value.changes[2].contentChanged = "yes";
	assert.equal(parseApplyPatchDetails(value), undefined);
	delete value.changes[2].contentChanged;
	assert.ok(parseApplyPatchDetails(value));
});
