import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import enhance from "../src/markdown/index.ts";

// Render and capability overrides must share coding-agent's physical TUI closure.
// Bundled CLI identity is covered separately by the runtime integration suite.
const hostRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { Markdown, setCapabilityOverrides, stripTerminalSequences, getOsc8LinkAtColumn, visibleWidth } =
	await import(pathToFileURL(hostRequire.resolve("@earendil-works/pi-tui")).href) as typeof import("@earendil-works/pi-tui");

let transform!: (md: string, ctx?: object) => string;
enhance({ registerMarkdownTransformer: (fn: typeof transform) => { transform = fn; } } as never);
const context = { messageType: "assistant", isStreaming: false, availableWidth: 1_000 };
const identity = (text: string) => text;
const theme: MarkdownTheme = {
	heading: identity, link: identity, linkUrl: identity, code: identity,
	codeBlock: identity, codeBlockBorder: identity, quote: identity, quoteBorder: identity,
	hr: identity, listBullet: identity, bold: identity, italic: identity,
	strikethrough: identity, underline: identity,
};

function render(source: string, options: { native?: boolean; streaming?: boolean; width?: number; user?: boolean } = {}) {
	setCapabilityOverrides({ hyperlinks: true, images: null });
	try {
		const component = new Markdown(source, 0, 0, theme, undefined, {
			preserveBackslashEscapes: options.user,
			transform: options.native ? undefined : (md, width) => transform(md, {
				...context, availableWidth: width, isStreaming: options.streaming ?? false,
				messageType: options.user ? "user" : "assistant",
			}),
		});
		const lines = component.render(options.width ?? 1_000);
		const output = lines.join("\n");
		const targets = Array.from(output.matchAll(/\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g), (match) => match[1]).filter(Boolean);
		return { lines, targets, visible: lines.map((line) => stripTerminalSequences(line).trimEnd()).join("\n") };
	} finally { setCapabilityOverrides({}); }
}

function assertPlainSuffix(lines: string[], suffix: string) {
	for (const line of lines) {
		const visible = stripTerminalSequences(line);
		let offset = visible.indexOf(suffix);
		while (offset !== -1) {
			assert.equal(getOsc8LinkAtColumn(line, visibleWidth(visible.slice(0, offset))), undefined,
				`punctuation must stay visible outside the OSC 8 click area: ${JSON.stringify(line)}`);
			offset = visible.indexOf(suffix, offset + suffix.length);
		}
	}
}

test("real Pi 1.0.2 Markdown keeps CJK punctuation outside corrected OSC 8 targets", () => {
	const source = "看 https://example.com/a，和 https://b.com/x. 结束";
	assert.deepEqual(render(source, { native: true }).targets, ["https://example.com/a，和", "https://b.com/x"]);
	const out = render(source);
	assert.deepEqual(out.targets, ["https://example.com/a", "https://b.com/x"]);
	assert.equal(out.visible, source);
	assertPlainSuffix(out.lines, "，和");
	assertPlainSuffix(out.lines, ". 结束");
});

for (const boundary of ["，", "。", "；", "：", "！", "？", "、", "（", "）", "【", "】", "《", "》", "〈", "〉", "「", "」", "『", "』", "〔", "〕", "［", "］", "｛", "｝"]) {
	test(`real host OSC 8 ends before Chinese/fullwidth boundary ${boundary}`, () => {
		const source = `看 https://example.com/a${boundary}后文`;
		const out = render(source);
		assert.deepEqual(out.targets, ["https://example.com/a"]);
		assert.equal(out.visible, source);
		assertPlainSuffix(out.lines, `${boundary}后文`);
	});
}

test("fullwidth brackets enclose links without becoming OSC 8 targets", () => {
	const source = "全角（https://example.com/a） 【https://b.com/x】 《https://c.com/y》";
	const out = render(source);
	assert.deepEqual(out.targets, ["https://example.com/a", "https://b.com/x", "https://c.com/y"]);
	assert.equal(out.visible, source);
	for (const ch of "（）【】《》") assertPlainSuffix(out.lines, ch);
});

test("ordinary links stay host-native, including normal ASCII punctuation and balanced parentheses", () => {
	const source = "https://example.com/a, https://example.com/b. https://example.com/c! https://en.wikipedia.org/wiki/A_(B) www.example.com/x <https://auto.example/a，b> [label](https://link.example/(B))";
	assert.equal(transform(source, context), source);
	const out = render(source);
	assert.deepEqual(out.targets, ["https://example.com/a", "https://example.com/b", "https://example.com/c", "https://en.wikipedia.org/wiki/A_(B)", "http://www.example.com/x", "https://auto.example/a，b", "https://link.example/(B)"]);
	assert.deepEqual(out, render(source, { native: true }));
});

