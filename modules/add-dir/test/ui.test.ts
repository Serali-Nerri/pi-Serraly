import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { CombinedAutocompleteProvider, visibleWidth, type AutocompleteProvider } from "@earendil-works/pi-tui";
import { sanitize } from "../src/presentation.ts";
import { addDirHarness } from "./harness.ts";

async function temporary(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-add-dir-ui-"));
	t.after(async () => {
		await rm(directory, { recursive: true, force: true });
	});
	return directory;
}

async function completionBranches(t: TestContext) {
	const agentDir = await temporary(t);
	const root = await temporary(t);
	const work = join(root, "work");
	const selected = join(root, "selected");
	const abandoned = join(root, "abandoned");
	for (const directory of [work, selected, abandoned]) {
		await mkdir(directory);
		await writeFile(join(directory, "note.md"), "");
	}
	const h = addDirHarness(t, { agentDir });
	h.state.cwd = work;
	h.state.branch = () => h.state.branchEntries;
	await h.emit("session_start");
	await h.command("dir-add", selected);
	const earlierBranch = [...h.state.branchEntries];
	h.state.select = async (_title, choices) => choices[0];
	await h.command("dir-ls", "");
	await h.command("dir-add", abandoned);
	const current = new CombinedAutocompleteProvider([], work, fileURLToPath(new URL("./fixtures/fd.mjs", import.meta.url)));
	const wrapped = h.autocompleteFactories[0]?.(current as never) as AutocompleteProvider;
	return { h, current, wrapped, earlierBranch, selected, abandoned };
}

test("escapes terminal controls and bidi overrides without touching ordinary names", () => {
	assert.equal(sanitize("plain /tmp/ok"), "plain /tmp/ok");
	assert.equal(sanitize("目录 with spaces 📁"), "目录 with spaces 📁");
	assert.equal(sanitize("repo-\u{1f469}\u200d\u{1f4bb}"), "repo-\u{1f469}\u200d\u{1f4bb}", "a ZWJ sequence stays readable");
	assert.equal(sanitize("glyph-\ue000"), "glyph-\ue000", "private-use glyphs are ordinary text");
	assert.equal(sanitize("esc\u001b[31m"), "esc\\u001b[31m");
	assert.equal(sanitize("line\u2028break"), "line\\u2028break");
	assert.equal(sanitize("rtl\u202eoverride"), "rtl\\u202eoverride");
	assert.equal(sanitize("isolate\u2066x\u2069"), "isolate\\u2066x\\u2069");
});

test("keeps state but registers no terminal UI outside the TUI", async (t) => {
	for (const [mode, hasUI] of [["rpc", true], ["print", false], ["json", false], ["tui", false]] as const) {
		const agentDir = await temporary(t);
		const directory = await temporary(t);
		const h = addDirHarness(t, { agentDir });
		h.state.mode = mode;
		h.state.hasUI = hasUI;
		await h.emit("session_start");
		await h.command("dir-add", directory);
		assert.equal(h.state.inputCalls, 0);
		assert.equal(h.autocompleteFactories.length, 0, `${mode} registers no completion`);
		assert.equal(h.widgets.size, 0, `${mode} registers no widget`);
		assert.equal(h.appendedEntries.length, 1, `${mode} still persists session state`);
	}
});

test("reports explicit diagnostics instead of dead-waiting without an interactive path prompt", async (t) => {
	const agentDir = await temporary(t);
	const h = addDirHarness(t, { agentDir });
	h.state.mode = "print";
	h.state.hasUI = false;
	await h.emit("session_start");
	const error = t.mock.method(console, "error", () => {});
	await h.command("dir-add", "");
	assert.equal(h.state.inputCalls, 0);
	assert.equal(h.notices.length, 0, "non-UI notifications do not touch the host UI");
	assert.equal(error.mock.callCount(), 1);
	assert.match(String(error.mock.calls[0]?.arguments[0]), /dir-add \[--project \| --global\] <path>/);
});

