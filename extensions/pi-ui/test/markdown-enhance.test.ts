// Adapted from pi-cc-extensions v0.8.69; see THIRD_PARTY_NOTICES.md.
import { test } from "node:test";
import assert from "node:assert";
import enhance from "../src/markdown/index.ts";

const transformers: Array<(md: string, ctx?: object) => string> = [];
enhance({
	registerMarkdownTransformer: (fn: (md: string, ctx?: object) => string) => transformers.push(fn),
} as never);
const run = (
	md: string,
	ctx = { messageType: "assistant", isStreaming: false, availableWidth: 100 },
) => transformers.reduce((acc, fn) => fn(acc, ctx), md);

test("未闭合 fence 保留原文", () => {
	const out = run("```mermaid\ngraph LR\nA --> B");
	assert.ok(out.includes("```mermaid") && out.includes("A --> B"));
});

test("流式跳过", () => {
	const md = "```mermaid\ngraph LR\nA --> B\n```";
	assert.strictEqual(
		run(md, { messageType: "assistant", isStreaming: true, availableWidth: 100 }),
		md,
	);
});

test("thinking 块不转换（与官方推荐一致）", () => {
	const md = "```mermaid\ngraph LR\nA --> B\n```\n\n> [!NOTE] 提示\n\n看 https://example.com";
	assert.strictEqual(
		run(md, { messageType: "assistant-thinking", isStreaming: false, availableWidth: 100 }),
		md,
	);
});

test("流式跨行链接不产生空白 OSC 8 点击区", () => {
	const md = "前缀 [\n](https://example.com)\n```md\n[代码\n链接](https://code.example)\n```";
	const out = run(md, {
		messageType: "assistant",
		isStreaming: true,
		availableWidth: 100,
	});
	assert.ok(out.includes("前缀 [](https://example.com)"), JSON.stringify(out));
	assert.ok(out.includes("[代码\n链接](https://code.example)"), JSON.stringify(out));
});

test("波浪线围栏外的跨行链接仍规整", () => {
	const md = "前缀 [\n](https://example.com)\n~~~md\n[代码\n链接](https://code.example)\n~~~";
	const out = run(md, {
		messageType: "assistant",
		isStreaming: true,
		availableWidth: 100,
	});
	assert.ok(out.includes("前缀 [](https://example.com)"), JSON.stringify(out));
	assert.ok(out.includes("[代码\n链接](https://code.example)"), JSON.stringify(out));
});

test("admonition 转换", () => {
	assert.ok(run("> [!WARNING] 磁盘不足\n> 续行\n\n正文").includes("> **⚠️ WARNING** 磁盘不足 续行"));
	assert.ok(run("> [!NOTE] 提示").includes("> **💡 NOTE** 提示"));
	assert.ok(run("> [!warning] 小心").includes("WARNING"));
	assert.strictEqual(run("> 普通引用").trim(), "> 普通引用");
});

test("admonition 引用块后空行", () => {
	const out = run("> [!WARNING] 磁盘不足\n\n正文");
	// 提示框后至少有一个空行，防止紧接段落被合并
	assert.ok(out.includes("> **⚠️ WARNING** 磁盘不足\n\n"), JSON.stringify(out));
});

test("代码块内 admonition 不转换", () => {
	const out = run("```md\n> [!NOTE] 示例\n```\n\n> [!NOTE] 块外");
	assert.ok(out.includes("> [!NOTE] 示例"));
	assert.ok(out.includes("> **💡 NOTE** 块外"));
});

test("admonition 内容 | 保留", () => {
	const out = run("> [!NOTE] 参数 a|b 说明");
	assert.ok(out.includes("a|b"), JSON.stringify(out));
});

test("嵌套提示框不互相吞并", () => {
	const out = run("> [!NOTE] 甲\n> [!WARNING] 乙");
	assert.ok(out.includes("> **💡 NOTE** 甲") && out.includes("> **⚠️ WARNING** 乙"));
});

