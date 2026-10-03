import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import {
	CombinedAutocompleteProvider,
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import { createExternalAutocompleteProvider } from "../src/autocomplete.ts";
import { SkillReconciler, loadedSkillPaths } from "../src/resources.ts";

const skill = (path: string): SlashCommandInfo => ({
	name: `skill:${path}`,
	source: "skill",
	sourceInfo: { path, source: "skill", scope: "user", origin: "top-level" },
});

test("tracks the /reload boundary from provided and loaded skill sets", () => {
	const reconciler = new SkillReconciler();
	const added = "/external/added/SKILL.md";
	const unrelated = "/external/unrelated/SKILL.md";
	assert.equal(reconciler.evaluate([added], []), true, "a new candidate requires /reload");
	assert.equal(reconciler.evaluate([added, unrelated], []), true, "unrelated additions keep the boundary");
	assert.equal(reconciler.evaluate([], []), false, "withdrawing a never-loaded candidate clears it");
	assert.equal(reconciler.evaluate([added, unrelated], []), true);

	reconciler.reset();
	reconciler.recordProvided([added]);
	assert.equal(reconciler.evaluate([added], [added]), false, "a new binding starts from its own discovery baseline");
	assert.equal(reconciler.evaluate([], [added]), true, "removing a loaded skill needs /reload");
	assert.equal(reconciler.evaluate([added], [added]), false, "re-adding the loaded skill needs no extra reload");
});

test("suppresses candidates the host rejected instead of asking for reload forever", () => {
	const reconciler = new SkillReconciler();
	const collision = "/external/collision/SKILL.md";
	reconciler.reset();
	reconciler.recordProvided([collision]);
	assert.equal(reconciler.evaluate([collision], []), false, "host-rejected candidates are not pending");
	assert.equal(reconciler.evaluate([], []), false, "removing a rejected candidate stays quiet");
});

test("samples loaded skills from the host command inventory", () => {
	const commands = [skill("/a/SKILL.md"), skill("/a/SKILL.md"), { name: "loop", source: "extension" }, { name: "x", source: "prompt" }];
	assert.deepEqual(loadedSkillPaths(commands as SlashCommandInfo[]), ["/a/SKILL.md"]);
});

// Host-accurate stand-in: Pi extracts the token after the last prose/path separator and
// reports it as the suggestion prefix.
const TEST_SEPARATORS = /[\s"'=，．：；！？（）［］｛｝“”‘’…—]/u;
function hostToken(text: string): string {
	let last = -1;
	for (let index = 0; index < text.length; index += 1) if (TEST_SEPARATORS.test(text[index] ?? "")) last = index;
	return text.slice(last + 1);
}

function provider(): AutocompleteProvider & { calls: number } {
	const current = {
		calls: 0,
		async getSuggestions(lines: string[], _line: number, col: number): Promise<AutocompleteSuggestions | null> {
			current.calls += 1;
			const token = hostToken((lines[0] ?? "").slice(0, col));
			if (token.startsWith("@")) return { prefix: token, items: [{ value: `${token}x`, label: `${token}x` }] };
			if (token.startsWith("./")) return { prefix: token, items: [{ value: "./main.md", label: "main.md" }] };
			return null;
		},
		applyCompletion(lines: string[], _line: number, _col: number, item: AutocompleteItem, prefix: string) {
			return { lines: [...lines, `applied:${prefix}:${item.value}`], cursorLine: 0, cursorCol: 0 };
		},
		shouldTriggerFileCompletion: () => false,
	};
	return current as AutocompleteProvider & { calls: number };
}

async function autocompleteFixture(t: TestContext, externalName = "ext") {
	const root = await mkdtemp(join(tmpdir(), "pi-add-dir-completion-"));
	t.after(async () => {
		await rm(root, { recursive: true, force: true });
	});
	const work = join(root, "work");
	const external = join(root, externalName);
	await mkdir(work);
	await mkdir(external);
	await writeFile(join(work, "note.md"), "");
	await writeFile(join(external, "note.md"), "");
	const current = new CombinedAutocompleteProvider([], work, fileURLToPath(new URL("./fixtures/fd.mjs", import.meta.url)));
	return { root, work, external, current };
}

test("merges external directory candidates into existing @ completion", async () => {
	const current = provider();
	const wrapped = createExternalAutocompleteProvider(current, () => [{ absolutePath: "/external", label: "external" }]);
	const suggestions = await wrapped.getSuggestions(["@re"], 0, 3, { signal: new AbortController().signal } as never);
	assert.equal(suggestions?.prefix, "@re");
	assert.deepEqual(suggestions?.items.map((item) => item.value), ["@rex", "@/external/rex"]);
	assert.match(suggestions?.items[1]?.description ?? "", /^external: /);
});

test("merges external candidates after a host prose delimiter", async () => {
	const current = provider();
	const wrapped = createExternalAutocompleteProvider(current, () => [{ absolutePath: "/external", label: "external" }]);
	const options = { signal: new AbortController().signal } as never;
	for (const line of ["@re", "file=@re", "查看：@re"]) {
		const suggestions = await wrapped.getSuggestions([line], 0, line.length, options);
		assert.deepEqual(suggestions?.items.map((item) => item.value), ["@rex", "@/external/rex"], line);
	}
});

test("never replaces text before the token the host is completing", async () => {
	const current = provider();
	const wrapped = createExternalAutocompleteProvider(current, () => [{ absolutePath: "/external", label: "external" }]);
	const options = { signal: new AbortController().signal } as never;
	const at = await wrapped.getSuggestions(["@old=@ne"], 0, 8, options);
	assert.equal(at?.prefix, "@ne", "separators inside the typed text end the host's token");
	assert.deepEqual(at?.items.map((item) => item.value), ["@nex", "@/external/nex"]);
	assert.equal(wrapped.shouldTriggerFileCompletion?.([], 0, 0), false, "the host's trigger decision survives");
	assert.deepEqual(
		wrapped.applyCompletion(["x"], 0, 1, { value: "v", label: "v" }, "@v").lines.at(-1),
		"applied:@v:v",
		"application is delegated with the host prefix",
	);
	const path = await wrapped.getSuggestions(["@note=./ma"], 0, 10, options);
	assert.equal(path?.prefix, "./ma", "a non-@ query is passed through untouched");
	assert.deepEqual(path?.items.map((item) => item.value), ["./main.md"]);
});

test("ignores external probes the host parses as a different token", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-add-dir-probe-"));
	t.after(async () => {
		await rm(root, { recursive: true, force: true });
	});
	const work = join(root, "work");
	const quoted = join(root, 'ext"tail');
	const ordinary = join(root, "ordinary");
	for (const directory of [join(work, "tail"), quoted, ordinary]) await mkdir(directory, { recursive: true });
	await writeFile(join(work, "notice.md"), "");
	await writeFile(join(work, "tail", "note.md"), "");
	await writeFile(join(quoted, "note.md"), "");
	await writeFile(join(ordinary, "note.md"), "");
	const current = new CombinedAutocompleteProvider([], work, fileURLToPath(new URL("./fixtures/fd.mjs", import.meta.url)));
	const wrapped = createExternalAutocompleteProvider(current, () => [
		{ absolutePath: quoted, label: "quoted" },
		{ absolutePath: ordinary, label: "ordinary" },
	]);
	const lines = ["@no"];
	const suggestions = await wrapped.getSuggestions(lines, 0, 3, { signal: new AbortController().signal });
	assert.equal(suggestions?.prefix, "@no");
	assert.deepEqual(
		suggestions?.items.map((item) => item.value),
		["@notice.md", `@${ordinary}/note.md`, "@tail/note.md"],
		"the host's tail/note.md relative completion is not relabelled as an external attachment",
	);
	assert.ok(suggestions);
	assert.ok(suggestions.items[0]);
	assert.ok(suggestions.items[1]);
	assert.deepEqual(
		wrapped.applyCompletion(lines, 0, 3, suggestions.items[0], suggestions.prefix).lines,
		["@notice.md "],
		"local completion keeps the attachment marker",
	);
	assert.deepEqual(
		wrapped.applyCompletion(lines, 0, 3, suggestions.items[1], suggestions.prefix).lines,
		[`@${ordinary}/note.md `],
		"correctly parsed external probes still insert the absolute attachment",
	);
});

test("does not probe a POSIX backslash directory through its normalized sibling", {
	skip: sep !== "/" ? "Backslash is a path separator, not a POSIX filename character, on this platform" : false,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-add-dir-backslash-"));
	t.after(async () => {
		await rm(root, { recursive: true, force: true });
	});
	const work = join(root, "work");
	const backslash = join(root, "ext\\tail");
	const sibling = join(root, "ext", "tail");
	const ordinary = join(root, "ordinary");
	for (const directory of [work, backslash, sibling, ordinary]) await mkdir(directory, { recursive: true });
	for (const directory of [work, backslash, sibling, ordinary]) await writeFile(join(directory, "note.md"), "");
	const current = new CombinedAutocompleteProvider([], work, fileURLToPath(new URL("./fixtures/fd.mjs", import.meta.url)));
	const wrapped = createExternalAutocompleteProvider(current, () => [
		{ absolutePath: backslash, label: "backslash" },
		{ absolutePath: ordinary, label: "ordinary" },
	]);
	const suggestions = await wrapped.getSuggestions(["@no"], 0, 3, { signal: new AbortController().signal });
	assert.deepEqual(
		suggestions?.items.map((item) => item.value),
		["@note.md", `@${ordinary}/note.md`],
		"the normalized sibling is not attributed to the distinct backslash-named directory",
	);
	assert.ok(!suggestions?.items.some((item) => item.description?.startsWith("backslash: ")));
});

for (const query of [".", "child/."] as const) {
	test(`preserves the external search scope of the raw ${query} query`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "pi-add-dir-dots-"));
		t.after(async () => {
			await rm(root, { recursive: true, force: true });
		});
		const work = join(root, "work");
		const external = join(root, "ext");
		for (const directory of [work, join(work, "child"), external, join(root, "ext-other"), join(external, "child"), join(external, "child-other")]) {
			await mkdir(directory, { recursive: true });
			await writeFile(join(directory, "note.md"), "");
		}
		const current = new CombinedAutocompleteProvider([], work, fileURLToPath(new URL("./fixtures/fd.mjs", import.meta.url)));
		const wrapped = createExternalAutocompleteProvider(current, () => [{ absolutePath: external, label: "ext" }]);
		const line = `@${query}`;
		const suggestions = await wrapped.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
		assert.equal(suggestions?.prefix, line);
		assert.deepEqual(
			suggestions?.items.map((item) => item.value),
			query === "."
				? ["@note.md", `@${external}/note.md`, "@child/note.md", `@${external}/child/note.md`, `@${external}/child-other/note.md`]
				: ["@child/note.md", `@${external}/child/note.md`],
			"raw terminal dot segments never become a parent-directory search",
		);
	});
}

