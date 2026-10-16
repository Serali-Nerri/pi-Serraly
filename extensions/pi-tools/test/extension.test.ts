import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { discoverAndLoadExtensions, type ExtensionAPI, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import toolsExtension from "../src/index.ts";
import { PATCH_GRAMMAR } from "../src/grammar.ts";
import type { ApplyPatchReport } from "pi-apply-patch-protocol";

function registeredTools(): ToolDefinition<any, any>[] {
	const tools: ToolDefinition<any, any>[] = [];
	// Any accidental calls to setActiveTools/registerFlag/on would fail here.
	const api: Pick<ExtensionAPI, "registerTool"> = { registerTool: (tool) => { tools.push(tool); } };
	toolsExtension(api as ExtensionAPI);
	return tools;
}

function registeredTool(name = "apply_patch"): ToolDefinition<any, any> {
	const tool = registeredTools().find((candidate) => candidate.name === name);
	assert.ok(tool, name);
	return tool;
}

interface FileSnapshot {
	bytes: Buffer;
	ino: bigint;
	mtimeNs: bigint;
}

/** Bytes plus identity/times, so a no-op patch can prove it never wrote. */
async function snapshotFile(path: string): Promise<FileSnapshot> {
	const [bytes, stats] = await Promise.all([readFile(path), lstat(path, { bigint: true })]);
	return { bytes, ino: stats.ino, mtimeNs: stats.mtimeNs };
}

function executePatch(input: string, cwd: string) {
	return registeredTool().execute("id", { input }, undefined, undefined, { cwd } as ExtensionToolContext);
}

function summary(details: ApplyPatchReport) {
	assert.equal(details.format, "apply_patch.v1");
	return details.changes.map(({ views: _views, ...change }) => change);
}

test("registers apply_patch first, with one string input and grammar fallback schema", () => {
	const tool = registeredTool();
	assert.equal(tool.name, "apply_patch");
	assert.equal(tool.exposure, "direct");
	assert.equal(tool.namespace?.name, "patches");
	assert.deepEqual(tool.parameters.required, ["input"]);
	assert.deepEqual(Object.keys(tool.parameters.properties), ["input"]);
	assert.equal(tool.parameters.properties.input.type, "string");
	assert.equal(tool.parameters.additionalProperties, false);
	assert.deepEqual(tool.constrainedSampling, { type: "grammar", variants: { openai_lark: PATCH_GRAMMAR } });
	assert.equal(tool.renderCall, undefined);
	assert.equal(tool.renderResult, undefined);
	// This description must work for both custom grammar tools and JSON fallback.
	assert.doesNotMatch(tool.description, /do not wrap.*JSON|NEVER.*JSON/i);
});

test("registers grep, find and ls as codemode replacements for the built-in tools", () => {
	const tools = registeredTools();
	assert.deepEqual(tools.map((tool) => tool.name), ["apply_patch", "grep", "find", "ls"]);
	for (const tool of tools.slice(1)) {
		assert.equal(tool.exposure, "codemode");
		assert.equal(tool.namespace?.name, "filesystem");
		assert.equal(tool.renderCall, undefined);
		assert.equal(tool.renderResult, undefined);
		assert.equal(tool.renderShell, undefined);
	}
});

test("executes ls against ctx.cwd instead of the registration directory", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-tools-filesystem-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "visible.txt"), "x\n");
	await mkdir(join(root, "nested"));
	const result = await registeredTool("ls").execute("id", { path: "." }, undefined, undefined, { cwd: root } as ExtensionToolContext);
	const output = result.content[0]?.type === "text" ? result.content[0].text : "";
	assert.match(output, /nested\//);
	assert.match(output, /visible\.txt/);
});

test("executes in ctx.cwd and reports the changed files", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-apply-patch-extension-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const result = await registeredTool().execute("id", {
		input: "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch",
	}, undefined, undefined, { cwd: root } as ExtensionToolContext);
	assert.equal(await readFile(join(root, "hello.txt"), "utf8"), "hello\n");
	assert.deepEqual(summary(result.details), [{ kind: "add", path: "hello.txt" }]);
	assert.equal(result.details.changes[0].views[0].diff, "+1 hello");
	assert.equal(result.details.changes[0].views[0].added, 1);
	assert.equal(result.details.changes[0].views[0].removed, 0);
	assert.match(result.content[0].type === "text" ? result.content[0].text : "", /A hello.txt/);
});