test("ASCII suffixes exposed by a CJK boundary stay visible but outside OSC 8", () => {
	const source = "https://example.com/a_(B).，https://example.com/x)；https://example.com/A_((B))！";
	const out = render(source);
	assert.deepEqual(out.targets, ["https://example.com/a_(B)", "https://example.com/x", "https://example.com/A_((B))"]);
	assert.equal(out.visible, source);
	assertPlainSuffix(out.lines, ".，");
	assertPlainSuffix(out.lines, ")；");
});

test("CJK URL paths and circled-digit destinations survive the font workaround", () => {
	const source = "① https://example.com/路径/②_(B)，③ www.example.com/④。 ftp://example.com/⑤）";
	const out = render(source);
	assert.deepEqual(out.targets, ["https://example.com/路径/②_(B)", "http://www.example.com/④", "ftp://example.com/⑤"]);
	assert.equal(out.visible, "(1) https://example.com/路径/②_(B)，(3) www.example.com/④。 ftp://example.com/⑤）");
});

test("www labels with a circled-digit URL and balanced ASCII parentheses remain literal", () => {
	const source = "看 www.example.com/A_(①)，结束";
	const out = render(source);
	assert.deepEqual(out.targets, ["http://www.example.com/A_(①)"]);
	assert.equal(out.visible, source);
	assert.deepEqual(render(source, { user: true }), out);
});

test("existing inline links, images and autolinks keep their own punctuation-bearing destinations", () => {
	const source = "[https://label.example/a，](https://target.example/b）) ![https://image.example/a，](https://image.example/b）) <https://auto.example/a，b>";
	assert.equal(transform(source, context), source);
	const out = render(source);
	// Native images are text, not OSC 8 links; their native rendering must not change.
	assert.deepEqual(out.targets, ["https://target.example/b）", "https://auto.example/a，b"]);
	assert.deepEqual(out, render(source, { native: true }));
});

test("inline, multiline inline, fenced and indented code emit no URL hyperlinks", () => {
	const source = [
		"`https://inline.example/a，` ``https://inline.example/b）``",
		"", "``https://multiline.example/a，", "https://multiline.example/b）``", "",
		"```md", "https://fenced.example/a，", "```", "",
		"~~~md", "https://tilde.example/a）", "~~~", "",
		// Pi converts a tab to three spaces before parsing; tab + space is a native code indent.
		"    https://indented.example/a，", "\t https://indented.example/b）", "",
		"https://outside.example/a，正文",
	].join("\n");
	const out = render(source);
	assert.deepEqual(out.targets, ["https://outside.example/a"]);
	for (const url of ["https://inline.example/a，", "https://multiline.example/b）", "https://fenced.example/a，", "https://tilde.example/a）", "https://indented.example/a，", "https://indented.example/b）"]) {
		assert.ok(out.visible.includes(url), out.visible);
	}
	assert.equal(transform(source, context).replace("<https://outside.example/a>", "https://outside.example/a"), source);
});

test("quoted and list-contained code fences remain native and unlinked", () => {
	const source = "> ```md\n> https://quote-code.example/a，\n> ```\n\n- ```md\n  https://list-code.example/a）\n  ```\n\nhttps://outside.example/a，正文";
	const out = render(source);
	assert.deepEqual(out.targets, ["https://outside.example/a"]);
	assert.ok(out.visible.includes("https://quote-code.example/a，"), out.visible);
	assert.ok(out.visible.includes("https://list-code.example/a）"), out.visible);
	assert.equal(transform(source, context).replace("<https://outside.example/a>", "https://outside.example/a"), source);
});

test("tab-only source stays byte-for-byte despite the host's three-space normalization", () => {
	const source = "\thttps://native-tab.example/a，正文";
	assert.equal(transform(source, context), source);
	assert.deepEqual(render(source), render(source, { native: true }));
	assert.deepEqual(render(source).targets, ["https://native-tab.example/a，正文"]);
});

const codeBlocks = [
	["tilde fence", (code: string) => `~~~text\n${code}\n~~~`],
	["backtick fence", (code: string) => `\`\`\`text\n${code}\n\`\`\``],
	["space-indented code", (code: string) => `    ${code}`],
	["tab-and-space-indented code", (code: string) => `\t ${code}`],
] as const;