for (const scope of ["current", "parent", "home", "absolute"] as const) {
	test(`delegates Pi's backslash-spelled ${scope} scope without adding external candidates`, {
		skip: sep !== "/" ? "The actual-provider fd fixture and POSIX backslash-scoping seam require POSIX." : false,
	}, async (t) => {
		const { root, external, current } = await autocompleteFixture(t);
		const home = join(root, "home");
		const absolute = join(root, "absolute");
		await mkdir(home);
		await mkdir(absolute);
		await writeFile(join(root, "note.md"), "");
		await writeFile(join(home, "note.md"), "");
		await writeFile(join(absolute, "note.md"), "");
		// These are real files the incorrect external probe could find, even after
		// rejecting candidates outside the external root.
		const homeMirror = join(external, "~");
		const absoluteMirror = join(external, absolute.slice(1));
		for (const directory of [homeMirror, absoluteMirror]) {
			await mkdir(directory, { recursive: true });
			await writeFile(join(directory, "note.md"), "");
		}
		const previousHome = process.env.HOME;
		try {
			process.env.HOME = home;
			const query = scope === "current" ? ".\\no"
				: scope === "parent" ? "..\\no"
					: scope === "home" ? "~\\no"
						: `${absolute.replaceAll("/", "\\")}\\no`;
			const wanted = scope === "current" ? "@./note.md"
				: scope === "parent" ? "@../note.md"
					: scope === "home" ? "@~/note.md"
						: `@${absolute}/note.md`;
			const line = `@${query}`;
			const options = { signal: new AbortController().signal };
			const local = await current.getSuggestions([line], 0, line.length, options);
			assert.ok(local?.items.some((item) => item.value === wanted), "the host recognizes the explicitly scoped fixture");
			const wrapped = createExternalAutocompleteProvider(current, () => [{ absolutePath: external, label: "ext" }]);
			assert.deepEqual(
				await wrapped.getSuggestions([line], 0, line.length, options),
				local,
				"every host-local item, description and prefix remains unchanged, with no extra external result",
			);
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
		}
	});
}