test("no-op update chunks report no files modified without writing bytes, inode or mtime", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-apply-patch-extension-noop-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const cases = [
		{ label: "context-only chunk", body: "@@\n alpha" },
		{ label: "identical replacement", body: "@@\n-alpha\n+alpha" },
	];
	const sources = [["lf.txt", "alpha\n"], ["unterminated.txt", "alpha"]] as const;
	for (const [name, content] of sources) {
		for (const item of cases) {
			await t.test(`${item.label} in ${name}`, async () => {
				await writeFile(join(root, name), content);
				const before = await snapshotFile(join(root, name));
				const result = await executePatch(
					`*** Begin Patch\n*** Update File: ${name}\n${item.body}\n*** End Patch`, root);
				assert.deepEqual(result.content, [{ type: "text", text: "No files were modified." }]);
				assert.deepEqual(result.details, { format: "apply_patch.v1", changes: [] });
				assert.deepEqual(await snapshotFile(join(root, name)), before);
			});
		}
	}
});

test("mixed no-op and applied updates report only the changed file", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-apply-patch-extension-mixed-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	// Unterminated source proves the no-op path is not rewritten with a newline.
	await writeFile(join(root, "noop.txt"), "alpha");
	await writeFile(join(root, "real.txt"), "old\n");
	const noopBefore = await snapshotFile(join(root, "noop.txt"));
	const result = await executePatch([
		"*** Begin Patch",
		"*** Update File: noop.txt",
		"@@",
		"-alpha",
		"+alpha",
		"*** Update File: real.txt",
		"@@",
		"-old",
		"+new",
		"*** End Patch",
	].join("\n"), root);
	assert.deepEqual(summary(result.details), [{ kind: "update", path: "real.txt" }]);
	assert.equal(result.details.changes[0].views[0].diff, "-1 old\n+1 new");
	assert.equal(await readFile(join(root, "real.txt"), "utf8"), "new\n");
	assert.deepEqual(await snapshotFile(join(root, "noop.txt")), noopBefore);
	assert.equal(
		result.content[0]?.type === "text" ? result.content[0].text : "",
		"Success. Updated the following files:\nM real.txt",
	);
});

test("move overwrite details include both removed source and the old destination", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-apply-patch-move-details-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "source"), "alpha\n");
	await writeFile(join(root, "destination"), "overwritten\n");
	const result = await executePatch(
		"*** Begin Patch\n*** Update File: source\n*** Move to: destination\n@@\n-alpha\n+bravo\n*** End Patch", root,
	);
	assert.deepEqual(summary(result.details), [{ kind: "update", path: "destination", moveFrom: "source", contentChanged: true }]);
	const views = (result.details as ApplyPatchReport).changes[0].views;
	assert.deepEqual(views.map(({ role, diff }) => ({ role, diff })), [
		{ role: "source-delete", diff: "-1 alpha" },
		{ role: "destination", diff: "-1 overwritten\n+1 bravo" },
	]);
	assert.equal(
		result.content[0].type === "text" ? result.content[0].text : "",
		"Success. Updated the following files:\nM destination (from source)",
	);
	// Model-facing text contains no new diff body.
	assert.doesNotMatch(JSON.stringify(result.content), /alpha|bravo|overwritten/);
});

test("a pure move reports contentChanged false from committed bytes", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-apply-patch-pure-move-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "source"), "alpha\n");
	const result = await executePatch(
		"*** Begin Patch\n*** Update File: source\n*** Move to: destination\n@@\n-alpha\n+alpha\n*** End Patch", root,
	);
	assert.deepEqual(summary(result.details), [
		{ kind: "update", path: "destination", moveFrom: "source", contentChanged: false },
	]);
	const [view] = (result.details as ApplyPatchReport).changes[0].views;
	assert.equal(view.role, "move");
	assert.equal(view.added, 0);
	assert.equal(view.removed, 0);
	assert.equal(view.lineEndingsChanged, false);
	assert.equal(await readFile(join(root, "destination"), "utf8"), "alpha\n");
	await assert.rejects(readFile(join(root, "source"), "utf8"), { code: "ENOENT" });
});