test("lists external directories without a selector in non-interactive mode", async (t) => {
	const agentDir = await temporary(t);
	const directory = await temporary(t);
	const h = addDirHarness(t, { agentDir });
	h.state.mode = "print";
	h.state.hasUI = false;
	await h.emit("session_start");
	await h.command("dir-add", directory);
	const error = t.mock.method(console, "error", () => {});
	await h.command("dir-ls", "");
	assert.equal(h.state.selectCalls, 0);
	assert.ok(error.mock.callCount() >= 1);
	assert.match(String(error.mock.calls.map((call) => call.arguments[0]).join("\n")), /\[session\]/);
});

test("prompts for a missing path when the interaction channel exists", async (t) => {
	const agentDir = await temporary(t);
	const directory = await temporary(t);
	const h = addDirHarness(t, { agentDir });
	h.state.mode = "rpc";
	h.state.hasUI = true;
	await h.emit("session_start");
	await h.command("dir-add", "");
	assert.equal(h.state.inputCalls, 1, "the interactive channel is asked for the path");
	assert.equal(h.appendedEntries.length, 0, "an empty answer cancels without touching state");
	h.state.input = async () => directory;
	await h.command("dir-add", "");
	assert.equal(h.state.inputCalls, 2);
	assert.equal(h.appendedEntries.length, 1, "the prompted path is persisted");
	assert.equal(h.widgets.size, 0, "RPC still registers no terminal widget");
	assert.equal(h.autocompleteFactories.length, 0);
});

test("reports an empty directory list without opening a selector", async (t) => {
	const agentDir = await temporary(t);
	const h = addDirHarness(t, { agentDir });
	h.state.mode = "print";
	h.state.hasUI = false;
	await h.emit("session_start");
	const error = t.mock.method(console, "error", () => {});
	await h.command("dir-ls", "");
	assert.equal(h.state.selectCalls, 0);
	assert.match(String(error.mock.calls[0]?.arguments[0]), /No external directories added/);
});

test("shows directory names and the pending /reload marker in the widget", async (t) => {
	const agentDir = await temporary(t);
	const directory = await temporary(t);
	await mkdir(join(directory, ".pi/skills/demo"), { recursive: true });
	await writeFile(join(directory, ".pi/skills/demo/SKILL.md"), "# demo\n");
	const h = addDirHarness(t, { agentDir });
	await h.emit("session_start");
	assert.equal(h.widgets.get("add-dir"), undefined, "no widget without directories");
	await h.command("dir-add", directory);
	const lines = h.renderWidget(200).join("\n");
	assert.match(lines, /1 external dir/);
	assert.match(lines, new RegExp(directory.split("/").at(-1) ?? ""));
	assert.match(lines, /\/reload/);
	h.state.select = async (_title, choices) => choices[0];
	await h.command("dir-ls", "");
	assert.equal(h.widgets.get("add-dir"), undefined, "the widget clears with the last directory");
});