for (const missing of ["query component", "root"] as const) {
	for (const quoted of [false, true]) {
		test(`does not relabel cwd fallback for a missing ${missing} (${quoted ? "quoted" : "unquoted"})`, {
			skip: sep !== "/" ? "The actual-provider fd subprocess fixture requires POSIX." : false,
		}, async (t) => {
			const { work, external, current } = await autocompleteFixture(t);
			const component = missing === "query component" ? "missing/" : "";
			if (missing === "root") await rm(external, { recursive: true });
			const relativePath = `archive/${external.slice(1)}/${component}note.md`;
			const mirror = join(work, relativePath);
			await mkdir(dirname(mirror), { recursive: true });
			await writeFile(mirror, "");
			const line = `${quoted ? '@"' : "@"}${component}no`;
			const wanted = `${quoted ? '@"' : "@"}${relativePath}${quoted ? '"' : ""}`;
			const options = { signal: new AbortController().signal };
			const previousCwd = process.cwd();
			try {
				// A session/provider cwd can differ from the process cwd. Containment
				// alone must not resolve the relative fallback as an external path.
				if (missing === "query component") process.chdir(external);
				const local = await current.getSuggestions([line], 0, line.length, options);
				assert.ok(local?.items.some((item) => item.value === wanted), "the cwd contains a matching absolute-path-shaped subtree");
				const wrapped = createExternalAutocompleteProvider(current, () => [{ absolutePath: external, label: "ext" }]);
				const suggestions = await wrapped.getSuggestions([line], 0, line.length, options);
				assert.deepEqual(suggestions, local, "the missing external scope cannot contribute or relabel relative cwd attachments");
				assert.ok(!suggestions?.items.some((item) => item.description?.startsWith("ext: ")));
			} finally {
				process.chdir(previousCwd);
			}
		});
	}
}