test("行内代码与 <url> 不动", () => {
	const out = run("用 `https://code.com/x` 和 <https://auto.com> 和 https://plain.com");
	assert.ok(out.includes("`https://code.com/x`"));
	assert.ok(!out.includes("[https://code.com/x]"));
	assert.ok(out.includes("<https://auto.com>"));
	assert.ok(out.includes("https://plain.com"));
});

test("多反引号行内代码内的 URL 不动", () => {
	const out = run("用 ``https://code.com/x`` 和 https://plain.com");
	assert.ok(out.includes("``https://code.com/x``"), JSON.stringify(out));
	assert.ok(!out.includes("[https://code.com/x]"));
	assert.ok(out.includes("https://plain.com"));
	const out2 = run("用 ```https://code.com/y``` 结束");
	assert.ok(out2.includes("```https://code.com/y```"), JSON.stringify(out2));
});

test("已有链接/图片保护", () => {
	const out = run("链接 [点我](https://example.com) 图片 ![图](https://img.com/a.png)");
	assert.ok(out.includes("[点我](https://example.com)"));
	assert.ok(out.includes("![图](https://img.com/a.png)"));
});

test("URL 标签与目标相同的既有链接不被改写", () => {
	const md = "[https://example.com](https://example.com)";
	assert.strictEqual(run(md), md);
});

test("标签含 URL 的既有链接整体受保护", () => {
	const md = "[看 https://example.com/a](https://example.com/b) 结束";
	assert.ok(run(md).includes(md), JSON.stringify(run(md)));
});

test("图片标签与目标中的 URL 受保护", () => {
	const md = "![图 https://img.com/a.png](https://img.com/a.png)";
	assert.ok(run(md).includes(md), JSON.stringify(run(md)));
});

test("标签内嵌套方括号的链接整体受保护", () => {
	const md = "[图 [A] https://example.com/x](https://example.com/y)";
	assert.ok(run(md).includes(md), JSON.stringify(run(md)));
});

test("代码块内 URL 不动", () => {
	const out = run('```js\nconst u = "https://code.com/x";\n```\n外链 https://outside.com');
	assert.ok(!out.includes("[https://code.com/x]"));
	assert.ok(out.includes("https://outside.com"));
});

test("波浪线围栏内不转换", () => {
	const md =
		"~~~md\nhttps://code.example/x\n```mermaid\ngraph LR\nA --> B\n```\n~~~\n外链 https://outside.com";
	const out = run(md);
	assert.ok(out.includes("~~~md\nhttps://code.example/x"), JSON.stringify(out));
	assert.ok(!out.includes("┌"), JSON.stringify(out));
	assert.ok(out.includes("https://outside.com"), JSON.stringify(out));
});

test("外层四反引号围栏内的 ```mermaid 示例保持原文", () => {
	const md = "````md\n```mermaid\ngraph LR\nA --> B\n```\n````\n外链 https://outside.com";
	const out = run(md);
	assert.ok(out.includes("```mermaid\ngraph LR\nA --> B\n```"), JSON.stringify(out));
	assert.ok(!out.includes("┌"), JSON.stringify(out));
	assert.ok(out.includes("https://outside.com"), JSON.stringify(out));
});

test("最多 3 空格缩进的围栏内 URL 不动", () => {
	const md = "  ```md\n  https://code.example/x\n  ```\n外链 https://outside.com";
	const out = run(md);
	assert.ok(!out.includes("[https://code.example/x]"), JSON.stringify(out));
	assert.ok(out.includes("https://outside.com"));
});

test("关闭围栏不短于开启围栏才闭合", () => {
	const longer = run("```md\nhttps://code.example/x\n`````\n外链 https://outside.com");
	assert.ok(!longer.includes("[https://code.example/x]"), JSON.stringify(longer));
	assert.ok(longer.includes("https://outside.com"));

	const shorter = run(
		"````md\nhttps://code.example/x\n```\nhttps://still-code.example/y\n````\n外链 https://outside.com",
	);
	assert.ok(!shorter.includes("[https://still-code.example/y]"), JSON.stringify(shorter));
	assert.ok(shorter.includes("https://outside.com"));
});