for (const [name, wrap] of codeBlocks) {
	for (const position of ["before", "after"] as const) {
		test(`real host reference destinations resolve with definitions ${position} ${name}`, () => {
			const definition = '[①]: https://target.example/②，路径） "③"\n[https://ref.example/a，]: https://target.example/ref）';
			const code = wrap("https://code.example/a， [①] [https://ref.example/a，]");
			const links = "[①] [①][] [④][①] [https://ref.example/a，] [https://ref.example/a，][] [https://label.example/a）][https://ref.example/a，] https://outside.example/⑤，⑥";
			const source = position === "before" ? `${definition}\n\n${code}\n\n${links}` : `${links}\n\n${code}\n\n${definition}`;
			const out = render(source);
			assert.deepEqual(out.targets, [
				"https://target.example/②，路径）", "https://target.example/②，路径）", "https://target.example/②，路径）",
				"https://target.example/ref）", "https://target.example/ref）", "https://target.example/ref）", "https://outside.example/⑤",
			]);
			assert.ok(out.visible.includes("① ① (4) https://ref.example/a， https://ref.example/a， https://label.example/a） https://outside.example/⑤，(6)"), out.visible);
			const once = transform(source, context);
			assert.equal(transform(once, context), once);
			assert.deepEqual(render(once), out);
		});
	}

	test(`real host ignores reference definitions inside ${name}`, () => {
		const source = `${wrap("[①]: https://code.example/a，")}\n\nSee [①]. https://outside.example/a，正文`;
		const out = render(source);
		assert.deepEqual(out.targets, ["https://outside.example/a"]);
		assert.ok(out.visible.includes("See [(1)]."), out.visible);
	});
}

test("real host render is idempotent in streaming, final and user display modes", () => {
	const source = "看 https://example.com/①_(B)，www.example.com/②。 [wrapped\nlabel](https://link.example/③）) `https://code.example/④，`";
	const expected = ["https://example.com/①_(B)", "http://www.example.com/②", "https://link.example/③）"];
	for (const options of [{}, { streaming: true }, { user: true }]) {
		const out = render(source, options);
		assert.deepEqual(out.targets, expected);
		const once = transform(source, { ...context, isStreaming: options.streaming ?? false });
		assert.equal(transform(once, { ...context, isStreaming: options.streaming ?? false }), once);
		assert.deepEqual(render(once, options), out);
		assert.ok(out.visible.includes("https://example.com/①_(B)，www.example.com/②。 wrapped label"), out.visible);
	}
	for (const width of [20, 40, 80]) {
		const out = render(source, { width });
		assert.deepEqual([...new Set(out.targets)], expected);
		assert.ok(out.lines.every((line) => visibleWidth(line) <= width));
	}
});

const referenceContainers = [
	["blockquote", "> ", "> "],
	["list", "- ", "  "],
	["ordered list", "12. ", "    "],
	["nested blockquote", "> > ", "> > "],
	["quoted list", "> - ", ">   "],
	["listed quote", "- > ", "  > "],
	["nested ordered list", "- 12. ", "      "],
	["quoted nested ordered list", "> - 12. ", ">       "],
] as const;

