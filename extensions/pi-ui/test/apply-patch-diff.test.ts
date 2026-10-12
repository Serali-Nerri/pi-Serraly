import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { setCapabilityOverrides, visibleWidth } from "@earendil-works/pi-tui";
import { setConfig } from "../src/config/config.ts";
import { parseApplyPatchDetails } from "../src/transcript/tool/apply-patch.ts";
import { FileResultView } from "../src/transcript/tool/files.ts";
import { ToolGroupComponent } from "../src/compat/grouping.ts";
import { harness, strip, theme } from "./harness.ts";

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "apply-patch-v1.json"), "utf8"));
const result = (text: string, details?: unknown, isError = false) => ({ content: [{ type: "text", text }], isError, details });

const facts = (overrides: Record<string, unknown> = {}) => ({
	exists: true, bytes: 12, lines: 2, bom: false,
	endings: { lf: 2, crlf: 0, cr: 0 }, finalNewline: true, ...overrides,
});
const view = (overrides: Record<string, unknown> = {}) => ({
	role: "file", before: facts(), after: facts(), added: 1, removed: 1,
	diff: " 1 keep\n-2 old\n+2 new", availability: "complete", lineEndingsChanged: false, ...overrides,
});
const change = (overrides: Record<string, unknown> = {}) => ({ kind: "update", path: "src/a.ts", views: [view()], ...overrides });
const detailsOf = (changes: unknown[], extra: Record<string, unknown> = {}) => ({ format: "apply_patch.v1", changes, ...extra });
const render = (tool: any, width = 100) => tool.render(width).map(strip).join("\n");

// 与 tools 扩展一致：apply_patch 始终是一个带定义的注册工具，而非匿名工具名。
const definition = { name: "apply_patch", label: "apply_patch" };
const patchTool = (h: any, id: string, input: string, resultValue: any) =>
	h.tool("apply_patch", id, { input }, resultValue, definition);

test("the shared golden fixture is a valid apply_patch.v1 contract", () => {
	assert.ok(parseApplyPatchDetails(fixture));
	assert.equal(fixture.changes.length, 3);
});

