import { getSettingsListTheme, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";
import type { createUiConfig, UiConfig } from "./config.js";

export async function showSettings(
	ui: Pick<ExtensionUIContext, "custom" | "notify">,
	store: ReturnType<typeof createUiConfig>,
	apply: () => void,
	models: readonly (NonNullable<UiConfig["sessionNameModel"]> & { name?: string })[] = [],
): Promise<void> {
	await ui.custom<void>((tui, theme, _keys, done) => {
		const config = store.get();
		const booleanValues = ["on", "off"];
		const modelChoices = new Map(models.map((model) => [JSON.stringify([model.provider, model.id]), model]));
		const value = (key: keyof UiConfig): string => {
			const current = store.get()[key];
			if (key === "sessionNameModel") {
				const model = store.get().sessionNameModel;
				return model ? `${model.provider}/${model.id}` : "Follow chat model";
			}
			return typeof current === "boolean" ? current ? "on" : "off" : String(current);
		};
		const items: SettingItem[] = [
			{ id: "useSummaryTitlesAsThinkingTitle", label: "Reasoning summary titles", description: "Use the latest bold reasoning summary as the Thinking title.", currentValue: value("useSummaryTitlesAsThinkingTitle"), values: booleanValues },
			{ id: "previewLines", label: "Thinking preview lines", description: "Tail visual lines while collapsed; 0 hides the preview.", currentValue: value("previewLines"), values: Array.from({ length: 21 }, (_, index) => String(index)) },
			{ id: "animationIntervalMs", label: "Animation interval (ms)", description: "Only redraws active Thinking; no history traversal.", currentValue: value("animationIntervalMs"), values: [...new Set([40, 60, 90, 120, 180, 250, 500, 1000, config.animationIntervalMs])].sort((a, b) => a - b).map(String) },
			{ id: "stickyUserMessage", label: "Sticky user message", description: "Show the first body line above a scrolled fullscreen transcript.", currentValue: value("stickyUserMessage"), values: booleanValues },
			{ id: "autoSessionName", label: "Automatic session names", description: "Sends the first user message to the naming model and uses its quota. Manual names are preserved.", currentValue: value("autoSessionName"), values: booleanValues },
			{
				id: "sessionNameModel", label: "Naming model", description: "Only affects session naming, not the chat model.", currentValue: value("sessionNameModel"),
				submenu: (_current, done) => {
					const items: SettingItem[] = [
						{ id: "follow-chat", label: "Follow chat model", currentValue: "", values: [""] },
						...Array.from(modelChoices, ([id, model]) => ({
							id, label: `${model.provider}/${model.id}`, currentValue: "", values: [""],
							...(model.name && model.name !== model.id ? { description: model.name } : {}),
						})).sort((a, b) => a.label.localeCompare(b.label)),
					];
					const selected = store.get().sessionNameModel;
					const selectedId = selected ? JSON.stringify([selected.provider, selected.id]) : "follow-chat";
					if (selected && !modelChoices.has(selectedId)) {
						items.push({ id: selectedId, label: `${selected.provider}/${selected.id}`, currentValue: "unavailable" });
					}
					const selector = new SettingsList(items, 10, getSettingsListTheme(), (id) => done(id), () => done(), { enableSearch: true });
					selector.selectItem(selectedId);
					return selector;
				},
			},
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
					case "autoSessionName": store.update({ autoSessionName: selected === "on" }); break;
					case "sessionNameModel": {
						const model = modelChoices.get(selected);
						if (selected !== "follow-chat" && !model) return;
						store.update({ sessionNameModel: model ? { provider: model.provider, id: model.id } : null });
						list.updateValue(id, value("sessionNameModel"));
						break;
					}
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
			capturesViewportInput: list.capturesViewportInput,
			handleInput(data: string) { list.handleInput(data); tui.requestRender(); },
		});
	});
}
