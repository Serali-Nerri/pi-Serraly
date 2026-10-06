import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { CombinedAutocompleteProvider, visibleWidth } from "@earendil-works/pi-tui";
import { harness, references } from "./harness.ts";

test("completion displays safe bounded titles and distinguishing metadata but inserts a stable ID and delegates native files", async (t) => {
	const h = await harness(t, "tui");
	const name = "\x1b[31m界🚀".repeat(40) + "\x1b[0m\u202e\nunsafe";
	const selected = h.source("SELECTED BODY", name);
	const other = h.source("OTHER BODY", name);
	await h.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
	assert.ok(h.factories.length > 0);
	// The host's @file provider requires fd. This local filesystem-boundary stand-in lists only the fixture cwd.
	const fd = join(h.root, "fd.mjs");
	await writeFile(fd, '#!/usr/bin/env node\nimport { readdirSync } from "node:fs";\nconst args = process.argv.slice(2);\nconst dir = args[args.indexOf("--base-directory") + 1];\nfor (const name of readdirSync(dir)) process.stdout.write(name + "\\0");\n');
	await chmod(fd, 0o700);
	const native = new CombinedAutocompleteProvider([], h.cwd, fd);
	const provider = h.factories.at(-1)!(native);
	const options = { signal: new AbortController().signal };
	const prefix = "@session:";
	const result = await provider.getSuggestions(["Choose " + prefix], 0, 7 + prefix.length, options);
	assert.ok(result);
	assert.equal(result.prefix, prefix);
	assert.equal(result.items.length, 2);
	for (const item of result.items) {
		assert.ok(visibleWidth(item.label) <= 32);
		assert.doesNotMatch(item.label + item.description, /[\x00-\x1f\x7f\u202e]/);
		assert.match(item.description!, /Updated:/);
		assert.match(item.description!, /Workspace:/);
	}
	const candidate = result.items.find((item) => item.value.includes(selected.getSessionId()))!;
	assert.ok(candidate);
	const completed = provider.applyCompletion(["Choose " + prefix + " suffix"], 0, 7 + prefix.length, candidate, result.prefix);
	assert.equal(completed.lines[0], `Choose @session:[${selected.getSessionId()}] suffix`);
	selected.appendSessionInfo("Renamed title");
	await h.session.prompt(completed.lines[0]);
	assert.match(String(references(h)[0].content), /SELECTED BODY/);
	assert.doesNotMatch(String(references(h)[0].content), /OTHER BODY/);
	assert.ok(other.getSessionId() !== selected.getSessionId());
	await writeFile(join(h.cwd, "ordinary.txt"), "fixture");
	const files = await native.getSuggestions(["@ordinary"], 0, 9, options);
	assert.deepEqual(await provider.getSuggestions(["@ordinary"], 0, 9, options), files);
	assert.ok(files?.items.length);
	assert.deepEqual(provider.applyCompletion(["@ordinary"], 0, 9, files.items[0], files.prefix),
		native.applyCompletion(["@ordinary"], 0, 9, files.items[0], files.prefix));
	assert.equal(provider.shouldTriggerFileCompletion?.([prefix], 0, prefix.length), false);
});

test("completing inside a bracketed reference replaces its entire token and preserves surrounding prose and cursor", async (t) => {
	const h = await harness(t, "tui");
	const selected = h.source("SELECTED FROM MID-TOKEN", "abcd candidate");
	await h.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
	const provider = h.factories.at(-1)!(new CombinedAutocompleteProvider([], h.cwd));
	const options = { signal: new AbortController().signal };
	const token = `@session:[${selected.getSessionId()}]`;
	let completedText = "";
	for (const left of ["Choose @session:[ab", "Choose @session:[abcd", "Choose @session:[abcd]"]) {
		const lines = ["Previous line", "Choose @session:[abcd] suffix @ordinary [keep]", "Following line"];
		const suggestions = await provider.getSuggestions(lines, 1, left.length, options);
		assert.ok(suggestions);
		const candidate = suggestions.items.find((item) => item.value === token);
		assert.ok(candidate);
		const completed = provider.applyCompletion(lines, 1, left.length, candidate, suggestions.prefix);
		assert.deepEqual(completed, {
			lines: ["Previous line", `Choose ${token} suffix @ordinary [keep]`, "Following line"],
			cursorLine: 1, cursorCol: 7 + token.length,
		});
		completedText = completed.lines[1];
	}
	await h.session.prompt(completedText);
	assert.match(String(references(h)[0]?.content), /SELECTED FROM MID-TOKEN/);
});

test("an SDK's managed collection uses its own agent directory across workspaces without importing source resources", async (t) => {
	for (const history of ["managed", "memory"] as const) {
		await t.test(history, async (t) => {
			const h = await harness(t, "tui", history);
			const source = h.source("CROSS-WORKSPACE CONTEXT", "Foreign workspace");
			await mkdir(join(source.getCwd(), ".pi"), { recursive: true });
			await writeFile(join(source.getCwd(), "AGENTS.md"), "SOURCE RESOURCE MUST NOT LOAD");
			await writeFile(join(source.getCwd(), ".pi", "settings.json"), '{"systemPrompt":"SOURCE SETTINGS MUST NOT LOAD"}');
			await h.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
			const provider = h.factories.at(-1)!(new CombinedAutocompleteProvider([], h.cwd));
			const result = await provider.getSuggestions(["@session:"], 0, 9, { signal: new AbortController().signal });
			assert.ok(result?.items.some((item) => item.value.includes(source.getSessionId())));
			await h.session.prompt(`@session:[${source.getSessionId()}]`);
			assert.match(JSON.stringify(h.requests[0]), /CROSS-WORKSPACE CONTEXT/);
			assert.doesNotMatch(JSON.stringify(h.requests[0]), /SOURCE (?:RESOURCE|SETTINGS) MUST NOT LOAD/);
		});
	}
});
