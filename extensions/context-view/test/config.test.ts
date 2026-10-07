import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	unlinkSync,
	utimesSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";

import {
	AUTO_COMPACT_BUFFER_CATEGORY_ID,
	ConfigStore,
	createDefaultConfigFile,
	DEFAULT_CONFIG,
	FREE_SPACE_CATEGORY_ID,
	loadConfigFile,
	resolveCategoryColor,
} from "../src/config.ts";

/** Create one isolated override path and remove its directory after the test. */
function createConfigPath(context: TestContext): string {
	const directory = mkdtempSync(join(tmpdir(), "context-view-config-"));
	context.after(() => rmSync(directory, { recursive: true, force: true }));
	return join(directory, "context-view.json");
}

test("createDefaultConfigFile atomically creates every built-in default", (context) => {
	const filePath = join(dirname(createConfigPath(context)), "extensions", "context-view.json");

	assert.deepEqual(createDefaultConfigFile(filePath), { type: "created", filePath });
	const text = readFileSync(filePath, "utf8");
	assert.ok(text.endsWith("\n"));
	// Entries, not the parsed object: the file must also list keys in legend order.
	assert.deepEqual(Object.entries(JSON.parse(text)), [
		["systemPromptColor", "mdHeading"],
		["instructionFilesColor", "mdCodeBlock"],
		["skillsColor", "customMessageLabel"],
		["builtInToolsColor", "mdHeading"],
		["customToolsColor", "accent"],
		["mcpToolsColor", "mdLink"],
		["userMessagesColor", "syntaxString"],
		["assistantMessagesColor", "syntaxFunction"],
		["assistantThinkingColor", "thinkingXhigh"],
		["toolCallsColor", "syntaxKeyword"],
		["toolOutputColor", "toolOutput"],
		["extensionsColor", "syntaxType"],
		["compactedDataColor", "thinkingHigh"],
		["autoCompactBufferColor", "dim"],
		["freeSpaceColor", "dim"],
		["mapCols", 16],
		["mapRows", 16],
	]);
	assert.deepEqual(readdirSync(dirname(filePath)), ["context-view.json"]);

	const loaded = loadConfigFile(filePath);
	assert.deepEqual(loaded.warnings, []);
	assert.deepEqual(loaded.config.categoryColors, DEFAULT_CONFIG.categoryColors);
	assert.deepEqual(loaded.config.mapSize, DEFAULT_CONFIG.mapSize);

	// Repeating the command hits the write's EEXIST, the only branch that may report "exists".
	assert.deepEqual(createDefaultConfigFile(filePath), { type: "exists", filePath });
	assert.equal(readFileSync(filePath, "utf8"), text);
});

test("createDefaultConfigFile reports an unusable path instead of claiming the file exists", (context) => {
	const blockingFile = createConfigPath(context);
	writeFileSync(blockingFile, "not a directory");
	const filePath = join(blockingFile, "context-view.json");

	// mkdir reports EEXIST for a parent that is a file; only the write may mean "exists".
	const result = createDefaultConfigFile(filePath);
	assert.equal(result.type, "failed");
	assert.equal(result.filePath, filePath);
});

test("createDefaultConfigFile refuses to overwrite an existing file", (context) => {
	const filePath = createConfigPath(context);
	const existing = '{"futureSetting":true}\n';
	writeFileSync(filePath, existing);

	assert.deepEqual(createDefaultConfigFile(filePath), { type: "exists", filePath });
	assert.equal(readFileSync(filePath, "utf8"), existing);
});

test("ConfigStore picks up a file created after its first load", (context) => {
	const filePath = createConfigPath(context);
	const store = new ConfigStore(filePath);
	assert.equal(store.load().config, DEFAULT_CONFIG);

	assert.equal(createDefaultConfigFile(filePath).type, "created");

	const created = store.load();
	assert.deepEqual(created.warnings, []);
	assert.deepEqual(created.config.categoryColors, DEFAULT_CONFIG.categoryColors);
	// A re-read builds its own map; the shared default instance would prove a stale cache.
	assert.notEqual(created.config, DEFAULT_CONFIG);
});