test("separate update and move hunks report one moved content update in either order", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-apply-patch-ordered-move-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const hunks of [
		"*** Update File: source\n@@\n-old\n+new\n*** Update File: source\n*** Move to: destination\n@@\n new",
		"*** Update File: source\n*** Move to: destination\n@@\n old\n*** Update File: destination\n@@\n-old\n+new",
	]) {
		await rm(join(root, "destination"), { force: true });
		await writeFile(join(root, "source"), "old\n");
		const result = await executePatch(`*** Begin Patch\n${hunks}\n*** End Patch`, root);
		assert.deepEqual(summary(result.details), [
			{ kind: "update", path: "destination", moveFrom: "source", contentChanged: true },
		]);
		assert.equal(result.details.changes[0].views[0].diff, "-1 old\n+1 new");
		assert.equal(await readFile(join(root, "destination"), "utf8"), "new\n");
	}
});

test("format-only changes expose byte metadata rather than a misleading no-op", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-apply-patch-format-details-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "file"), "\uFEFFalpha\r\n");
	const result = await executePatch("*** Begin Patch\n*** Add File: file\n+alpha\n*** End Patch", root);
	assert.deepEqual(summary(result.details), [{ kind: "update", path: "file" }]);
	const view = (result.details as ApplyPatchReport).changes[0].views[0];
	assert.equal(view.added, 0);
	assert.equal(view.removed, 0);
	assert.equal(view.diff, "");
	assert.equal(view.before.bom, true);
	assert.equal(view.after.bom, false);
	assert.equal(view.before.endings.crlf, 1);
	assert.equal(view.after.endings.lf, 1);
	assert.equal(view.lineEndingsChanged, true);
	assert.equal(await readFile(join(root, "file"), "utf8"), "alpha\n");
});

test("large reports are bounded without changing the model-facing result or writes", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-apply-patch-large-details-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const body = Array.from({ length: 900 }, (_, i) => `line ${i}`).join("\n");
	const result = await executePatch(
		`*** Begin Patch\n*** Add File: large\n+${body.replaceAll("\n", "\n+")}\n*** Add File: after\n+done\n*** End Patch`, root,
	);
	assert.deepEqual(summary(result.details), [{ kind: "add", path: "large" }, { kind: "add", path: "after" }]);
	const view = (result.details as ApplyPatchReport).changes[0].views[0];
	assert.equal(view.added, 900);
	assert.equal(view.availability, "truncated");
	assert.ok((view.diff ?? "").split("\n").length <= 200);
	assert.equal(await readFile(join(root, "large"), "utf8"), body + "\n");
	assert.equal(await readFile(join(root, "after"), "utf8"), "done\n");
	assert.equal(result.content[0].type === "text" ? result.content[0].text : "",
		"Success. Updated the following files:\nA large\nA after");
});

test("real tool execution reports distant small edits instead of a computation-limit omission", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-apply-patch-sparse-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const before = Array.from({ length: 600 }, (_, index) => `line ${index + 1}`);
	await writeFile(join(root, "document.md"), before.join("\n") + "\n");
	const result = await executePatch(
		"*** Begin Patch\n*** Update File: document.md\n@@\n-line 6\n+changed first\n@@\n-line 591\n+changed last\n*** End Patch", root,
	);
	const after = [...before];
	after[5] = "changed first";
	after[590] = "changed last";
	assert.equal(await readFile(join(root, "document.md"), "utf8"), after.join("\n") + "\n");
	assert.equal(result.content[0].type === "text" ? result.content[0].text : "",
		"Success. Updated the following files:\nM document.md");
	const view = (result.details as ApplyPatchReport).changes[0].views[0];
	assert.equal(view.availability, "complete");
	assert.equal(view.added, 2);
	assert.equal(view.removed, 2);
	assert.match(view.diff ?? "", /changed first/);
	assert.match(view.diff ?? "", /changed last/);
});