test("renders within narrow widths and unusual labels", async (t) => {
	const agentDir = await temporary(t);
	const root = await temporary(t);
	const directory = join(root, "目录 with spaces 📁");
	await mkdir(directory, { recursive: true });
	const h = addDirHarness(t, { agentDir });
	await h.emit("session_start");
	await h.command("dir-add", directory);
	const wide = h.renderWidget(200);
	assert.ok(wide.length === 1, "the widget renders one line when it fits");
	assert.match(wide[0] ?? "", /目录 with spaces 📁/);
	for (const width of [1, 8, 20, 40]) {
		const lines = h.renderWidget(width);
		assert.ok(lines.length >= 1, `width ${width} renders`);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`);
		}
	}
});

test("autocomplete rebinds to a host-side branch switch before event delivery", async (t) => {
	const { h, wrapped, earlierBranch, selected } = await completionBranches(t);
	h.navigate(earlierBranch);
	const suggestions = await wrapped.getSuggestions(["@no"], 0, 3, { signal: new AbortController().signal });
	assert.deepEqual(
		suggestions?.items.map((item) => item.value),
		["@note.md", `@${selected}/note.md`],
		"the local candidate and A's directory survive, not B's abandoned directory",
	);
	assert.equal(h.appendedEntries.length, 3, "completion reads never append session state");
});

for (const navigation of ["pending tree event", "delivered tree event", "replaced session", "pending session event"] as const) {
	test(`autocomplete discards abandoned external results after a ${navigation}`, async (t) => {
		const { h, current, wrapped, earlierBranch, selected, abandoned } = await completionBranches(t);
		let entered!: () => void;
		let release!: () => void;
		const started = new Promise<void>((done) => {
			entered = done;
		});
		const gate = new Promise<void>((done) => {
			release = done;
		});
		t.after(() => release());
		const getSuggestions = current.getSuggestions.bind(current);
		const gatedSuggestions: AutocompleteProvider["getSuggestions"] = async (lines, line, col, options) => {
			const result = await getSuggestions(lines, line, col, options);
			if (lines[line]?.includes(abandoned)) {
				entered();
				await gate;
			}
			return result;
		};
		t.mock.method(current, "getSuggestions", gatedSuggestions);
		const options = { signal: new AbortController().signal };
		const request = wrapped.getSuggestions(["@no"], 0, 3, options);
		await started;
		const sessionChanged = navigation === "replaced session" || navigation === "pending session event";
		if (navigation === "replaced session") await h.emit("session_shutdown");
		if (sessionChanged) {
			h.state.sessionId = "replacement-session";
			h.state.entries.clear();
			// The replacement legitimately uses the same directory. Its new wrapper may
			// offer it, but a result belonging to the retired wrapper must still be dropped.
			h.navigate([{
				id: "replacement-leaf",
				parentId: null,
				type: "custom",
				customType: "add-dir:state",
				data: { dirs: [{ absolutePath: abandoned, label: "abandoned" }] },
			}]);
		} else {
			h.navigate(earlierBranch);
		}
		if (navigation === "delivered tree event") await h.emit("session_tree");
		if (navigation === "replaced session") await h.emit("session_start");
		release();
		const suggestions = await request;
		assert.deepEqual(
			suggestions?.items.map((item) => item.value),
			["@note.md"],
			"the host-local result survives, but B's in-flight external result does not",
		);
		if (navigation === "pending session event") await h.emit("session_start");
		const active = sessionChanged
			? h.autocompleteFactories.at(-1)?.(current as never) as AutocompleteProvider
			: wrapped;
		const next = await active.getSuggestions(["@no"], 0, 3, options);
		const nextDirectory = sessionChanged ? abandoned : selected;
		assert.deepEqual(next?.items.map((item) => item.value), ["@note.md", `@${nextDirectory}/note.md`]);
		assert.equal(h.appendedEntries.length, 3, "stale completions never write session state");
	});
}

test("registers a completion wrapper that keeps the host provider and drops removed directories", async (t) => {
	const agentDir = await temporary(t);
	const directory = await temporary(t);
	const h = addDirHarness(t, { agentDir });
	await h.emit("session_start");
	assert.equal(h.autocompleteFactories.length, 1, "exactly one wrapper is registered per session");
	const foreign = {
		async getSuggestions(lines: string[], _line: number, col: number) {
			const text = lines[0]?.slice(0, col) ?? "";
			return { prefix: text, items: [{ value: `${text}-host`, label: "host candidate" }] };
		},
		applyCompletion(lines: string[]) {
			return { lines: [...lines, "host-applied"], cursorLine: 0, cursorCol: 0 };
		},
	};
	const wrapped = h.autocompleteFactories[0]?.(foreign as never) as AutocompleteProvider;
	await h.command("dir-add", directory);
	const options = { signal: new AbortController().signal } as never;
	const suggestions = await wrapped.getSuggestions(["@re"], 0, 3, options);
	assert.ok(suggestions?.items.some((item) => item.label === "host candidate"), "the host provider survives");
	assert.ok(
		suggestions?.items.some((item) => typeof item.value === "string" && item.value.startsWith(`@${directory}/`)),
		"the active directory is offered as an absolute candidate",
	);
	assert.ok(wrapped.applyCompletion(["x"], 0, 1, { value: "x", label: "x" }, "x").lines.includes("host-applied"), "completion is delegated");
	h.state.select = async (_title, choices) => choices[0];
	await h.command("dir-ls", "");
	const after = await wrapped.getSuggestions(["@re"], 0, 3, options);
	assert.ok(
		!after?.items.some((item) => typeof item.value === "string" && item.value.includes(directory)),
		"a removed directory stops contributing candidates",
	);
});