test("波浪线围栏内 admonition 不转换", () => {
	const out = run("~~~md\n> [!NOTE] 示例\n~~~\n\n> [!NOTE] 块外");
	assert.ok(out.includes("> [!NOTE] 示例"), JSON.stringify(out));
	assert.ok(out.includes("> **💡 NOTE** 块外"), JSON.stringify(out));
});

test("跨行行内代码不改写链接或合并源码行", () => {
	const md = "``[代码\n链接](https://example.com)\nhttps://code.example``\n\nhttps://outside.example";
	const out = run(md);
	assert.ok(out.startsWith("``[代码\n链接](https://example.com)\nhttps://code.example``"));
	assert.ok(out.endsWith("https://outside.example"));
});

test("流式未闭合链接也规整跨行标签", () => {
	assert.strictEqual(run("前缀 [\n](https://example", {
		messageType: "assistant", isStreaming: true, availableWidth: 100,
	}), "前缀 [](https://example");
});

test("引用链接定义保持原文", () => {
	const md = '[docs]: https://example.com/docs "Documentation"\n\n看 [docs]。';
	assert.strictEqual(run(md), md);
});

test("大量未配对括号不破坏尾部已有链接", () => {
	const md = "[".repeat(30_000) + "[https://example.com](https://example.com)";
	assert.strictEqual(run(md), md);
});

test("圈数字转半角括号（Nerd Font 字形缺陷规避）", () => {
	assert.strictEqual(run("方案②引入，共⑩项"), "方案(2)引入，共(10)项");
	assert.ok(run("① ② ⑳").includes("(1) (2) (20)"));
});

test("all retained features use one Markdown transformer", () => {
	assert.strictEqual(transformers.length, 1);
});

test("host-native mermaid and former nonstandard aliases pass through at every width", () => {
	for (const label of ["mermaid", "sequenceDiagram", "stateDiagram", "stateDiagram-v2", "classDiagram", "classDiagram-v2", "erdiagram"]) {
		for (const width of [10, 100]) {
			const md = `\`\`\`${label}\ngraph LR\nA[①] --> B[https://example.com]\n\`\`\``;
			assert.strictEqual(run(md, { messageType: "assistant", isStreaming: false, availableWidth: width }), md);
		}
	}
	const md = "````mermaid\ngraph LR\nA --> B\n````";
	assert.strictEqual(run(md), md);
});

// Ordinary bare URLs and ASCII delimiters still belong to Pi.
for (const [name, md] of [
	["bare URL", "访问 https://example.com/path 看看。"],
	["English punctuation", "https://example.com/a, end; https://example.com/a. next; https://example.com/a!"],
	["adjacent backticks", "见 https://example.com`` 结束"],
	["balanced parentheses", "见 https://en.wikipedia.org/wiki/A_(B) 结束"],
	["unmatched brackets", "列表 [https://example.com/a] 项; 尾括号 https://example.com/x)"],
	["IPv6 brackets", "IPv6 https://[::1]:8080/x 保留"],
]) {
	test(`host-native URL pass-through: ${name}`, () => assert.strictEqual(run(md), md));
}

test("only host-mishandled bare URL punctuation boundaries receive native autolinks", () => {
	assert.strictEqual(run("看 https://example.com/a，和 https://b.com/x. 结束"),
		"看 <https://example.com/a>，和 https://b.com/x. 结束");
	assert.strictEqual(run("全角（https://example.com/a）"), "全角（<https://example.com/a>）");
	assert.strictEqual(run("https://example.com/a_(B).，https://example.com/x)；"),
		"<https://example.com/a_(B)>.，<https://example.com/x>)；");
	assert.strictEqual(run("https://example.com/①，② www.example.com/③。"),
		"<https://example.com/①>，(2) [www.example.com/③](<http://www.example.com/③>)。");
});