test("exceeding the search budget cannot turn a committed overwrite into a tool failure", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-apply-patch-search-limit-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const before = Array.from({ length: 600 }, (_, index) => `old ${index}\n`).join("");
	const after = Array.from({ length: 600 }, (_, index) => `new ${index}\n`).join("");
	await writeFile(join(root, "document.md"), before);
	const result = await executePatch(
		"*** Begin Patch\n*** Add File: document.md\n+" + after.trimEnd().replaceAll("\n", "\n+") + "\n*** End Patch", root,
	);
	assert.equal(await readFile(join(root, "document.md"), "utf8"), after);
	assert.equal(result.content[0].type === "text" ? result.content[0].text : "",
		"Success. Updated the following files:\nM document.md");
	const view = (result.details as ApplyPatchReport).changes[0].views[0];
	assert.equal(view.availability, "omitted");
	assert.equal(view.reason, "work-limit");
	assert.equal(view.added, null);
	assert.equal(view.removed, null);
	assert.equal(result.details.reportUnavailable, undefined);
});

test("actual tool execution produces the shared v1 contract fixture", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-apply-patch-contract-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "src"));
	await mkdir(join(root, "docs"));
	await writeFile(join(root, "src/updated.ts"), "const keep = true;\nconst value = 1;\n");
	await writeFile(join(root, "docs/old-name.md"), "# Old name\nMoved content.\nSecond line.\n");
	await writeFile(join(root, "docs/new-name.md"), "# New name\nOld target line.\n");
	const result = await executePatch([
		"*** Begin Patch",
		"*** Add File: src/added.ts",
		"+export const added = true;",
		"+export const value = 41;",
		"+export const isReady = added && value === 41;",
		"+export default isReady;",
		"*** Update File: src/updated.ts",
		"@@",
		" const keep = true;",
		"-const value = 1;",
		"+const value = 2;",
		"*** Update File: docs/old-name.md",
		"*** Move to: docs/new-name.md",
		"@@",
		"-# Old name",
		"+# New name",
		"*** End Patch",
	].join("\n"), root);
	const expected = JSON.parse(await readFile(new URL("./fixtures/apply-patch-v1.json", import.meta.url), "utf8"));
	assert.deepEqual(result.details, expected);
});

test("loads the workspace source through Pi's real loader and preserves no-op bytes", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-apply-patch-loader-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	await mkdir(agentDir);
	const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
	const loaded = await discoverAndLoadExtensions([entry], root, agentDir);
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	const extension = loaded.extensions[0];
	assert.deepEqual([...extension.tools.keys()], ["apply_patch", "grep", "find", "ls"]);
	const added = await extension.tools.get("apply_patch")!.definition.execute("loader-test", {
		input: "*** Begin Patch\n*** Add File: loaded.txt\n+loaded\n*** End Patch",
	}, undefined, undefined, { cwd: root } as ExtensionToolContext);
	assert.equal(await readFile(join(root, "loaded.txt"), "utf8"), "loaded\n");
	assert.equal((added.details as ApplyPatchReport).format, "apply_patch.v1");
	assert.equal((added.details as ApplyPatchReport).changes[0].views[0].diff, "+1 loaded");

	const updated = await extension.tools.get("apply_patch")!.definition.execute("loader-diff", {
		input: "*** Begin Patch\n*** Update File: loaded.txt\n@@\n-loaded\n+changed\n*** End Patch",
	}, undefined, undefined, { cwd: root } as ExtensionToolContext);
	assert.equal((updated.details as ApplyPatchReport).changes[0].views[0].diff, "-1 loaded\n+1 changed");

	// The loaded tool must not add a newline to an all-no-op update of an
	// unterminated source file.
	await writeFile(join(root, "unterminated.txt"), "alpha");
	const before = await snapshotFile(join(root, "unterminated.txt"));
	const noop = await extension.tools.get("apply_patch")!.definition.execute("loader-noop", {
		input: "*** Begin Patch\n*** Update File: unterminated.txt\n@@\n-alpha\n+alpha\n*** End Patch",
	}, undefined, undefined, { cwd: root } as ExtensionToolContext);
	assert.deepEqual(noop.content, [{ type: "text", text: "No files were modified." }]);
	assert.deepEqual(noop.details, { format: "apply_patch.v1", changes: [] });
	assert.deepEqual(await snapshotFile(join(root, "unterminated.txt")), before);
});

test("failed patches throw a bounded tool error rather than a success result", async () => {
	await assert.rejects(registeredTool().execute("id", { input: "x".repeat(100_000) }, undefined, undefined, {
		cwd: tmpdir(),
	} as ExtensionToolContext), (error: Error) => {
		assert.ok(error.message.length < 20_000);
		assert.match(error.message, /Begin Patch/);
		return true;
	});
});