test("does not attribute parent-scope candidates outside the active external base", {
	skip: sep !== "/" ? "The actual-provider fd subprocess fixture requires POSIX." : false,
}, async (t) => {
	const { root, external, current } = await autocompleteFixture(t);
	await writeFile(join(root, "note.md"), "");
	await mkdir(join(external, "child"));
	const line = "@child/../../no";
	const wrapped = createExternalAutocompleteProvider(current, () => [{ absolutePath: external, label: "ext" }]);
	const suggestions = await wrapped.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
	assert.deepEqual(suggestions?.items.map((item) => item.value), [
		"@child/../../note.md",
		`@${external}/child/../../ext/note.md`,
		"@child/../../ext/note.md",
		"@child/../../work/note.md",
	], "host-local traversal remains intact, but only root-owned absolute candidates receive external attribution");
});

for (const line of ["@", "@no"] as const) {
	test(`keeps quoted absolute attachments from a spaced external base for ${line}`, {
		skip: sep !== "/" ? "The actual-provider fd subprocess fixture requires POSIX." : false,
	}, async (t) => {
		const { external, current } = await autocompleteFixture(t, "external ref");
		await mkdir(join(external, "child"));
		const wrapped = createExternalAutocompleteProvider(current, () => [{ absolutePath: external, label: "spaced" }]);
		const suggestions = await wrapped.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
		assert.deepEqual(suggestions?.items.map((item) => item.value), line === "@"
			? ["@note.md", `@"${external}/child/"`, `@"${external}/note.md"`]
			: ["@note.md", `@"${external}/note.md"`]);
		const externalItem = suggestions?.items.find((item) => item.description?.startsWith("spaced: "));
		assert.ok(externalItem);
		const applied = wrapped.applyCompletion([line], 0, line.length, externalItem, line);
		assert.deepEqual(applied.lines, [`${externalItem.value}${line === "@" ? "" : " "}`]);
		assert.equal(applied.cursorCol, externalItem.value.length + (line === "@" ? -1 : 1));
	});
}

