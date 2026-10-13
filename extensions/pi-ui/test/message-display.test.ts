import assert from "node:assert/strict";
import test from "node:test";
import {
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	SkillInvocationMessageComponent,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { setCapabilityOverrides, visibleWidth } from "@earendil-works/pi-tui";
import { setConfig } from "../src/config/config.ts";
import { harness, theme } from "./harness.ts";

type SummaryCase = {
	name: string;
	make(): any;
	/** ccstyle 折叠行特征。 */
	collapsed: RegExp;
	/** 展开后的正文标记。 */
	body: string;
	/** 原生折叠行特征（message-display 接管前的渲染）。 */
	native: RegExp;
	/** 原生/ccstyle 折叠行上可点击执行的文字。 */
	clickTarget: string;
};

const summaryCases: SummaryCase[] = [
	{
		name: "skill",
		make: () =>
			new SkillInvocationMessageComponent({
				name: "demo",
				location: "SKILL.md",
				content: "SKILL_BODY [Ref](https://example.com/ref)",
				userMessage: undefined,
			}),
		collapsed: /✓ Skill demo • click to show more/,
		body: "SKILL_BODY",
		native: /\[skill\] demo/,
		clickTarget: "demo",
	},
	{
		name: "compaction",
		make: () =>
			new CompactionSummaryMessageComponent({
				role: "compactionSummary",
				summary: "COMPACTION_BODY",
				tokensBefore: 1000,
				timestamp: 1,
			} as any),
		collapsed: /✓ Compacted from 1,000 tokens • click to show more/,
		body: "COMPACTION_BODY",
		native: /\[compaction\]/,
		clickTarget: "Compacted",
	},
	{
		name: "branch",
		make: () =>
			new BranchSummaryMessageComponent({
				role: "branchSummary",
				summary: "BRANCH_BODY",
				fromId: null,
				timestamp: 1,
			} as any),
		collapsed: /✓ Branch summary • click to show more/,
		body: "BRANCH_BODY",
		native: /\[branch\]/,
		clickTarget: "Branch summary",
	},
];

const findRow = (lines: string[], pattern: RegExp | string): number =>
	lines.findIndex((line) =>
		typeof pattern === "string" ? line.includes(pattern) : pattern.test(line),
	);

test("completed tool and summary markers use the active semantic success foreground", async () => {
	const h = await harness();
	try {
		const tool = h.tool("bash", "success-theme", { command: "synthetic-only" }, {
			content: [{ type: "text", text: "DONE" }], details: {},
		});
		const summaries = summaryCases.map((summary) => summary.make());
		for (const component of summaries) h.root.addChild(component);
		for (const name of ["dark", "light"]) {
			initTheme(name, false);
			await h.emit("session_tree");
			for (const component of [tool, ...summaries]) {
				const lines = component.render(100).join("\n");
				assert.ok(lines.includes(`${theme.getFgAnsi("success")}✓`), `${name}: completion marker uses the theme color\n${lines}`);
			}
		}
	} finally {
		initTheme("dark", false);
		await h.close();
	}
});

for (const mode of ["on", "compact"] as const) {
	for (const summary of summaryCases) {
		test(`${mode}: ${summary.name} summary expands from its hint and collapses from the body`, async () => {
			const h = await harness({ mode });
			try {
				const component = summary.make();
				h.root.addChild(component);
				let lines = h.render();
				let row = findRow(lines, summary.collapsed);
				assert.ok(row >= 0, lines.join("\n"));

				// 提示行只在 hint 上响应：点击标题不展开。
				h.click(lines[row]!.indexOf(summary.clickTarget), row);
				assert.equal(component.expanded, false, "title clicks must not expand");

				lines = h.render();
				row = findRow(lines, "click to show more");
				assert.ok(row >= 0, lines.join("\n"));
				h.click(lines[row]!.indexOf("click to show more"), row);
				assert.equal(component.expanded, true);
				lines = h.render();
				row = findRow(lines, summary.body);
				assert.ok(row >= 0, lines.join("\n"));

				// 展开后的正文整块可点击折叠（与工具卡一致）。
				h.click(lines[row]!.indexOf(summary.body), row);
				assert.equal(component.expanded, false);
			} finally {
				await h.close();
			}
		});
	}
}

for (const mode of ["on", "off"] as const) {
	test(`${mode}: expanded summary bodies keep hyperlink activation and drag selection`, async () => {
		const h = await harness({ mode });
		setCapabilityOverrides({ hyperlinks: true });
		try {
			const opened: string[] = [];
			h.tui.openUrl = (url: string) => opened.push(url);
			const component = summaryCases[0]!.make();
			h.root.addChild(component);
			let lines = h.render();
			let row = mode === "on" ? findRow(lines, "click to show more") : findRow(lines, summaryCases[0]!.clickTarget);
			assert.ok(row >= 0, lines.join("\n"));
			h.click(
				lines[row]!.indexOf(mode === "on" ? "click to show more" : summaryCases[0]!.clickTarget),
				row,
			);
			assert.equal(component.expanded, true);
			lines = h.render();
			row = findRow(lines, "Ref");
			assert.ok(row >= 0, lines.join("\n"));

			const column = lines[row]!.indexOf("Ref");
			h.click(column, row);
			assert.deepEqual(opened, ["https://example.com/ref"]);
			assert.equal(component.expanded, true, "link activation must not collapse the summary");

			// 拖拽选择仍归 Pi：press 不被 hint 逻辑捕获，release 不合成折叠点击。
			h.pointer(column, row);
			h.pointer(column + 4, row, "drag");
			h.pointer(column + 4, row, "release");
			assert.equal(component.expanded, true, "drag selection must not collapse the summary");
			assert.ok(h.tui.selectionAnchor, "selection gesture must remain active");
		} finally {
			setCapabilityOverrides({});
			await h.close();
		}
	});
}

test("mounted summaries refresh when ccstyle turns on without a rebuild", async () => {
	const h = await harness({ mode: "off" });
	try {
		const component = summaryCases[0]!.make();
		h.root.addChild(component);
		let lines = h.render();
		assert.ok(findRow(lines, summaryCases[0]!.native) >= 0, lines.join("\n"));

		// session_tree 触发 refreshMountedTranscript：已挂载摘要必须重绘为 ccstyle。
		setConfig({ mode: "on" });
		await h.emit("session_tree");
		lines = h.render();
		assert.ok(findRow(lines, summaryCases[0]!.collapsed) >= 0, lines.join("\n"));
		assert.ok(findRow(lines, summaryCases[0]!.native) < 0, "native line must be replaced");
	} finally {
		await h.close();
	}
});

for (const summary of summaryCases) {
	test(`off mode: ${summary.name} summary restores native shell and toggles natively`, async () => {
		const h = await harness({ mode: "on" });
		try {
			const component = summary.make();
			h.root.addChild(component);
			h.render();
			assert.equal(component.bgFn, undefined, "ccstyle render clears the native background");
			assert.equal(component.paddingY, 0, "ccstyle collapsed render removes vertical padding");

			// on → off：refreshMountedTranscript 负责让摘要回到原生外壳与原生渲染。
			setConfig({ mode: "off" });
			await h.emit("session_tree");
			assert.equal(typeof component.bgFn, "function", "native bgFn must be restored");
			assert.equal(component.paddingX, 1);
			assert.equal(component.paddingY, 1, "native vertical padding must be restored");
			let lines = h.render();
			let row = findRow(lines, summary.native);
			assert.ok(row >= 0, lines.join("\n"));
			assert.ok(findRow(lines, summary.collapsed) < 0, "ccstyle line must be replaced");

			// off 原生 MouseRegion 仍负责整行点击切换。
			row = findRow(lines, summary.clickTarget);
			assert.ok(row >= 0, lines.join("\n"));
			h.click(lines[row]!.indexOf(summary.clickTarget), row);
			assert.equal(component.expanded, true);
			lines = h.render();
			row = findRow(lines, summary.body);
			assert.ok(row >= 0, lines.join("\n"));
			h.click(lines[row]!.indexOf(summary.body), row);
			assert.equal(component.expanded, false);

			// 反复切换不得丢失原生外壳快照。
			setConfig({ mode: "on" });
			await h.emit("session_tree");
			assert.equal(component.bgFn, undefined);
			lines = h.render();
			assert.ok(findRow(lines, summary.collapsed) >= 0, lines.join("\n"));

			setConfig({ mode: "off" });
			component.invalidate();
			assert.equal(typeof component.bgFn, "function", "restore must survive repeated transitions");
			assert.equal(component.paddingY, 1);
			lines = h.render();
			assert.ok(findRow(lines, summary.native) >= 0, lines.join("\n"));
			assert.ok(lines.every((line) => visibleWidth(line) <= h.terminal.columns));
		} finally {
			await h.close();
		}
	});
}