for (const [name, first, continuation] of referenceContainers) {
	const wrap = (text: string) => text.split("\n").map((line, i) => `${i ? continuation : first}${line}`).join("\n");
	for (const position of ["before", "after"] as const) {
		test(`real host container references: ${name}, definitions ${position} contained code`, () => {
			const definition = '[①]: https://target.example/②，路径） "③"\n[www.ref.example/a，]: https://target.example/ref，path';
			const code = "~~~text\n[⑨]: https://code.example/a，\nwww.code.example/$x$，\n~~~";
			const links = "[①] [①][] [④][①] [www.ref.example/a，] [www.ref.example/a，][] [label][www.ref.example/a，]";
			const body = position === "before" ? `${definition}\n\n${code}\n\n${links}` : `${links}\n\n${code}\n\n${definition}`;
			const source = `${wrap(body)}\n\nOutside [①] [①][] [label][①] [⑨]. 看 www.example.com/a_b_c，后文`;
			const expected = [
				...Array<string>(3).fill("https://target.example/②，路径）"),
				...Array<string>(3).fill("https://target.example/ref，path"),
				...Array<string>(3).fill("https://target.example/②，路径）"), "http://www.example.com/a_b_c",
			];
			assert.deepEqual(render(source, { native: true }).targets.slice(0, 9), expected.slice(0, 9), "fixture must resolve natively");
			for (const options of [{}, { streaming: true }, { user: true }]) {
				const out = render(source, options);
				assert.deepEqual(out.targets, expected);
				assert.ok(out.visible.includes(options.streaming ? "① ① ④" : "① ① (4)"), out.visible);
				assert.ok(out.visible.includes(options.streaming ? "Outside ① ① label [⑨]." : "Outside ① ① label [(9)]."), out.visible);
				assert.ok(out.visible.includes("www.code.example/$x$，"), out.visible);
				assertPlainSuffix(out.lines, "，后文");
				const ctx = { ...context, isStreaming: options.streaming ?? false, messageType: options.user ? "user" : "assistant" };
				const once = transform(source, ctx);
				assert.ok(once.includes(definition.split("\n")[0]), once);
				assert.equal(transform(once, ctx), once);
				assert.deepEqual(render(once, options), out);
			}
		});
	}

	for (const [codeName, code] of [
		["fence", "```md\n[①]: https://code.example/②，\nwww.code.example/$x$，\n```"],
		["indented code", "    [①]: https://code.example/②，\n    www.code.example/$x$，"],
		["indented code immediately after a definition", "[docs]: https://docs.example/a\n    [①]: https://code.example/②，\n    www.code.example/$x$，"],
		["indented code after a wrapped destination", "[docs]:\nhttps://docs.example/a\n    [①]: https://code.example/②，\n    www.code.example/$x$，"],
		["indented code after a wrapped title", '[docs]: https://docs.example/a\n"title"\n    [①]: https://code.example/②，\n    www.code.example/$x$，'],
		["indented code after a wrapped destination and title", '[docs]:\nhttps://docs.example/a\n"title"\n    [①]: https://code.example/②，\n    www.code.example/$x$，'],
		["indented code after a multiline title", '[docs]: https://docs.example/a\n"title\ncontinued"\n    [①]: https://code.example/②，\n    www.code.example/$x$，'],
		["indented code after a multiline title opening beside the destination", '[docs]: https://docs.example/a "title\ncontinued"\n    [①]: https://code.example/②，\n    www.code.example/$x$，'],
		["indented code after a wrapped destination with a multiline title", '[docs]:\nhttps://docs.example/a "title\ncontinued"\n    [①]: https://code.example/②，\n    www.code.example/$x$，'],
		["indented code after a multiline single-quoted title", "[docs]: https://docs.example/a 'title\ncontinued'\n    [①]: https://code.example/②，\n    www.code.example/$x$，"],
		["indented code after a multiline parenthesized title", "[docs]: https://docs.example/a (title\ncontinued)\n    [①]: https://code.example/②，\n    www.code.example/$x$，"],
		["indented code after escaped close-angle destination and multiline title", '[docs]: <https://docs.example/a\\>b> "title\ncontinued"\n    [①]: https://code.example/②，\n    www.code.example/$x$，'],
		["indented code after escaped open-angle destination and multiline title", '[docs]: <https://docs.example/a\\<b> "title\ncontinued"\n    [①]: https://code.example/②，\n    www.code.example/$x$，'],
		["indented code after fence-looking title lines", '[docs]: <https://docs.example/a\\>b> "title\n~~~\nliteral\n~~~\ncontinued"\n    [①]: https://code.example/②，\n    www.code.example/$x$，'],
		["indented code after an unpaired fence-looking title line", '[docs]: https://docs.example/a "title\n~~~\nliteral\ncontinued"\n[other]: https://docs.example/b "second\ncontinued"\n    [①]: https://code.example/②，\n    www.code.example/$x$，'],
		["indented code after an ATX heading", "# Heading\n    [①]: https://code.example/②，\n    www.code.example/$x$，"],
		["indented code after a setext heading", "Heading\n===\n    [①]: https://code.example/②，\n    www.code.example/$x$，"],
		["indented code after a thematic break", "***\n    [①]: https://code.example/②，\n    www.code.example/$x$，"],
		["indented code after a table", "| Header |\n| --- |\n| Body |\n    [①]: https://code.example/②，\n    www.code.example/$x$，"],
		["multiline inline code", "``sample\n[①]: https://code.example/②，\nwww.code.example/$x$，``"],
	]) {
		test(`real host excludes definitions in ${name} ${codeName} from global reference keys`, () => {
			const source = `${wrap(code)}\n\nSee [①]. 看 www.example.com/$x$，结束`;
			assert.deepEqual(render(source, { native: true }).targets, ["http://www.example.com/$x$，结束"], "code-only definition must not resolve natively");
			for (const options of [{}, { streaming: true }, { user: true }]) {
				const out = render(source, options);
				assert.deepEqual(out.targets, ["http://www.example.com/$x$"]);
				assert.ok(out.visible.includes(options.streaming ? "See [①]." : "See [(1)]."), out.visible);
				assert.ok(out.visible.includes("www.code.example/$x$，"), out.visible);
				assertPlainSuffix(out.lines, "，结束");
				const ctx = { ...context, isStreaming: options.streaming ?? false, messageType: options.user ? "user" : "assistant" };
				const once = transform(source, ctx);
				assert.ok(once.startsWith(wrap(code)), once);
				assert.equal(transform(once, ctx), once);
				assert.deepEqual(render(once, options), out);
			}
		});
	}
}