test("loadConfigFile treats an absent override file as built-in defaults", (context) => {
	const filePath = createConfigPath(context);
	const result = loadConfigFile(filePath);

	assert.equal(result.config, DEFAULT_CONFIG);
	assert.deepEqual(result.warnings, []);
	assert.equal(resolveCategoryColor(result.config.categoryColors, "system-prompt"), "mdHeading");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "built-in-tools"), "mdHeading");
	assert.equal(resolveCategoryColor(result.config.categoryColors, AUTO_COMPACT_BUFFER_CATEGORY_ID), "dim");
	assert.equal(resolveCategoryColor(result.config.categoryColors, FREE_SPACE_CATEGORY_ID), "dim");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "unknown-category"), "muted");
});

test("loadConfigFile applies every valid flat category color override", (context) => {
	const filePath = createConfigPath(context);
	writeFileSync(filePath, JSON.stringify({
		systemPromptColor: "success",
		builtInToolsColor: "error",
		customToolsColor: "warning",
		mcpToolsColor: "muted",
		instructionFilesColor: "dim",
		skillsColor: "text",
		userMessagesColor: "thinkingText",
		assistantMessagesColor: "searchMatchText",
		assistantThinkingColor: "thinkingMax",
		toolCallsColor: "mdCode",
		toolOutputColor: "syntaxNumber",
		extensionsColor: "syntaxOperator",
		compactedDataColor: "thinkingLow",
		autoCompactBufferColor: "borderMuted",
		freeSpaceColor: "accent",
	}));

	const result = loadConfigFile(filePath);

	assert.deepEqual(result.warnings, []);
	assert.equal(resolveCategoryColor(result.config.categoryColors, "system-prompt"), "success");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "built-in-tools"), "error");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "custom-tools"), "warning");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "mcp-tools"), "muted");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "context-files"), "dim");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "skills"), "text");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "user-messages"), "thinkingText");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "assistant-messages"), "searchMatchText");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "assistant-thinking"), "thinkingMax");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "tool-calls"), "mdCode");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "tool-output"), "syntaxNumber");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "extensions"), "syntaxOperator");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "compacted-data"), "thinkingLow");
	assert.equal(resolveCategoryColor(result.config.categoryColors, AUTO_COMPACT_BUFFER_CATEGORY_ID), "borderMuted");
	assert.equal(resolveCategoryColor(result.config.categoryColors, FREE_SPACE_CATEGORY_ID), "accent");
});

test("loadConfigFile accepts scrollbar theme colors without warnings", (context) => {
	const filePath = createConfigPath(context);
	writeFileSync(filePath, JSON.stringify({
		systemPromptColor: "scrollbarTrack",
		skillsColor: "scrollbarThumb",
	}));

	const result = loadConfigFile(filePath);

	assert.deepEqual(result.warnings, []);
	assert.equal(resolveCategoryColor(result.config.categoryColors, "system-prompt"), "scrollbarTrack");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "skills"), "scrollbarThumb");
});

test("loadConfigFile accepts literal hex colors and normalizes them", (context) => {
	const filePath = createConfigPath(context);
	writeFileSync(filePath, JSON.stringify({
		systemPromptColor: "#7AA2F7",
		skillsColor: "#f0a",
		freeSpaceColor: "#000000",
	}));

	const result = loadConfigFile(filePath);

	assert.deepEqual(result.warnings, []);
	assert.equal(resolveCategoryColor(result.config.categoryColors, "system-prompt"), "#7aa2f7");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "skills"), "#ff00aa");
	assert.equal(resolveCategoryColor(result.config.categoryColors, FREE_SPACE_CATEGORY_ID), "#000000");
});

