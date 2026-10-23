import { type CodexConversionConfig, normalizeCompactToolsMode } from "../../adapter/activation/config.ts";
import { type ConfigSetting, setting, toggle } from "./config-items-shared.ts";

export function buildDisplaySettings(
	config: CodexConversionConfig,
): ConfigSetting[] {
	return [
		toggle(
			"statusLine",
			"Statusline",
			config.ui.statusLine,
			(enabled, current) => ({
				...current,
				ui: { ...current.ui, statusLine: enabled },
			}),
			"Show the adapter mode, context settings and available Codex usage information in Pi's status area.",
		),
		toggle(
			"toolRenaming",
			"Tool naming",
			config.ui.toolRenaming,
			(enabled, current) => ({
				...current,
				ui: { ...current.ui, toolRenaming: enabled },
			}),
			"Rename tool calls to user-friendly names.",
		),
		setting(
			{
				id: "compactTools",
				label: "Compact tool output",
				currentValue: config.ui.compactTools,
				values: ["off", "on", "minimal"],
				description: "On hides collapsed patch diffs. Minimal also replaces collapsed Code / Notebook source and console previews with an expand hint; call rows and diagnostics stay visible.",
			},
			(value, current) => ({
				...current,
				ui: { ...current.ui, compactTools: normalizeCompactToolsMode(value) ?? current.ui.compactTools },
			}),
		),
		toggle(
			"codeModeDetails",
			"Code / Notebook details",
			config.ui.codeModeDetails,
			(enabled, current) => ({
				...current,
				ui: { ...current.ui, codeModeDetails: enabled },
			}),
			"Show Code and Notebook source and console previews. Call rows, patches and important diagnostics remain visible when off.",
		),
		toggle(
			"noteSaveMarkers",
			"Note save markers",
			config.ui.noteSaveMarkers,
			(enabled, current) => ({
				...current,
				ui: { ...current.ui, noteSaveMarkers: enabled },
			}),
			"Mark saved notes and bookmark the next user prompt in /tree. Existing bookmarks are kept when switched off.",
		),
		toggle(
			"backgroundShellWidget",
			"Background shells widget",
			config.ui.backgroundShellWidget,
			(enabled, current) => ({
				...current,
				ui: { ...current.ui, backgroundShellWidget: enabled },
			}),
			"Show tracked background shell sessions and their status above the editor.",
		),
	];
}