test("punctuation compatibility preserves code, existing links, images and autolink targets", () => {
	for (const md of [
		"`https://code.example/a，` ``https://code.example/a）``",
		"``https://code.example/a，\nhttps://code.example/b）``",
		"```md\nhttps://code.example/a，\n```",
		"~~~md\nhttps://code.example/a）\n~~~",
		"    https://code.example/a，\n\thttps://code.example/b）",
		"[https://label.example/a，](https://target.example/a，) ![https://image.example/a）](https://image.example/b）)",
		"[nested [label] https://label.example/a，](https://target.example/a）)",
		"<https://auto.example/a，和> <ftp://auto.example/a）>",
		'<a href="https://target.example/a，">https://label.example/b）</a>',
	]) assert.strictEqual(run(md), md);
});

test("punctuation compatibility protects reference labels and targets across code", () => {
	const definition = '[https://ref.example/a，]: https://target.example/b） "title，"';
	const links = "[https://ref.example/a，] [https://ref.example/a，][] [https://label.example/b）][https://ref.example/a，]";
	for (const [, wrapCode] of referenceCodeBlocks) {
		const code = wrapCode("https://code.example/a，");
		for (const md of [`${definition}\n\n${code}\n\n${links}`, `${links}\n\n${code}\n\n${definition}`]) {
			assert.strictEqual(run(md), md);
			assert.strictEqual(run(run(md)), md);
		}
	}
});

test("punctuation compatibility is display-only, streaming-safe and idempotent", () => {
	const md = "看 https://example.com/①_(B)，② https://b.com/x） https://normal.example/x.";
	const ctx = { messageType: "assistant", isStreaming: true, availableWidth: 20 };
	const streamed = run(md, ctx);
	assert.strictEqual(streamed, "看 <https://example.com/①_(B)>，② <https://b.com/x>） https://normal.example/x.");
	assert.strictEqual(run(streamed, ctx), streamed);
	assert.strictEqual(run(run(md)), run(md));
	assert.strictEqual(run(streamed), run(md));
	assert.strictEqual(run(md, { ...ctx, messageType: "assistant-thinking" }), md);
});

test("all five admonition labels and case-insensitive markers remain supported", () => {
	for (const [label, icon] of [["NOTE", "💡"], ["TIP", "✅"], ["IMPORTANT", "❗"], ["WARNING", "⚠️"], ["CAUTION", "⚠️"]]) {
		assert.strictEqual(run(`> [ !${label.toLowerCase()} ] ①`), `> **${icon} ${label}** (1)\n`);
	}
	assert.strictEqual(run("> [!UNKNOWN] ①"), "> [!UNKNOWN] (1)");
});

test("wrapped links trim indentation, preserve destinations and punctuation", () => {
	assert.strictEqual(run("See [ ① first \n\t second② \n ](https://example.com/a_(①) \"②\"), end."),
		"See [(1) first second(2)](https://example.com/a_(①) \"②\"), end.");
});

test("circled numerals remain literal in inline code of any delimiter length", () => {
	assert.strictEqual(run("① `②` ``③ `④` ⑤`` ```⑥``` ⑳"), "(1) `②` ``③ `④` ⑤`` ```⑥``` (20)");
	assert.strictEqual(run("① ``②\n③`` ④"), "(1) ``②\n③`` (4)");
	assert.strictEqual(run("\\`①\\` `②` ③"), "\\`(1)\\` `②` (3)");
	assert.strictEqual(run("（①），②.⑳!"), "（(1)），(2).(20)!");
});

test("circled numerals remain literal in fenced and indented code", () => {
	for (const fence of ["```", "~~~~", "   ````"]) {
		const md = `${fence}md\n① > [!TIP]\n[②\n③](https://code.example/④)\n${fence}\n⑤`;
		assert.strictEqual(run(md), md.slice(0, -1) + "(5)");
	}
	assert.strictEqual(run("    ①\n\t②\n\n③"), "    ①\n\t②\n\n(3)");
	assert.strictEqual(run("> ```md\n> ①\n> ```\n②"), "> ```md\n> ①\n> ```\n(2)");
	assert.strictEqual(run("- ```md\n  ①\n  ```\n②"), "- ```md\n  ①\n  ```\n(2)");
});

