// Adapted from pi-cc-extensions v0.8.69; see THIRD_PARTY_NOTICES.md.
import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { escCloseHitbox, hasActiveTextPreview, showTextPreview } from "../src/overlays/text-preview.ts";

initTheme("dark");

test("escCloseHitbox sits 5 columns wide at the title row's right edge", () => {
	assert.deepEqual(escCloseHitbox({ left: 8, top: 1, width: 64 }), {
		row: 3,
		startCol: 67,
		endCol: 71,
	});
	assert.deepEqual(escCloseHitbox({ left: 1, top: 1, width: 38 }), {
		row: 3,
		startCol: 34,
		endCol: 38,
	});
	assert.deepEqual(escCloseHitbox({ left: 20, top: 6, width: 50 }), {
		row: 8,
		startCol: 65,
		endCol: 69,
	});
});

/** showTextPreview 自定义 UI 的最小 harness：捕获 component（挂载后实时可读），theme 可注入，可选挂载回调。 */
function textPreviewHarness(
	theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text },
	onMount?: (component: any) => void,
): any {
	let component: any;
	return {
		custom: async (factory: any) =>
			await new Promise<void>((resolve) => {
				component = factory(
					{ terminal: { columns: 80, rows: 24 }, requestRender() {} },
					theme,
					null,
					resolve,
				);
				onMount?.(component);
			}),
		get component() {
			return component;
		},
	};
}

test("showTextPreview highlights and closes from the [esc] mouse hitbox", async () => {
	let escColor = "";
	const ui = textPreviewHarness(
		{
			fg: (color: string, text: string) => {
				if (text === "[esc]") escColor = color;
				return text;
			},
			bold: (text: string) => text,
		},
		(c) => c.render(64),
	);
	const preview = showTextPreview({ ui } as any, "Output", "hello");
	assert.equal(hasActiveTextPreview(), true);
	assert.equal(escColor, "muted");
	// 80×24、64 列居中、margin 2 → [esc] 命中 row=4, col=67..71。
	ui.component.handleInput(`\x1b[<35;67;4M`);
	ui.component.render(64);
	assert.equal(escColor, "text", "[esc] hover switches to text color");
	ui.component.handleInput(`\x1b[<0;67;4M`);
	await preview;
	assert.equal(hasActiveTextPreview(), false);
});

test("showTextPreview scrollbar supports press and drag", async () => {
	const ui = textPreviewHarness();
	const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
	const preview = showTextPreview({ ui } as any, "Output", content);
	const initial = ui.component.render(64).join("\n");
	assert.match(initial, /1-13 \/ 100 lines/);
	// scrollbar col=71，body track row=6..18；从顶部 thumb 拖到底部。
	ui.component.handleInput(`\x1b[<0;71;6M`);
	ui.component.handleInput(`\x1b[<32;71;18M`);
	ui.component.handleInput(`\x1b[<0;71;18m`);
	const dragged = ui.component.render(64).join("\n");
	assert.match(dragged, /88-100 \/ 100 lines/);
	ui.component.handleInput("\x1b");
	await preview;
});

test("showTextPreview accepts normalized overlay mouse events", async () => {
	const ui = textPreviewHarness();
	const preview = showTextPreview({ ui } as any, "Output", Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n"));
	const mouse = (type: string, screenX: number, screenY: number, wheelDelta = 0) => ui.component.handleMouse({
		type, button: "left", x: screenX - 8, y: screenY - 2, screenX, screenY, width: 64, height: 20,
		shift: false, alt: false, ctrl: false, wheelDelta,
	});
	try {
		ui.component.render(64);
		mouse("wheel", 30, 10, 3);
		assert.match(ui.component.render(64).join("\n"), /4-16 \/ 100 lines/);
		assert.equal(mouse("press", 70, 5).capture, true);
		mouse("drag", 70, 17); mouse("release", 70, 17);
		assert.match(ui.component.render(64).join("\n"), /88-100 \/ 100 lines/);
	} finally { ui.component.handleInput("\x1b"); await preview; }
});

test("text preview activity is released when custom UI rejects", async () => {
	await assert.rejects(showTextPreview({ ui: { custom: async () => { throw new Error("closed"); } } } as any, "Output", "text"), /closed/);
	assert.equal(hasActiveTextPreview(), false);
});