test("drops external candidates whose text could move the terminal cursor", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-add-dir-unsafe-"));
	t.after(async () => {
		await rm(root, { recursive: true, force: true });
	});
	await writeFile(join(root, "safe.txt"), "");
	await writeFile(join(root, "escape\u001b[31m.txt"), "");
	await writeFile(join(root, "reorder\u202etxt"), "");
	const listing: AutocompleteProvider = {
		async getSuggestions(lines, _line, col): Promise<AutocompleteSuggestions | null> {
			const text = (lines[0] ?? "").slice(0, col);
			const query = text.startsWith('@"') ? text.slice(2) : text.slice(1);
			const slash = query.lastIndexOf("/");
			if (slash < 0) return null;
			const directory = query.slice(0, slash);
			return {
				prefix: text,
				items: readdirSync(directory).map((name) => ({ value: `@${join(directory, name)}`, label: name })),
			};
		},
		applyCompletion(lines) {
			return { lines, cursorLine: 0, cursorCol: 0 };
		},
	};
	const wrapped = createExternalAutocompleteProvider(listing, () => [{ absolutePath: root, label: "external" }]);
	const suggestions = await wrapped.getSuggestions(["@"], 0, 1, { signal: new AbortController().signal } as never);
	assert.ok(!JSON.stringify(suggestions).includes("\u001b"), "no control character reaches a candidate");
	assert.deepEqual(
		suggestions?.items.map((item) => item.label),
		["safe.txt"],
		"unsafe and reordering names are dropped, not rewritten",
	);

	// A candidate that is itself safe still gets an escaped description, and the local
	// provider's own result is passed through untouched.
	const polluted = createExternalAutocompleteProvider(
		{
			async getSuggestions(lines, line, col): Promise<AutocompleteSuggestions | null> {
				const prefix = (lines[line] ?? "").slice(0, col);
				return {
					prefix,
					items: [{ value: prefix.startsWith("@/external/") ? "@/external/x" : "/external/x", label: "x", description: "x\u001b[31m" }],
				};
			},
			applyCompletion(lines) {
				return { lines, cursorLine: 0, cursorCol: 0 };
			},
		},
		() => [{ absolutePath: "/external", label: "external" }],
	);
	const escaped = await polluted.getSuggestions(["@x"], 0, 2, { signal: new AbortController().signal } as never);
	assert.equal(escaped?.items[0]?.description, "x\u001b[31m", "the host's own candidate is not rewritten");
	assert.match(escaped?.items[1]?.description ?? "", /^external: x\\u001b/);
});