test("circled labels transform without modifying link targets, titles or code", () => {
	assert.strictEqual(run('[① `②` [③]](https://example.com/(④) "⑤") ![⑥](image⑦.png)'),
		'[(1) `②` [(3)]](https://example.com/(④) "⑤") ![(6)](image⑦.png)');
	assert.strictEqual(run("[①](https://example.com/②\\))"), "[(1)](https://example.com/②\\))");
});

test("circled numerals in autolinks, native URLs and reference targets are unchanged", () => {
	assert.strictEqual(run("① <https://example.com/②> https://example.com/③ www.example.com/④ ⑤"),
		"(1) <https://example.com/②> https://example.com/③ www.example.com/④ (5)");
	assert.strictEqual(run('[docs]: https://example.com/① "②"\n\n[③][docs] ④'),
		'[docs]: https://example.com/① "②"\n\n[(3)][docs] (4)');
	assert.strictEqual(run("[①][②]"), "[(1)][②]");
});

test("all retained transformations are idempotent", () => {
	const md = "> [!TIP] ①\n> second line\n\n[label\nnext](https://example.com/②)\n`③` ④\n\n~~~mermaid\ngraph LR\nA[⑤]-->B\n~~~\nhttps://example.com/⑥.";
	const out = run(md);
	assert.strictEqual(run(out), out);
	assert.strictEqual(run(run(md, { messageType: "assistant", isStreaming: true, availableWidth: 10 })), out);
});

test("retained transformations also apply to user Markdown", () => {
	assert.strictEqual(run("> [!NOTE] ①", { messageType: "user", isStreaming: false, availableWidth: 100 }),
		"> **💡 NOTE** (1)\n");
});

test("ordinary angle-delimited text still receives the numeral font workaround", () => {
	assert.strictEqual(run("<①> <em title=\"②\">③</em> <user①@example.com>"),
		"<(1)> <em title=\"②\">(3)</em> <user①@example.com>");
});

test("implicit reference keys are not rewritten and links keep resolving", () => {
	const md = "[①]: https://example.com/②\n\n[①] [①][] [③][①] ④";
	assert.strictEqual(run(md), "[①]: https://example.com/②\n\n[①] [①][] [(3)][①] (4)");
});

test("shortcut reference resolves across the reviewer-reported tilde fence", () => {
	const md = "[①]: https://example.com\n\n~~~text\nsample\n~~~\n\nSee [①].";
	assert.strictEqual(run(md), md);
});

const referenceCodeBlocks = [
	["tilde fence", (code: string) => `~~~text\n${code}\n~~~`],
	["backtick fence", (code: string) => `\`\`\`text\n${code}\n\`\`\``],
	["space-indented code", (code: string) => `    ${code}`],
	["tab-indented code", (code: string) => `\t${code}`],
] as const;

for (const [name, wrapCode] of referenceCodeBlocks) {
	for (const position of ["before", "after"] as const) {
		test(`reference definitions ${position} ${name} protect shortcut, collapsed and full reference links`, () => {
			const definition = "[①]: https://example.com/② \"③\"";
			const code = wrapCode("sample ⑦ [⑧](https://code.example/⑨)");
			const links = "See [①]. [①][] [④][①] ⑤ [⑥].";
			const expectedLinks = "See [①]. [①][] [(4)][①] (5) [(6)].";
			const md = position === "before" ? `${definition}\n\n${code}\n\n${links}` : `${links}\n\n${code}\n\n${definition}`;
			const expected = position === "before" ? `${definition}\n\n${code}\n\n${expectedLinks}` : `${expectedLinks}\n\n${code}\n\n${definition}`;
			assert.strictEqual(run(md), expected);
			assert.strictEqual(run(expected), expected);
		});
	}

	test(`reference definitions inside ${name} do not protect ordinary bracketed prose`, () => {
		const code = wrapCode("[①]: https://code.example/② \"③\"");
		assert.strictEqual(run(`${code}\n\nSee [①]. ④`), `${code}\n\nSee [(1)]. (4)`);
	});
}