for (const path of ["a_b_c", "$x$", "$x$_a_b_~~z~~*t*/tail", "*x*/tail", "__x__/tail", "[x]", "[unclosed", "unclosed]", "~~x~~/tail", "\\(x\\)/tail", "\\[x\\]/tail"]) {
	test(`real host literal www label and exact CJK boundary in final, streaming and USER: ${path}`, () => {
		const url = `www.example.com/${path}`;
		const source = `看 ${url}，结束`;
		for (const options of [{}, { streaming: true }, { user: true }]) {
			const out = render(source, options);
			assert.equal(out.visible, source);
			assert.deepEqual(out.targets, [`http://${url}`]);
			assertPlainSuffix(out.lines, "，结束");
			const ctx = { ...context, isStreaming: options.streaming ?? false, messageType: options.user ? "user" : "assistant" };
			const once = transform(source, ctx);
			assert.equal(transform(once, ctx), once);
			assert.deepEqual(render(once, options), out);
		}
	});
}

test("literal www repair still leaves code, existing targets and ordinary URLs native in all host modes", () => {
	const protectedSource = '`www.example.com/$x$，` [label](<http://www.target.example/$x$，path>) <http://www.auto.example/a_b_c，path> www.native.example/a_b_c';
	assert.equal(transform(protectedSource, context), protectedSource);
	for (const options of [{}, { streaming: true }, { user: true }]) {
		assert.deepEqual(render(protectedSource, options), render(protectedSource, { ...options, native: true }));
		const source = `${protectedSource} 看 www.example.com/$x$，结束`;
		const out = render(source, options);
		assert.deepEqual(out.targets, ["http://www.target.example/$x$，path", "http://www.auto.example/a_b_c，path", "http://www.native.example/a_b_c", "http://www.example.com/$x$"]);
		assert.ok(out.visible.endsWith("看 www.example.com/$x$，结束"), out.visible);
		assertPlainSuffix(out.lines, "，结束");
	}
});

test("real host preserves quoted wrapped definitions, adjacent indented definitions and definitions on both sides of code", () => {
	const source = '> [①]:\n> https://target.example/②，path\n> "③ title"\n>   [④]: https://target.example/four，path\n>\n> ~~~md\n> [⑨]: https://code.example/a，\n> ~~~\n>   [⑤]: https://target.example/five，path\n>\n> [①] [④][] [label][⑤]\n\nSee [①] [④][] [label][⑤] [⑨].';
	const expected = ["https://target.example/②，path", "https://target.example/four，path", "https://target.example/five，path"];
	assert.deepEqual(render(source, { native: true }).targets, [...expected, ...expected]);
	for (const options of [{}, { streaming: true }, { user: true }]) {
		const out = render(source, options);
		assert.deepEqual(out.targets, [...expected, ...expected]);
		assert.ok(out.visible.includes(options.streaming ? "See ① ④ label [⑨]." : "See ① ④ label [(9)]."), out.visible);
		const ctx = { ...context, isStreaming: options.streaming ?? false, messageType: options.user ? "user" : "assistant" };
		const once = transform(source, ctx);
		assert.equal(once, options.streaming ? source : source.replace("[⑨].", "[(9)]."));
		assert.equal(transform(once, ctx), once);
		assert.deepEqual(render(once, options), out);
	}
});