test("apply_patch renders per-file diffs from the result contract and never guesses the input patch", async () => {
	const h = await harness();
	setCapabilityOverrides({ trueColor: true });
	try {
		const input = "*** Begin Patch\n*** Update File: input-only.txt\n+INPUT_ONLY_MARKER\n*** End Patch";
		const tool = patchTool(h, "ap-1", input,
			result("Success. Updated the following files:\nA src/added.ts", fixture));
		const raw = tool.render(100).join("\n");
		const text = strip(raw);
		assert.ok(tool.resultRendererComponent instanceof FileResultView);
		assert.match(text, /● apply_patch \(src\/, docs\/ · 3 changes\)/);
		assert.match(text, /1 added, 1 updated, 1 moved · \+7 -5/);
		assert.match(text, /src\/added\.ts \(\+4 -0\)/);
		assert.match(text, /export const added = true;/);
		assert.match(text, /docs\/old-name\.md \(\+0 -3\) · source removed/);
		assert.match(text, /docs\/new-name\.md \(\+2 -1\) · existing target replaced/);
		assert.doesNotMatch(text, /INPUT_ONLY_MARKER|input-only\.txt|\*\*\*/);
		assert.match(raw, /\x1b\[48;2;0;95;0m/);
		assert.match(raw, /\x1b\[48;2;95;0;0m/);
		// ccstyle 只渲染，不注册工具、不改执行、不加全局 hook。
		assert.deepEqual(h.registered, []);
		assert.deepEqual(h.mutations, []);
		assert.equal(h.events.has("tool_result"), false);
		assert.equal(h.events.has("before_agent_start"), false);
	} finally { setCapabilityOverrides({}); await h.close(); }
});

test("summary statistics come from the tool result, not from the retained diff rows", async () => {
	const h = await harness();
	try {
		const details = detailsOf([change({ views: [view({ added: 17, removed: 3, diff: " 1 keep\n-2 old\n+2 new" })] })]);
		const tool = patchTool(h, "ap-stats", "*** Begin Patch\n*** End Patch", result("ok", details));
		const text = render(tool);
		assert.match(text, /apply_patch \(Update · src\/a\.ts\)/);
		assert.match(text, /⎿ \+17 -3/);
		assert.match(text, /src\/a\.ts \(\+17 -3\)/);
		assert.doesNotMatch(text, /\+1 -1/);
	} finally { await h.close(); }
});

test("no-op apply_patch shows no diff, no hint and no success numbers", async () => {
	const h = await harness();
	try {
		const tool = patchTool(h, "ap-noop", "*** Begin Patch\n*** End Patch",
			result("No files were modified.", detailsOf([])));
		const raw = tool.render(100).join("\n");
		const text = strip(raw);
		assert.match(text, /No files were modified\./);
		assert.doesNotMatch(text, /click to show more/);
		assert.doesNotMatch(raw, /\x1b\[48;2;95;0;0m/);
		assert.doesNotMatch(text, /\+0 -0/);
	} finally { await h.close(); }
});

test("move over an existing target keeps both the source removal and the replaced target content", async () => {
	const h = await harness();
	try {
		const details = detailsOf([change({
			path: "docs/target.md", moveFrom: "docs/source.md",
			views: [
				view({ role: "source-delete", before: facts(), after: facts({ exists: false, bytes: 0, lines: 0, finalNewline: false }),
					added: 0, removed: 1, diff: "-1 # Source" }),
				view({ role: "destination", added: 1, removed: 1, diff: " 1 # Target\n-2 Old target line.\n+2 New content." }),
			],
		})]);
		const tool = patchTool(h, "ap-move", "*** Begin Patch\n*** End Patch", result("ok", details));
		const raw = tool.render(100).join("\n");
		const text = strip(raw);
		assert.match(text, /apply_patch \(Move · docs\/source\.md → docs\/target\.md\)/);
		assert.match(text, /\(overwrote existing file\) · \+1 -2/);
		assert.match(text, /docs\/source\.md \(\+0 -1\) · source removed/);
		assert.match(text, /docs\/target\.md \(\+1 -1\) · existing target replaced/);
		assert.match(text, /2 - Old target line\./);
		assert.match(raw, /\x1b\[48;2;95;0;0m/);
	} finally { await h.close(); }
});

test("pure moves and unchanged overwrite targets are marked as such", async () => {
	const h = await harness();
	try {
		const moved = detailsOf([change({
			path: "docs/new.md", moveFrom: "docs/old.md",
			views: [view({ role: "move", added: 0, removed: 0, diff: "" })],
		})]);
		const tool = patchTool(h, "ap-pure", "*** Begin Patch\n*** End Patch", result("ok", moved));
		const text = render(tool);
		assert.match(text, /apply_patch \(Move · docs\/old\.md → docs\/new\.md\)/);
		assert.match(text, /⎿ \+0 -0/);
		assert.match(text, /docs\/old\.md → docs\/new\.md \(\+0 -0\) · content unchanged/);
		assert.doesNotMatch(text, /48;2;/);

		const unchanged = detailsOf([change({
			path: "docs/target.md", moveFrom: "docs/source.md",
			views: [
				view({ role: "source-delete", before: facts(), after: facts({ exists: false, bytes: 0, lines: 0, finalNewline: false }),
					added: 0, removed: 2, diff: "-1 # Source\n-2 Second source line" }),
				view({ role: "destination", added: 0, removed: 0, diff: " 1 # Target\n 2 Target second line" }),
			],
		})]);
		const second = patchTool(h, "ap-unchanged", "*** Begin Patch\n*** End Patch", result("ok", unchanged));
		const unchangedText = render(second);
		assert.match(unchangedText, /docs\/target\.md \(\+0 -0\) · target content unchanged/);
		assert.match(unchangedText, /\(existing target unchanged\)/);
		assert.doesNotMatch(unchangedText, /overwrote existing file/);
		assert.doesNotMatch(unchangedText, /existing target replaced/);
	} finally { await h.close(); }
});

test("unavailable move target diffs do not assert a replacement or unchanged bytes", async () => {
	const h = await harness();
	try {
		const unknown = { availability: "omitted", reason: "cancelled", added: null, removed: null, diff: undefined };
		const tool = patchTool(h, "ap-move-unknown", "", result("ok", detailsOf([change({
			moveFrom: "source",
			views: [
				view({ ...unknown, role: "source-delete", after: facts({ exists: false }) }),
				view({ ...unknown, role: "destination" }),
			],
		})])));
		const text = render(tool);
		assert.match(text, /existing target; diff unavailable/);
		assert.match(text, /content diff unavailable/);
		assert.doesNotMatch(text, /overwrote|target replaced|target content unchanged/);
	} finally { await h.close(); }
});

test("unknown line statistics are reported as partial instead of a complete total", async () => {
	const h = await harness();
	try {
		const details = detailsOf([change({ views: [view({ added: 4, removed: null })] })]);
		const tool = patchTool(h, "ap-null", "*** Begin Patch\n*** End Patch", result("ok", details));
		const text = render(tool);
		assert.match(text, /apply_patch \(Update · src\/a\.ts\)/);
		assert.match(text, /⎿ \+4 -\? \(partial\)/);
		assert.match(text, /src\/a\.ts · statistics unavailable/);
		assert.doesNotMatch(text, /\+4 -0/);
	} finally { await h.close(); }
});

test("truncated diffs keep their notice visible in the card and the retained data in the overlay", async () => {
	const h = await harness();
	try {
		const rows = Array.from({ length: 120 }, (_, index) => `+${index + 1} line ${index + 1}`);
		rows[rows.length - 1] = "+120 RETENTION_MARKER";
		const details = detailsOf([change({
			views: [view({
				availability: "truncated", diffTotalLines: 500, added: 500, removed: 0,
				diff: rows.join("\n"),
			})],
		})]);
		const tool = patchTool(h, "ap-truncated", "*** Begin Patch\n*** End Patch", result("ok", details));
		let text = render(tool);
		assert.match(text, /src\/a\.ts: diff truncated \(showing 120 of 500 lines\)/);
		assert.match(text, /13 \+ line 13/);
		assert.doesNotMatch(text, /RETENTION_MARKER/);
		assert.match(text, /click to show more/);

		let lines = h.render();
		let row = lines.findIndex((line) => line.includes("click to show more"));
		assert.ok(row >= 0, lines.join("\n"));
		h.click(lines[row]!.indexOf("click to show more"), row);
		assert.equal(tool.expanded, true, "the first hint click expands the card");
		h.tui.scrollToBottom();
		lines = h.render();
		row = lines.findIndex((line) => line.includes("click to show more"));
		assert.ok(row >= 0, lines.join("\n"));
		h.click(lines[row]!.indexOf("click to show more"), row);
		assert.ok(h.overlay, "the expanded hint opens the retained-data overlay");
		assert.match(h.overlay!.render(100).map(strip).join("\n"),
			/showing retained tool data only; not a complete source diff/);
		h.overlay!.handleInput?.("\x1b[F");
		const overlay = h.overlay!.render(100).map(strip).join("\n");
		assert.match(overlay, /RETENTION_MARKER/);
		assert.match(overlay, /diff truncated \(showing 120 of 500 lines\)/);
		h.overlay!.handleInput?.("\x1b");
	} finally { await h.close(); }
});

test("long diff lines wrap inside the card and only overflow into the overlay when the row budget is spent", async () => {
	const h = await harness();
	try {
		const content = "X".repeat(300) + " WIDTH_MARKER";
		const tool = patchTool(h, "ap-long-line", "", result("ok", detailsOf([change({
			views: [view({ diff: "-1 old\n+1 " + content })],
		})])));
		const text = render(tool);
		assert.match(text, /WIDTH_MARKER/, "wrapped continuation rows stay inside the card");
		assert.doesNotMatch(text, /…/, "wrapping does not leave a width ellipsis behind");
		assert.doesNotMatch(text, /click to show more/, "wrapping alone is not clipping");
		const rows = tool.render(100);
		assert.ok(rows.every((line: string) => visibleWidth(line) <= 100));
		const wrapped = rows.filter((line: string) => line.includes("XXXX"));
		assert.ok(wrapped.length > 1, "the long line wraps onto continuation rows");
		assert.ok(wrapped.every((line: string) => strip(line).includes(" + ")), "continuation rows keep the sign marker");

		const many = Array.from({ length: 60 }, (_, index) => `+${index + 1} ${'Y'.repeat(120)} tail-${index + 1}`);
		const big = patchTool(h, "ap-big-wrap", "", result("ok", detailsOf([change({ views: [view({ diff: many.join("\n") })] })])));
		assert.match(render(big), /click to show more/, "wrapped rows beyond the budget still need the overlay hint");
		let lines = h.render();
		let row = lines.findIndex((line) => line.includes("click to show more"));
		h.click(lines[row]!.indexOf("click to show more"), row);
		assert.equal(big.expanded, true);
		h.tui.scrollToBottom();
		lines = h.render();
		row = lines.findIndex((line) => line.includes("click to show more"));
		assert.ok(row >= 0, lines.join("\n"));
		h.click(lines[row]!.indexOf("click to show more"), row);
		assert.ok(h.overlay);
		h.overlay!.render(100);
		h.overlay!.handleInput?.("\x1b[F");
		assert.match(h.overlay!.render(100).map(strip).join("\n"), /tail-60/);
		h.overlay!.handleInput?.("\x1b");

		const literal = patchTool(h, "ap-literal-ellipsis", "", result("ok", detailsOf([change({
			views: [view({ diff: "-1 old\n+1 literal … in source" })],
		})])));
		assert.doesNotMatch(render(literal), /click to show more/, "source ellipses alone do not mean clipping");
	} finally { await h.close(); }
});

test("omitted diffs and unavailable reports stay visible without inventing numbers", async () => {
	const h = await harness();
	try {
		const omitted = detailsOf([change({
			views: [view({ availability: "omitted", reason: "result-limit", added: null, removed: null, diff: undefined })],
		})]);
		const tool = patchTool(h, "ap-omitted", "*** Begin Patch\n*** End Patch", result("ok", omitted));
		const text = render(tool);
		assert.match(text, /⎿ statistics unavailable/);
		assert.match(text, /src\/a\.ts: diff omitted \(result size limit\)/);
		assert.doesNotMatch(text, /click to show more/);
		assert.doesNotMatch(text, /\+0 -0/);

		const unavailable = detailsOf([change({ views: [] })], { reportUnavailable: "diff-error" });
		const failedReport = patchTool(h, "ap-report", "*** Begin Patch\n*** End Patch",
			result("Success. Updated the following files:\nM src/a.ts", unavailable));
		const failedText = render(failedReport);
		assert.match(failedText, /apply_patch \(Update · src\/a\.ts\)/);
		assert.match(failedText, /⎿ diff data unavailable/);
		assert.match(failedText, /patch diff data unavailable/);
		assert.match(failedText, /M src\/a\.ts/);
		const missing = patchTool(h, "ap-empty-unavailable", "", result("ok",
			detailsOf([], { reportUnavailable: "diff-error" })));
		assert.match(render(missing), /Patch diff data unavailable/);
		assert.doesNotMatch(render(missing), /No files were modified/);

		// 部分视图有精确统计、其余未知时：保留已知合计，但必须标记 partial。
		const mixed = detailsOf([
			change({ views: [view({ added: 5, removed: 0 })] }),
			change({ path: "src/b.ts", views: [view({ availability: "omitted", reason: "work-limit", added: null, removed: null, diff: undefined })] }),
		]);
		const mixedTool = patchTool(h, "ap-mixed", "*** Begin Patch\n*** End Patch", result("ok", mixed));
		const mixedText = render(mixedTool);
		assert.match(mixedText, /2 updated · \+5\? -0\? \(partial\)/);
	} finally { await h.close(); }
});

test("legacy, unknown and malformed details fall back to the generic result renderer", async () => {
	const h = await harness();
	try {
		const cases: unknown[] = [
			{ changes: [change()] },
			{ format: "apply_patch.v2", changes: [change()] },
			detailsOf([{ kind: "update", path: "a.ts" }]),
			detailsOf([change({ views: [view({ added: -1 })] })]),
			detailsOf([change({ path: 123 })]),
			detailsOf([change({ moveFrom: {} })]),
			detailsOf([change({ views: [] })]),
			detailsOf([change({ views: [view({ added: 1.5 })] })]),
			detailsOf([change({ views: [view({ diff: undefined })] })]),
			detailsOf([change({ views: [view({ role: "move" })] })]),
			detailsOf([change()], { reportUnavailable: "unknown" }),
			detailsOf([change({ views: [view({ availability: "partial" })] })]),
			detailsOf([change({ views: [view({ diff: "x".repeat(80 * 1024) })] })]),
		];
		for (const [index, details] of cases.entries()) {
			const tool = patchTool(h, `ap-fallback-${index}`, "*** Begin Patch\n*** End Patch",
				result("Success. Updated the following files:\nM a.ts", details));
			const text = render(tool);
			assert.match(text, /2 lines returned/, `case ${index} should use the generic summary`);
			assert.doesNotMatch(text, /statistics unavailable|diff omitted|showing retained/, `case ${index}`);
		}
	} finally { await h.close(); }
});

test("multi-file empty operations and unavailable reports keep their A/D operation markers", async () => {
	const h = await harness();
	try {
		const empty = facts({ exists: true, bytes: 0, lines: 0, endings: { lf: 0, crlf: 0, cr: 0 }, finalNewline: false });
		const absent = { ...empty, exists: false };
		const changes = [
			change({ kind: "add", path: "new-empty", views: [view({
				before: absent, after: empty, added: 0, removed: 0, diff: "",
			})] }),
			change({ kind: "delete", path: "old-empty", views: [view({
				before: empty, after: absent, added: 0, removed: 0, diff: "",
			})] }),
		];
		const tool = patchTool(h, "ap-empty", "", result("ok", detailsOf(changes)));
		assert.match(render(tool), /A new-empty/);
		assert.match(render(tool), /D old-empty/);
		const fallback = patchTool(h, "ap-empty-fallback", "", result("ok",
			detailsOf(changes.map((item) => ({ ...item, views: [] })), { reportUnavailable: "diff-error" })));
		assert.match(render(fallback), /A new-empty/);
		assert.match(render(fallback), /D old-empty/);
	} finally { await h.close(); }
});

test("format-only move changes never claim unchanged byte content", async () => {
	const h = await harness();
	try {
		const tool = patchTool(h, "ap-format", "", result("ok", detailsOf([change({
			moveFrom: "old.ts",
			views: [view({
				role: "move", added: 0, removed: 0, diff: "",
				before: facts({ bom: true, bytes: 15 }),
				after: facts({ bom: false, bytes: 12 }),
			})],
		})])));
		assert.match(render(tool), /BOM removed/);
		assert.doesNotMatch(render(tool), /content unchanged/);
	} finally { await h.close(); }
});

test("failed apply_patch executions render the error channel, never the input patch as a diff", async () => {
	const h = await harness();
	try {
		const input = "*** Begin Patch\n*** Update File: a.ts\n+SHOULD_NOT_RENDER\n*** End Patch";
		const tool = patchTool(h, "ap-error", input,
			result("Failed to apply patch: first line\nfull diagnostic detail", {}, true));
		const raw = tool.render(100).join("\n");
		const text = strip(raw);
		assert.match(text, /Failed to apply patch: first line/);
		// 错误状态走主题的 error 角色，不再使用本模块的固定 RGB 调色板。
		assert.ok(raw.includes(theme.fg("error", "Failed to apply patch: first line")),
			"the error status uses the theme error role");
		assert.doesNotMatch(text, /SHOULD_NOT_RENDER/);
		assert.doesNotMatch(raw, /\x1b\[48;2;0;95;0m/);
		assert.match(strip(tool.resultRendererComponent.fullPreview.content.render(100).join("\n")), /full diagnostic detail/);
	} finally { await h.close(); }
});

test("ccstyle off leaves apply_patch results to the native renderer", async () => {
	const h = await harness();
	try {
		const tool = patchTool(h, "ap-off", "*** Begin Patch\n*** End Patch",
			result("Success. Updated the following files:\nM src/updated.ts", fixture));
		setConfig({ mode: "off" });
		tool.invalidate();
		const text = render(tool);
		assert.match(text, /Success\. Updated the following files:/);
		assert.doesNotMatch(text, /3 changes ·/);
		assert.doesNotMatch(text, /48;2;/);
	} finally { setConfig({ mode: "on" }); await h.close(); }
});

test("apply_patch stays outside adjacent tool groups in default mode", async () => {
	const h = await harness();
	try {
		h.tool("read", "ap-group-r1", { path: "a" }, result("first body"));
		h.tool("read", "ap-group-r2", { path: "b" }, result("second body"));
		const patch = patchTool(h, "ap-group", "*** Begin Patch\n*** End Patch", result("ok", fixture));
		const group = h.root.children.find((child) => child instanceof ToolGroupComponent) as ToolGroupComponent;
		assert.ok(group);
		assert.equal(group.children.length, 2);
		assert.ok(!group.children.includes(patch));
		assert.ok(h.root.children.includes(patch));
		assert.doesNotMatch(strip(patch.render(100).join("\n")), /apply_patch×1/);
	} finally { await h.close(); }
});

test("partial apply_patch executions show a pending status instead of a committed diff", async () => {
	const h = await harness();
	try {
		const tool = h.tool("apply_patch", "ap-pending", { input: "*** Begin Patch\n*** End Patch" }, undefined, definition);
		tool.updateResult({ content: [], isError: false }, true);
		const raw = tool.render(100).join("\n");
		const text = strip(raw);
		assert.match(text, /Applying patch…/);
		assert.doesNotMatch(text, /No files were modified|Updated src\//);
		assert.doesNotMatch(raw, /\x1b\[48;2;/);
	} finally { await h.close(); }
});

test("large multi-file batches stay within the row budget while every omitted notice remains reachable", async () => {
	const h = await harness();
	try {
		const changes = Array.from({ length: 10 }, (_, index) => change({
			path: `src/file-${index}.ts`,
			views: [view({ availability: "omitted", reason: "work-limit", added: null, removed: null, diff: undefined })],
		}));
		const tool = patchTool(h, "ap-batch", "*** Begin Patch\n*** End Patch", result("ok", detailsOf(changes)));
		const text = render(tool);
		assert.match(text, /apply_patch \(src\/ · 10 changes\)/);
		assert.match(text, /10 updated · statistics unavailable/);
		assert.match(text, /… \+2 more notices/);
		assert.match(text, /click to show more/);
		assert.doesNotMatch(text, /src\/file-9\.ts: diff omitted/);

		let lines = h.render();
		let row = lines.findIndex((line) => line.includes("click to show more"));
		h.click(lines[row]!.indexOf("click to show more"), row);
		h.tui.scrollToBottom();
		lines = h.render();
		row = lines.findIndex((line) => line.includes("click to show more"));
		assert.ok(row >= 0, lines.join("\n"));
		h.click(lines[row]!.indexOf("click to show more"), row);
		assert.ok(h.overlay);
		const overlay = h.overlay!.render(100).map(strip).join("\n");
		assert.equal(overlay.match(/diff omitted/g)?.length, 10);
		h.overlay!.handleInput?.("\x1b");
	} finally { await h.close(); }
});

test("hidden move-overwrite views are counted as entries rather than file operations", async () => {
	const h = await harness();
	try {
		const empty = facts({ bytes: 0, lines: 0, endings: { lf: 0, crlf: 0, cr: 0 }, finalNewline: false });
		const changes = Array.from({ length: 8 }, (_, i) => change({
			path: `to-${i}`, moveFrom: `from-${i}`,
			views: [
				view({ role: "source-delete", before: empty, after: { ...empty, exists: false }, added: 0, removed: 0, diff: "" }),
				view({ role: "destination", before: empty, after: empty, added: 0, removed: 0, diff: "" }),
			],
		}));
		const tool = patchTool(h, "ap-hidden-views", "", result("ok", detailsOf(changes)));
		assert.match(render(tool), /apply_patch \(\.\/ · 8 changes\)/);
		assert.match(render(tool), /8 moved ·/);
		assert.match(render(tool), /more entries/);
		assert.doesNotMatch(render(tool), /more files/);
	} finally { await h.close(); }
});

test("compact mode keeps apply_patch as an independent file card outside the round summary", async () => {
	const h = await harness({ mode: "compact" });
	try {
		const message = {
			role: "assistant", timestamp: 100, api: "openai-responses", provider: "openai", model: "fixture",
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "ap", name: "apply_patch", arguments: { input: "*** Begin Patch\n*** End Patch" } }],
		} as any;
		const assistant = new AssistantMessageComponent(message, true) as any;
		h.root.addChild(assistant);
		const tool = patchTool(h, "ap", "*** Begin Patch\n*** End Patch",
			result("Success. Updated the following files:\nA src/added.ts", fixture));
		let lines = h.render().join("\n");
		assert.doesNotMatch(lines, /apply_patch×1/);
		assert.match(lines, /src\/added\.ts/);
		assert.match(lines, /● apply_patch \(/);

		assistant.setExpanded(true);
		lines = h.render().join("\n");
		assert.match(lines, /src\/added\.ts/);
		assert.match(lines, /source removed/);
	} finally { await h.close(); }
});

test("apply_patch layout survives narrow widths, unicode and hostile control sequences", async () => {
	const h = await harness();
	setCapabilityOverrides({ trueColor: true });
	try {
		const hostilePath = "docs/中文-📁/ev\u001b[31mil\u0007.ts";
		const hostileDiff = "+1 safe \u001b[31mred\u0007 text\n-2 old \u001b]0;title\u0007 line";
		const details = detailsOf([change({ path: hostilePath, views: [view({ diff: hostileDiff })] })]);
		const tool = patchTool(h, "ap-wide", "*** Begin Patch\n*** End Patch", result("ok", details));
		for (const width of [1, 2, 8, 16, 40, 80, 100]) {
			const lines = tool.render(width);
			assert.ok(lines.every((line: string) => visibleWidth(line) <= width), `width ${width}`);
			assert.ok(lines.every((line: string) => !line.includes("\u0007") && !line.includes("\u001b]")), `width ${width} control`);
		}
		const raw = tool.render(100).join("\n");
		const text = strip(raw);
		assert.match(text, /docs\/中文-📁\/evil\.ts/);
		assert.doesNotMatch(raw, /\u001b\[31m/);
		assert.match(raw, /\x1b\[38;2;95;215;95m/);

		setCapabilityOverrides({ trueColor: false });
		tool.invalidate();
		const fallback = tool.render(100).join("\n");
		assert.match(fallback, /\x1b\[38;5;/);
		// 正文调色板（不是主题卡头）必须遵守终端能力：本模块的 truecolor 加色不再出现。
		assert.doesNotMatch(fallback, /\x1b\[38;2;95;215;95m/);
	} finally { setCapabilityOverrides({}); await h.close(); }
});