for (const position of ["before", "after"] as const) {
	test(`reference keys normalize case and spacing across a fence with definitions ${position}`, () => {
		const definition = "[ Mixed\t  CASE ① ]: https://example.com/② \"③\"";
		const code = "~~~text\nsample ⑦\n~~~";
		const links = "See [ mixed\n CASE ① ]. [MIXED \tcase ①][] [④][ Mixed CASE ① ] ⑤ [Mixed Case ⑥].";
		const expectedLinks = "See [ mixed\n CASE ① ]. [MIXED \tcase ①][] [(4)][ Mixed CASE ① ] (5) [Mixed Case (6)].";
		const md = position === "before" ? `${definition}\n\n${code}\n\n${links}` : `${links}\n\n${code}\n\n${definition}`;
		const expected = position === "before" ? `${definition}\n\n${code}\n\n${expectedLinks}` : `${expectedLinks}\n\n${code}\n\n${definition}`;
		assert.strictEqual(run(md), expected);
	});
}

test("literal backslashes inside inline code do not escape its closing backtick", () => {
	assert.strictEqual(run("`①\\` ② `③`"), "`①\\` (2) `③`");
});

test("wrapped nested link labels normalize prose but preserve inline code", () => {
	assert.strictEqual(run("[nested [①]\n next `②\n③`](https://example.com/④)"),
		"[nested [(1)] next `②\n③`](https://example.com/④)");
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
		test(`container source ranges protect global references: ${name}, definitions ${position} code`, () => {
			const definition = '[①]: https://target.example/②，path） "③"\n[www.ref.example/a，]: https://target.example/ref，path';
			const code = "~~~md\n[⑨]: https://code.example/⑩，\n~~~";
			const links = "[①] [①][] [④][①] [www.ref.example/a，] [www.ref.example/a，][] [label][www.ref.example/a，]";
			const expectedLinks = links.replace("[④]", "[(4)]");
			const body = position === "before" ? `${definition}\n\n${code}\n\n${links}` : `${links}\n\n${code}\n\n${definition}`;
			const expectedBody = position === "before" ? `${definition}\n\n${code}\n\n${expectedLinks}` : `${expectedLinks}\n\n${code}\n\n${definition}`;
			const md = `${wrap(body)}\n\nOutside [①] [①][] [④][①] [⑨].`;
			const expected = `${wrap(expectedBody)}\n\nOutside [①] [①][] [(4)][①] [(9)].`;
			assert.strictEqual(run(md), expected);
			assert.strictEqual(run(expected), expected);
			assert.strictEqual(run(md, { messageType: "assistant", isStreaming: true, availableWidth: 100 }), md);
			assert.strictEqual(run(md, { messageType: "user", isStreaming: false, availableWidth: 100 }), expected);
		});
	}
	for (const [codeName, code] of [
		["fence", "```md\n[①]: https://code.example/②，\n```"],
		["indented code", "    [①]: https://code.example/②，"],
		["indented code immediately after a definition", "[docs]: https://docs.example/a\n    [①]: https://code.example/②，"],
		["indented code after a wrapped destination", "[docs]:\nhttps://docs.example/a\n    [①]: https://code.example/②，"],
		["indented code after a wrapped title", '[docs]: https://docs.example/a\n"title"\n    [①]: https://code.example/②，'],
		["indented code after a wrapped destination and title", '[docs]:\nhttps://docs.example/a\n"title"\n    [①]: https://code.example/②，'],
		["indented code after a multiline title", '[docs]: https://docs.example/a\n"title\ncontinued"\n    [①]: https://code.example/②，'],
		["indented code after a multiline title opening beside the destination", '[docs]: https://docs.example/a "title\ncontinued"\n    [①]: https://code.example/②，'],
		["indented code after a wrapped destination with a multiline title", '[docs]:\nhttps://docs.example/a "title\ncontinued"\n    [①]: https://code.example/②，'],
		["indented code after a multiline single-quoted title", "[docs]: https://docs.example/a 'title\ncontinued'\n    [①]: https://code.example/②，"],
		["indented code after a multiline parenthesized title", "[docs]: https://docs.example/a (title\ncontinued)\n    [①]: https://code.example/②，"],
		["indented code after escaped close-angle destination and multiline title", '[docs]: <https://docs.example/a\\>b> "title\ncontinued"\n    [①]: https://code.example/②，'],
		["indented code after escaped open-angle destination and multiline title", '[docs]: <https://docs.example/a\\<b> "title\ncontinued"\n    [①]: https://code.example/②，'],
		["indented code after fence-looking title lines", '[docs]: <https://docs.example/a\\>b> "title\n~~~\nliteral\n~~~\ncontinued"\n    [①]: https://code.example/②，'],
		["indented code after an unpaired fence-looking title line", '[docs]: https://docs.example/a "title\n~~~\nliteral\ncontinued"\n[other]: https://docs.example/b "second\ncontinued"\n    [①]: https://code.example/②，'],
		["indented code after an ATX heading", "# Heading\n    [①]: https://code.example/②，"],
		["indented code after a setext heading", "Heading\n===\n    [①]: https://code.example/②，"],
		["indented code after a thematic break", "***\n    [①]: https://code.example/②，"],
		["indented code after a table", "| Header |\n| --- |\n| Body |\n    [①]: https://code.example/②，"],
		["multiline inline code", "``sample\n[①]: https://code.example/②，\n``"],
	]) {
		test(`code-only definitions in ${name} ${codeName} do not collect reference keys`, () => {
			const md = `${wrap(code)}\n\nSee [①].`;
			const expected = `${wrap(code)}\n\nSee [(1)].`;
			assert.strictEqual(run(md), expected);
			assert.strictEqual(run(expected), expected);
			assert.strictEqual(run(md, { messageType: "assistant", isStreaming: true, availableWidth: 100 }), md);
			assert.strictEqual(run(md, { messageType: "user", isStreaming: false, availableWidth: 100 }), expected);
		});
	}
}