test("loadConfigFile ignores invalid entries without discarding valid siblings", (context) => {
	const filePath = createConfigPath(context);
	writeFileSync(filePath, JSON.stringify({
		systemPromptColor: "success",
		skillsColor: "#ff00f",
		instructionFilesColor: "crimson",
		userMessagesColor: 42,
		unknownColor: "accent",
	}));

	const result = loadConfigFile(filePath);

	assert.equal(resolveCategoryColor(result.config.categoryColors, "system-prompt"), "success");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "skills"), "customMessageLabel");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "context-files"), "mdCodeBlock");
	assert.equal(resolveCategoryColor(result.config.categoryColors, "user-messages"), "syntaxString");
	assert.equal(result.warnings.length, 4);
	assert.ok(result.warnings.some((warning) => warning.includes("skillsColor")));
	assert.ok(result.warnings.some((warning) => warning.includes("instructionFilesColor")));
	assert.ok(result.warnings.some((warning) => warning.includes("userMessagesColor")));
	assert.ok(result.warnings.some((warning) => warning.includes("unknownColor")));
});

test("loadConfigFile applies map size overrides", (context) => {
	const filePath = createConfigPath(context);
	writeFileSync(filePath, JSON.stringify({ mapCols: 24, mapRows: 8 }));

	const result = loadConfigFile(filePath);

	assert.deepEqual(result.warnings, []);
	assert.deepEqual(result.config.mapSize, { columns: 24, rows: 8 });
});

test("loadConfigFile keeps the default for an unusable map size and warns once", (context) => {
	const filePath = createConfigPath(context);
	const cases: Array<readonly [string, unknown]> = [
		["below the minimum", 1],
		["above the maximum", 65],
		["fractional", 12.5],
		["a numeric string", "12"],
	];

	for (const [reason, value] of cases) {
		writeFileSync(filePath, JSON.stringify({ mapCols: value, mapRows: 12 }));
		const result = loadConfigFile(filePath);

		assert.deepEqual(result.config.mapSize, { columns: DEFAULT_CONFIG.mapSize.columns, rows: 12 }, reason);
		assert.deepEqual(result.warnings, [
			'Ignoring invalid size for "mapCols"; expected an integer between 4 and 64.',
		], reason);
	}
});

test("loadConfigFile degrades invalid JSON and non-object roots to defaults", (context) => {
	const filePath = createConfigPath(context);
	writeFileSync(filePath, "{");
	const invalidJson = loadConfigFile(filePath);
	assert.equal(invalidJson.config, DEFAULT_CONFIG);
	assert.equal(invalidJson.warnings.length, 1);
	assert.match(invalidJson.warnings[0] ?? "", /Cannot parse/);

	writeFileSync(filePath, "[]");
	const invalidRoot = loadConfigFile(filePath);
	assert.equal(invalidRoot.config, DEFAULT_CONFIG);
	assert.deepEqual(invalidRoot.warnings, [
		"context-view.json must contain a JSON object. Using default configuration.",
	]);
});

test("ConfigStore warns once per revision and reloads after mtime changes", (context) => {
	const filePath = createConfigPath(context);
	writeFileSync(filePath, JSON.stringify({ unknownColor: "accent" }));
	const store = new ConfigStore(filePath);

	const first = store.load();
	assert.equal(first.warnings.length, 1);
	assert.deepEqual(store.load().warnings, []);

	writeFileSync(filePath, JSON.stringify({ systemPromptColor: "success" }));
	const future = new Date(Date.now() + 2_000);
	utimesSync(filePath, future, future);
	const changed = store.load();
	assert.deepEqual(changed.warnings, []);
	assert.equal(resolveCategoryColor(changed.config.categoryColors, "system-prompt"), "success");

	unlinkSync(filePath);
	const removed = store.load();
	assert.equal(removed.config, DEFAULT_CONFIG);
	assert.deepEqual(removed.warnings, []);
});

