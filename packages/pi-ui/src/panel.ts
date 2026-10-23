import { getSettingsListTheme, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";
import type { createUiConfig, UiConfig } from "./config.js";

export async function showSettings(
	ui: Pick<ExtensionUIContext, "custom" | "notify">,
	store: ReturnType<typeof createUiConfig>,
	apply: () => void,
): Promise<void> {
	await ui.custom<void>((tui, theme, _keys, done) => {
		const config = store.get();
		const booleanValues = ["on", "off"];
		const value = (key: keyof UiConfig): string => {
			const current = store.get()[key];
			return typeof current === "boolean" ? current ? "on" : "off" : String(current);
		};
		const items: SettingItem[] = [
			{ id: "useSummaryTitlesAsThinkingTitle", label: "Reasoning summary titles", description: "Use the latest bold reasoning summary as the Thinking title.", currentValue: value("useSummaryTitlesAsThinkingTitle"), values: booleanValues },
			{ id: "previewLines", label: "Thinking preview lines", description: "Tail visual lines while collapsed; 0 hides the preview.", currentValue: value("previewLines"), values: Array.from({ length: 21 }, (_, index) => String(index)) },
			{ id: "animationIntervalMs", label: "Animation interval (ms)", description: "Only redraws active Thinking; no history traversal.", currentValue: value("animationIntervalMs"), values: [...new Set([40, 60, 90, 120, 180, 250, 500, 1000, config.animationIntervalMs])].sort((a, b) => a - b).map(String) },
			{ id: "stickyUserMessage", label: "Sticky user message", description: "Show the first body line above a scrolled fullscreen transcript.", currentValue: value("stickyUserMessage"), values: booleanValues },
		];
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("Pi UI")), 1, 1));
		const list = new SettingsList(items, 10, getSettingsListTheme(), (id, selected) => {
			try {
				switch (id) {
					case "useSummaryTitlesAsThinkingTitle": store.update({ useSummaryTitlesAsThinkingTitle: selected === "on" }); break;
					case "previewLines": store.update({ previewLines: Number(selected) }); break;
					case "animationIntervalMs": store.update({ animationIntervalMs: Number(selected) }); break;
					case "stickyUserMessage": store.update({ stickyUserMessage: selected === "on" }); break;
					default: return;
				}
				apply();
			} catch (error) {
				list.updateValue(id, value(id as keyof UiConfig));
				ui.notify(`Could not save Pi UI settings: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		}, () => done());
		container.addChild(list);
		return Object.assign(container, {
			handleInput(data: string) { list.handleInput(data); tui.requestRender(); },
		});
	});
}
