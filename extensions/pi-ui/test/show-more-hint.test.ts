// Adapted from pi-cc-extensions v0.8.69; see THIRD_PARTY_NOTICES.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	expandShortcutText,
	collapseHintText,
	isToolTuiFullscreen,
	setToolTuiFullscreen,
	showMoreHintText,
} from "../src/transcript/tool/show-more-hint.ts";

test("show-more hint follows the TUI mode", () => {
	setToolTuiFullscreen(true);
	assert.equal(isToolTuiFullscreen(), true);
	assert.equal(showMoreHintText(), "click to show more");
	assert.equal(collapseHintText(), "click to collapse");

	// regular（保留原生 scrollback、不启用鼠标上报）：提示默认展开快捷键。
	setToolTuiFullscreen(false);
	assert.equal(isToolTuiFullscreen(), false);
	assert.equal(showMoreHintText(), `${expandShortcutText()} to show more`);
	assert.equal(collapseHintText(), `${expandShortcutText()} to collapse`);
	assert.match(showMoreHintText(), /^ctrl\+o to show more$/);

	// 未安装（纯渲染/测试）时按 fullscreen 处理，保持既有行为。
	setToolTuiFullscreen(undefined as any);
	assert.equal(showMoreHintText(), "click to show more");
});