for (const [label, content] of [
	["oversized JSON", '{"systemPromptColor":"accent"}' + " ".repeat(64 * 1024)],
	["invalid UTF-8", Buffer.concat([Buffer.from('{"systemPromptColor":"accent","unused":"'), Buffer.from([0xff]), Buffer.from('"}')])],
] as const) {
	test(`unusable preferences (${label}) fall back before applying overrides`, (context) => {
		const filePath = createConfigPath(context);
		writeFileSync(filePath, content);
		const result = loadConfigFile(filePath);
		assert.deepEqual(result.config, DEFAULT_CONFIG);
		assert.equal(result.warnings.length, 1);
		assert.match(result.warnings[0]!, /Using default configuration/);
	});
}

test("a directory preference path is rejected and explicit creation leaves it unchanged", (context) => {
	const filePath = createConfigPath(context);
	mkdirSync(filePath);
	assert.deepEqual(loadConfigFile(filePath).config, DEFAULT_CONFIG);
	assert.equal(loadConfigFile(filePath).warnings.length, 1);
	assert.deepEqual(createDefaultConfigFile(filePath), { type: "exists", filePath });
	assert.deepEqual(readdirSync(filePath), []);
});

test("concurrent explicit creators have one winner and never replace the completed preferences", { timeout: 15000 }, async (context) => {
	const filePath = createConfigPath(context);
	const source = `import {createDefaultConfigFile} from ${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)};
		process.stdout.write("ready\\n");
		process.stdin.once("data", () => { process.stdout.write(createDefaultConfigFile(process.argv[1]).type); process.stdin.destroy(); });`;
	const children = Array.from({ length: 3 }, () => spawn(process.execPath, ["--input-type=module", "-e", source, filePath], {
		stdio: ["pipe", "pipe", "pipe"],
	}));
	const timer = setTimeout(() => children.forEach((child) => child.kill("SIGKILL")), 12000);
	try {
		const completions = children.map((child) => {
			let stdout = "", stderr = "";
			const ready = new Promise<void>((resolve) => child.stdout.on("data", (chunk) => {
				stdout += chunk;
				if (stdout.includes("ready\n")) resolve();
			}));
			child.stderr.on("data", (chunk) => { stderr += chunk; });
			const completed = new Promise<string>((resolve, reject) => {
				child.once("error", reject);
				child.once("close", (code) => code === 0 ? resolve(stdout.replace("ready\n", "")) : reject(new Error(stderr || `creator exit ${code}`)));
			});
			void completed.catch(() => {});
			return { ready, completed };
		});
		await Promise.all(completions.map(({ ready, completed }) => Promise.race([ready, completed.then(() => {})])));
		children.forEach((child) => child.stdin.end("create"));
		assert.deepEqual((await Promise.all(completions.map(({ completed }) => completed))).sort(), ["created", "exists", "exists"]);
		const original = readFileSync(filePath, "utf8");
		assert.equal(JSON.parse(original).mapRows, 16);
		assert.equal(createDefaultConfigFile(filePath).type, "exists");
		assert.equal(readFileSync(filePath, "utf8"), original);
	} finally {
		clearTimeout(timer);
		await Promise.all(children.map((child) => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
			child.kill("SIGKILL");
			return closed;
		}));
	}
});

test("a symlink preference path is never replaced by explicit creation", (context) => {
	const filePath = createConfigPath(context);
	const target = `${filePath}.target`;
	writeFileSync(target, "existing preferences");
	symlinkSync(target, filePath);
	assert.deepEqual(createDefaultConfigFile(filePath), { type: "exists", filePath });
	assert.equal(readFileSync(target, "utf8"), "existing preferences");
});

test("FIFO preferences degrade without blocking or consuming a stream", { skip: process.platform === "win32", timeout: 3000 }, (context) => {
	const filePath = createConfigPath(context);
	assert.equal(spawnSync("mkfifo", [filePath], { timeout: 1000 }).status, 0);
	const result = loadConfigFile(filePath);
	assert.deepEqual(result.config, DEFAULT_CONFIG);
	assert.match(result.warnings[0]!, /Not a regular file/);
});
