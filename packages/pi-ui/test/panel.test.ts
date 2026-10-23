import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme, type ExtensionUIContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { createUiConfig } from "../src/config.js";
import { showSettings } from "../src/panel.js";

test("settings changes save and apply, while failed writes keep the displayed choice", async (t) => {
	initTheme("dark");
	const directory = mkdtempSync(join(tmpdir(), "pi-ui-panel-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const path = join(directory, "pi-ui.json");
	const store = createUiConfig(path);
	let applied = 0;
	const notices: string[] = [];
	const ui = {
		async custom(factory: Parameters<ExtensionUIContext["custom"]>[0]) {
			const { theme } = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as { theme: Theme };
			const component = await factory({ requestRender() {} } as never, theme, {} as never, () => {});
			const view: Component = component;
			view.handleInput?.("\r");
			assert.equal(store.get().useSummaryTitlesAsThinkingTitle, false);
			assert.equal(applied, 1);
			assert.equal(JSON.parse(readFileSync(path, "utf8")).useSummaryTitlesAsThinkingTitle, false);
			writeFileSync(path, "{");
			view.handleInput?.("\r");
			assert.equal(store.get().useSummaryTitlesAsThinkingTitle, false);
			assert.equal(applied, 1);
			assert.ok(view.render(100).some((line) => line.includes("off")));
		},
		notify(message: string) { notices.push(message); },
	} as unknown as Pick<ExtensionUIContext, "custom" | "notify">;
	await showSettings(ui, store, () => { applied++; });
	assert.equal(notices.length, 1);
	assert.match(notices[0]!, /save/i);
});