test("www punctuation repair uses literal native labels, not USER-visible backslash escapes", () => {
	for (const path of ["a_b_c", "$x$", "*x*/tail", "[x]", "~~x~~/tail", "\\(x\\)/tail", "\\[x\\]/tail"]) {
		const url = `www.example.com/${path}`;
		const md = `看 ${url}，结束`;
		const label = `\`${url.replace(/\\(?=[\[\]])/g, "\\\\")}\``;
		const expected = `看 [${label}](<http://${url.replace(/\\/g, "\\\\")}>)，结束`;
		for (const ctx of [
			{ messageType: "assistant", isStreaming: false, availableWidth: 100 },
			{ messageType: "assistant", isStreaming: true, availableWidth: 100 },
			{ messageType: "user", isStreaming: false, availableWidth: 100 },
		]) {
			assert.strictEqual(run(md, ctx), expected);
			assert.strictEqual(run(expected, ctx), expected);
		}
	}
	const native = '`www.example.com/$x$，` [label](<http://www.example.com/$x$，path>) www.example.com/a_b_c';
	assert.strictEqual(run(native), native);
});

test("original source ranges cover quoted wrapped destinations and titles without swallowing later indented definitions", () => {
	const md = '> [①]:\n> https://target.example/②，path\n> "③ title"\n>   [④]: https://target.example/four，path\n>\n> ~~~md\n> [⑨]: https://code.example/a，\n> ~~~\n>   [⑤]: https://target.example/five，path\n>\n> [①] [④][] [label][⑤]\n\nSee [①] [④][] [label][⑤] [⑨].';
	const expected = md.replace("[⑨].", "[(9)].");
	assert.strictEqual(run(md), expected);
	assert.strictEqual(run(expected), expected);
	assert.strictEqual(run(md, { messageType: "assistant", isStreaming: true, availableWidth: 100 }), md);
});

test("an unmatched heading backtick cannot hide a following authoritative reference definition", () => {
	const md = '# Heading `\n[①]: https://target.example/②，path "title`"\n    [③]: https://code.example/④，\n\nSee [①].';
	for (const ctx of [
		{ messageType: "assistant", isStreaming: false, availableWidth: 100 },
		{ messageType: "assistant", isStreaming: true, availableWidth: 100 },
		{ messageType: "user", isStreaming: false, availableWidth: 100 },
	]) {
		assert.strictEqual(run(md, ctx), md);
	}
});