test("real host keeps authoritative definitions separate from unmatched heading code delimiters", () => {
	const source = '# Heading `\n[①]: https://target.example/②，path "title`"\n    [③]: https://code.example/④，\n\nSee [①].';
	assert.deepEqual(render(source, { native: true }).targets, ["https://target.example/②，path"]);
	for (const options of [{}, { streaming: true }, { user: true }]) {
		const out = render(source, options);
		assert.deepEqual(out.targets, ["https://target.example/②，path"]);
		assert.ok(out.visible.includes("[③]: https://code.example/④，"));
		const ctx = { ...context, isStreaming: options.streaming ?? false, messageType: options.user ? "user" : "assistant" };
		assert.equal(transform(source, ctx), source);
	}
});

test("real host retains genuine fenced code after an incomplete definition and a new quote", () => {
	const source = '[docs]:\n> https://docs.example/a "title\n> ~~~text\n> ① https://code.example/a，\n> ~~~\n> continued"';
	const native = render(source, { native: true });
	assert.ok(native.visible.includes("① https://code.example/a，"));
	assert.ok(!native.targets.includes("https://code.example/a，"));
	for (const options of [{}, { streaming: true }, { user: true }]) {
		const out = render(source, options);
		assert.deepEqual(out, render(source, { ...options, native: true }));
		const ctx = { ...context, isStreaming: options.streaming ?? false, messageType: options.user ? "user" : "assistant" };
		assert.equal(transform(source, ctx), source);
	}
});

test("real host ignores HTML-hidden pseudo-references inside multiline inline code", () => {
	const source = "``sample\n<span>\n[https://ref.example/a，]: https://code.example/①，\n``\n\nSee [https://ref.example/a，].";
	assert.deepEqual(render(source, { native: true }).targets, ["https://ref.example/a，]"]);
	for (const options of [{}, { streaming: true }, { user: true }]) {
		const out = render(source, options);
		assert.deepEqual(out.targets, ["https://ref.example/a"]);
		assert.ok(out.visible.includes("[https://ref.example/a，]: https://code.example/①，"));
	}
});

for (const prefix of ["> ", "- ", "12. "]) {
	test(`real host repairs ordinary prose beyond validated definition extent: ${prefix}`, () => {
		const source = `[docs]: https://docs.example/a\n${prefix}"① https://prose.example/a，suffix"\n\nSee [docs].`;
		assert.deepEqual(render(source, { native: true }).targets, ["https://prose.example/a，suffix", "https://docs.example/a"]);
		for (const options of [{}, { streaming: true }, { user: true }]) {
			const out = render(source, options);
			assert.deepEqual(out.targets, ["https://prose.example/a", "https://docs.example/a"]);
			assert.ok(out.visible.includes(options.streaming ? "① https://prose.example/a，suffix" : "(1) https://prose.example/a，suffix"));
		}
	});
}

for (const prefix of ["- ", "12. "]) {
	test(`real host resolves native lazy list reference definitions: ${prefix}`, () => {
		const source = `${prefix}[①]:\nhttps://target.example/②，path\n\nSee [①].`;
		assert.deepEqual(render(source, { native: true }).targets, ["https://target.example/②，path"]);
		for (const options of [{}, { streaming: true }, { user: true }]) {
			assert.deepEqual(render(source, options).targets, ["https://target.example/②，path"]);
		}
	});
}

for (const html of ["<!--\n-->", "<?pi\n?>", "<![CDATA[\n]]>", "<!DOCTYPE\nhtml>", ...["pre", "script", "style", "textarea"].map((tag) => `<${tag}>\n</${tag}>`)]) {
	for (const code of [true, false]) {
		test(`real host preserves code/definition after a terminated HTML block: ${html} / ${code}`, () => {
			const source = `${html}\n${code ? "    ① https://code.example/a，" : "[①]: https://target.example/②，path\n\nSee [①]."}`;
			const native = render(source, { native: true });
			assert.deepEqual(native.targets, code ? [] : ["https://target.example/②，path"]);
			if (code) assert.ok(native.visible.includes("① https://code.example/a，"));
			for (const options of [{}, { streaming: true }, { user: true }]) {
				const out = render(source, options);
				assert.deepEqual(out.targets, native.targets);
				assert.strictEqual(out.visible, native.visible);
			}
		});
	}
}

test("real host cannot invent references from a standalone HTML terminator in inline code", () => {
	const source = "``sample\n-->\n[https://ref.example/a，]: https://code.example/①，\n``\n\nSee [https://ref.example/a，].";
	assert.deepEqual(render(source, { native: true }).targets, ["https://ref.example/a，]"]);
	for (const options of [{}, { streaming: true }, { user: true }]) {
		assert.deepEqual(render(source, options).targets, ["https://ref.example/a"]);
	}
});
