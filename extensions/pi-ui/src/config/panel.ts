import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, SettingsList, truncateToWidth, type SettingItem } from "@earendil-works/pi-tui";
import { config, EXPANDED_CARD_BACKGROUND_SLOTS, updateConfig, type Config } from "./config.ts";

const sections = ["Style", "Files", "Thinking", "UI"] as const;
const fields: Array<Array<[keyof Config, string, string[]]>> = [
	[["mode", "Mode", ["on", "compact", "off"]], ["excludeRenderers", "Original renderers", []]],
	[["writePreviewLines", "Write preview lines", ["0", "4", "10", "24", "40"]],
	 ["editPreviewLines", "Edit preview lines", ["14", "24", "40", "80"]],
	 ["fileExpandedMaxLines", "Expanded file lines", ["40", "80", "120", "500", "2000"]]],
	[["useSummaryTitlesAsThinkingTitle", "Summary titles", ["true", "false"]],
	 ["previewLines", "Preview lines", ["0", "1", "3", "5", "10"]],
	 ["animationIntervalMs", "Animation interval (ms)", ["40", "60", "90", "120", "180"]]],
	[["inputClip", "Summary characters (0 = auto)", ["0", "40", "80", "100", "160"]],
	 ["expandedInputMaxLines", "Input preview lines", ["5", "10", "20", "40"]],
	 ["expandedOutputMaxLines", "Output preview lines", ["10", "20", "40", "80"]],
	 ["expandedCardBackground", "Expanded card background", [...EXPANDED_CARD_BACKGROUND_SLOTS]],
	 ["stickyUserMessage", "Sticky user message", ["true", "false"]]],
];

export async function showStylePanel(ctx: ExtensionCommandContext, changed: () => void): Promise<void> {
	await ctx.ui.custom((tui, theme, _keys, done) => {
		let active = 0;
		let error = "";
		let focused = false;
		let submenuInput: Input | undefined;
		const apply = (key: keyof Config, value: string) => {
			try {
				const next = key === "excludeRenderers" ? value.split(",").map((name) => name.trim()).filter(Boolean)
					: typeof config[key] === "number" ? Number(value) : typeof config[key] === "boolean" ? value === "true" : value;
				if (typeof next === "number" && !Number.isFinite(next)) throw new Error("Enter a number");
				updateConfig({ [key]: next });
				list.updateValue(key, Array.isArray(config[key]) ? config[key].join(", ") || "none" : String(config[key]));
				changed();
				error = "";
				return true;
			} catch (cause) {
				list.updateValue(key, Array.isArray(config[key]) ? config[key].join(", ") || "none" : String(config[key]));
				error = cause instanceof Error ? cause.message : String(cause);
				return false;
			}
		};
		const makeList = () => {
			const items: SettingItem[] = fields[active]!.map(([key, label, values]) => ({
				id: key, label, currentValue: Array.isArray(config[key]) ? config[key].join(", ") || "none" : String(config[key]),
				values: values.length ? values : undefined,
				submenu: values.length && typeof config[key] !== "number" ? undefined : (value, close) => {
					const input = new Input();
					submenuInput = input;
					input.focused = focused;
					input.setValue(value === "none" ? "" : value);
					input.onSubmit = (text) => { if (apply(key, text)) { submenuInput = undefined; close(); } };
					input.onEscape = () => { submenuInput = undefined; close(); };
					return input;
				},
			}));
			return new SettingsList(items, 12, {
				label: (text, selected) => theme.fg(selected ? "accent" : "text", text),
				value: (text, selected) => theme.fg(selected ? "accent" : "muted", text),
				description: (text) => theme.fg("dim", text),
				cursor: theme.fg("accent", "> "),
				hint: (text) => theme.fg("dim", text),
			}, (id, value) => apply(id as keyof Config, value), () => done(undefined));
		};
		let list = makeList();
		let tabs: Array<{ start: number; end: number }> = [];
		return {
			get focused() { return focused; },
			set focused(value: boolean) { focused = value; if (submenuInput) submenuInput.focused = value; },
			render(width: number) {
				let x = 0;
				tabs = [];
				const tabLine = sections.map((name, index) => {
					tabs.push({ start: x, end: x + name.length });
					x += name.length + 3;
					return theme.fg(index === active ? "accent" : "dim", name);
				}).join(" / ");
				return [theme.bold("Tool rendering"), "", tabLine, "", ...list.render(width),
					...(error ? [theme.fg("error", error)] : [])].map((line) => truncateToWidth(line, width));
			},
			invalidate() { list.invalidate(); },
			handleInput(data: string) {
				if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
					active = (active + (matchesKey(data, "shift+tab") ? sections.length - 1 : 1)) % sections.length;
					submenuInput = undefined;
					list = makeList(); tui.requestRender();
				} else { list.handleInput(data); tui.requestRender(); }
			},
			handleMouse(event: import("@earendil-works/pi-tui").TuiMouseEvent) {
				if (event.y === 2 && event.type === "click" && event.button === "left") {
					const index = tabs.findIndex(({ start, end }) => event.x >= start && event.x < end);
					if (index >= 0) { active = index; submenuInput = undefined; list = makeList(); return { handled: true, render: true }; }
				}
				if (event.y >= 4) return list.handleMouse({ ...event, y: event.y - 4 });
				return undefined;
			},
		};
	});
}
