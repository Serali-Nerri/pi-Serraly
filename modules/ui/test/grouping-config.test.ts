import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { setConfig } from "../src/config/config.ts";
import { ToolGroupComponent } from "../src/compat/grouping.ts";
import { truncatePathToWidth } from "../src/transcript/tool/names.ts";
import { harness, strip } from "./harness.ts";

const result = (text: string) => ({ content: [{ type: "text", text }], isError: false });

test("settled group cache reacts to inputClip changes without invalidate", async () => {
	const h = await harness();
	const relative = join(
		"extensions",
		"very-long-feature-name",
		"nested-renderer-implementation",
		"target-file.ts",
	);
	try {
		h.tool("read", "clip-read", { path: join(process.cwd(), relative) }, result("body"));
		h.tool("bash", "clip-bash", { command: "echo ok" }, result("ok"));
		const group = h.root.children.find((child) => child instanceof ToolGroupComponent) as ToolGroupComponent;
		assert.ok(group);

		const readLine = () => {
			const line = group.render(44).map(strip).find((entry) => entry.includes("Read"));
			assert.ok(line, "the group must keep the read summary line");
			assert.ok(visibleWidth(line) <= 44);
			return line;
		};

		const first = readLine();
		assert.match(first, /Read .*…[\\/]target-file\.ts$/);
		// 未变化时命中 settled cache（同一行数组引用）。
		const cached = group.render(44);
		assert.equal(group.render(44), cached, "unchanged settled groups must still hit the cache");

		// 仅修改 config.inputClip，不调用 invalidate：缓存键必须让摘要立即重算。
		setConfig({ inputClip: 8 });
		const second = readLine();
		assert.notEqual(second, first);
		assert.ok(second.includes(truncatePathToWidth(relative, 8)));
		assert.ok(second.length < first.length, "clipped path must be narrower");

		setConfig({ inputClip: 100 });
		assert.equal(readLine(), first, "restoring inputClip must restore the rendered summary");
	} finally {
		setConfig({ inputClip: 100 });
		await h.close();
	}
});