test("a newly opened quote cannot manufacture a reference destination around genuine code", () => {
	const md = '[docs]:\n> https://docs.example/a "title\n> ~~~text\n> ① https://code.example/a，\n> ~~~\n> continued"';
	for (const ctx of [
		{ messageType: "assistant", isStreaming: false, availableWidth: 100 },
		{ messageType: "assistant", isStreaming: true, availableWidth: 100 },
		{ messageType: "user", isStreaming: false, availableWidth: 100 },
	]) {
		assert.strictEqual(run(md, ctx), md);
	}
});

test("inline HTML inside multiline code cannot create a global reference key", () => {
	const source = "``sample\n<span>\n[https://ref.example/a，]: https://code.example/①，\n``\n\nSee [https://ref.example/a，].";
	const expected = source.replace("See [https://ref.example/a，].", "See [<https://ref.example/a>，].");
	for (const ctx of [
		{ messageType: "assistant", isStreaming: false, availableWidth: 100 },
		{ messageType: "assistant", isStreaming: true, availableWidth: 100 },
		{ messageType: "user", isStreaming: false, availableWidth: 100 },
	]) assert.strictEqual(run(source, ctx), expected);
});

for (const prefix of ["> ", "- ", "12. "]) {
	test(`validated definition extent excludes later new-container prose: ${prefix}`, () => {
		const source = `[docs]: https://docs.example/a\n${prefix}"① https://prose.example/a，suffix"\n\nSee [docs].`;
		const expected = source.replace('"① https://prose.example/a，suffix"', '"(1) <https://prose.example/a>，suffix"');
		assert.strictEqual(run(source), expected);
		assert.strictEqual(run(source, { messageType: "user", isStreaming: false, availableWidth: 100 }), expected);
		assert.strictEqual(run(source, { messageType: "assistant", isStreaming: true, availableWidth: 100 }),
			source.replace("https://prose.example/a，suffix", "<https://prose.example/a>，suffix"));
	});
}

for (const prefix of ["- ", "12. "]) {
	test(`native lazy reference destination remains authoritative: ${prefix}`, () => {
		const source = `${prefix}[①]:\nhttps://target.example/②，path\n\nSee [①].`;
		for (const ctx of [
			{ messageType: "assistant", isStreaming: false, availableWidth: 100 },
			{ messageType: "assistant", isStreaming: true, availableWidth: 100 },
			{ messageType: "user", isStreaming: false, availableWidth: 100 },
		]) assert.strictEqual(run(source, ctx), source);
	});
}

for (const html of ["<!--\n-->", "<?pi\n?>", "<![CDATA[\n]]>", "<!DOCTYPE\nhtml>", ...["pre", "script", "style", "textarea"].map((tag) => `<${tag}>\n</${tag}>`)]) {
	for (const after of ["    ① https://code.example/a，", "[①]: https://target.example/②，path\n\nSee [①]."]) {
		test(`genuine HTML termination preserves subsequent code/definition: ${html} / ${after}`, () => {
			const source = `${html}\n${after}`;
			for (const ctx of [
				{ messageType: "assistant", isStreaming: false, availableWidth: 100 },
				{ messageType: "assistant", isStreaming: true, availableWidth: 100 },
				{ messageType: "user", isStreaming: false, availableWidth: 100 },
			]) assert.strictEqual(run(source, ctx), source);
		});
	}
}

test("a standalone HTML-looking terminator in inline code cannot manufacture a key", () => {
	const source = "``sample\n-->\n[https://ref.example/a，]: https://code.example/①，\n``\n\nSee [https://ref.example/a，].";
	const expected = source.replace("See [https://ref.example/a，].", "See [<https://ref.example/a>，].");
	for (const ctx of [
		{ messageType: "assistant", isStreaming: false, availableWidth: 100 },
		{ messageType: "assistant", isStreaming: true, availableWidth: 100 },
		{ messageType: "user", isStreaming: false, availableWidth: 100 },
	]) assert.strictEqual(run(source, ctx), expected);
});