test("treats every host separator as a boundary and quotes the paths it implies", async (t) => {
	const options = { signal: new AbortController().signal } as never;
	const probed: string[] = [];
	const recording: AutocompleteProvider = {
		async getSuggestions(lines, _line, col): Promise<AutocompleteSuggestions | null> {
			probed.push((lines[0] ?? "").slice(0, col));
			return null;
		},
		applyCompletion(lines) {
			return { lines, cursorLine: 0, cursorCol: 0 };
		},
	};
	const spaced = createExternalAutocompleteProvider(recording, () => [{ absolutePath: "/ext/my dir", label: "spaced" }]);
	await spaced.getSuggestions(["@x"], 0, 2, options);
	assert.equal(probed[1], '@"/ext/my dir/x', "a path the host would split is quoted");

	// Without a host suggestion the wrapper scans for its own token; every separator the
	// host recognises must end the token, including the non-ASCII spaces `\\s` matches.
	const echoing: AutocompleteProvider = {
		async getSuggestions(lines, _line, col): Promise<AutocompleteSuggestions | null> {
			const text = (lines[0] ?? "").slice(0, col);
			// Only a probe that reaches a directory scope answers, with a candidate that is
			// itself safe so the assertion is about the token, not about candidate filtering.
			return text.includes("/")
				? { prefix: text.slice(text.lastIndexOf("@")), items: [{ value: "@/external/safe", label: "safe" }] }
				: null;
		},
		applyCompletion(lines) {
			return { lines, cursorLine: 0, cursorCol: 0 };
		},
	};
	const wrapped = createExternalAutocompleteProvider(echoing, () => [{ absolutePath: "/external", label: "external" }]);
	for (const separator of [" ", "\t", "\u00a0", "\u3000", '=', "'", "，", "："]) {
		const line = `note${separator}@`;
		const suggestions = await wrapped.getSuggestions([line], 0, line.length, options);
		assert.equal(suggestions?.prefix, "@", `token after ${JSON.stringify(separator)}`);
	}
	assert.equal((await wrapped.getSuggestions(['@"re'], 0, 4, options))?.prefix, '@"re', "a quoted token keeps its own text");
	assert.equal(
		await wrapped.getSuggestions(['abc@"re'], 0, 7, options),
		null,
		"an @ inside a word is not a token the host would complete",
	);
	// Astral CJK punctuation is one separator to the host; a single code unit is not enough.
	const astral = `x\u{16fe2}@"re`;
	assert.equal((await wrapped.getSuggestions([astral], 0, astral.length, options))?.prefix, '@"re');
	const wrappedAstral = `(\u{16fe2}@re`;
	assert.equal((await wrapped.getSuggestions([wrappedAstral], 0, wrappedAstral.length, options))?.prefix, "@re");
});

test("points an empty @ query at the external directory itself", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-add-dir-at-"));
	t.after(async () => {
		await rm(root, { recursive: true, force: true });
	});
	await mkdir(join(root, "child"));
	await writeFile(join(root, "file.txt"), "");
	const listed: string[] = [];
	const listing: AutocompleteProvider = {
		async getSuggestions(lines, _line, col): Promise<AutocompleteSuggestions | null> {
			const text = (lines[0] ?? "").slice(0, col);
			const query = text.startsWith('@"') ? text.slice(2) : text.slice(1);
			const slash = query.lastIndexOf("/");
			if (slash < 0) return null; // The unmodified local probe has no directory scope.
			const directory = query.slice(0, slash);
			listed.push(directory);
			const names = readdirSync(directory);
			return names.length > 0 ? { prefix: text, items: names.map((name) => ({ value: `@${join(directory, name)}`, label: name })) } : null;
		},
		applyCompletion(lines) {
			return { lines, cursorLine: 0, cursorCol: 0 };
		},
	};
	const wrapped = createExternalAutocompleteProvider(listing, () => [{ absolutePath: root, label: "external" }]);
	const suggestions = await wrapped.getSuggestions(["@"], 0, 1, { signal: new AbortController().signal } as never);
	assert.deepEqual(listed, [root], "the provider lists the external directory, not its parent");
	assert.deepEqual(suggestions?.items.map((item) => item.label).sort(), ["child", "file.txt"]);
});

test("delegates without an @ token and for absolute or explicit relative queries", async () => {
	const current = provider();
	const wrapped = createExternalAutocompleteProvider(current, () => [{ absolutePath: "/external", label: "external" }]);
	const options = { signal: new AbortController().signal } as never;
	for (const [line, col] of [["@/abs", 5], ["@~/home", 7], ["@./rel", 6], ["@../rel", 7]] as const) {
		const before = current.calls;
		const suggestions = await wrapped.getSuggestions([line], 0, col, options);
		assert.equal(current.calls, before + 1, `${line} delegates once`);
		assert.deepEqual(suggestions?.items.map((item) => item.value), [`${line}x`]);
	}
	assert.equal(await wrapped.getSuggestions(["plain"], 0, 5, options), null, "a non-@ query stays the host's own result");
});
