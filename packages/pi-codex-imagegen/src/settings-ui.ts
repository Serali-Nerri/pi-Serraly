import {
	type ExtensionAPI,
	type ExtensionContext,
	getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import { type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import {
	API_MODEL_PRESETS,
	DEFAULT_API_BASE_URL,
	type ImagegenSettings,
	readImagegenSettings,
	supportsExtendedImageControls,
	validateImagegenSettings,
	writeImagegenSettings,
} from "./settings.js";

function items(settings: ImagegenSettings): SettingItem[] {
	const api = settings.api;
	const result: SettingItem[] = [
		{
			id: "access",
			label: "Access",
			currentValue: settings.access === "codex" ? "Codex OAuth" : "OpenAI API",
			values: ["Codex OAuth", "OpenAI API"],
			description:
				"Codex uses the current model’s provider if compatible, otherwise your Pi Codex login. API access uses the endpoint and credential provider below. No fallback between modes.",
		},
	];
	if (settings.access === "codex") return result;
	const field = (
		id: string,
		label: string,
		value: string | number,
		values: readonly string[],
		description?: string,
	): SettingItem => ({
		id,
		label,
		currentValue: String(value),
		values: [...values],
		...(description ? { description } : {}),
	});
	result.push(
		field(
			"baseUrl",
			"API base URL",
			api.baseUrl ?? DEFAULT_API_BASE_URL,
			["Edit…"],
			"Base before /images, including any /v1 prefix. Blank restores the official OpenAI endpoint.",
		),
		field(
			"provider",
			"Credential provider",
			api.provider ?? "openai",
			["Edit…"],
			"Pi provider ID whose API key is sent as a Bearer token. Its base URL is not used. Blank restores openai.",
		),
		field("model", "Model", api.model, ["Edit…"]),
		field("quality", "Quality", api.quality, [
			"auto",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]),
	);
	if (supportsExtendedImageControls(api.model))
		result.push(
			field(
				"complexity",
				"Complexity",
				api.complexity,
				["low", "medium", "high"],
				"Planning effort. High is the API default; lower values favour speed.",
			),
		);
	return result;
}

async function openSettings(
	ctx: ExtensionContext,
	refresh: () => void,
): Promise<void> {
	if (ctx.mode !== "tui") throw new Error("/imagegen requires Pi's TUI.");
	let settings = readImagegenSettings();
	let selected = "access";
	while (true) {
		const change = await ctx.ui.custom<
			{ id: string; value: string } | undefined
		>((tui, theme, _keys, done) => {
			const list = new SettingsList(
				items(settings),
				10,
				getSettingsListTheme(),
				(id, value) => done({ id, value }),
				() => done(undefined),
			);
			list.selectItem(selected);
			return {
				capturesViewportInput: list.capturesViewportInput,
				render: (width: number) => [
					theme.bold("Imagegen"),
					...list.render(width),
				],
				invalidate: () => list.invalidate(),
				handleMouse: (event) => list.handleMouse({ ...event, y: event.y - 1 }),
				handleInput: (data: string) => {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		});
		if (!change) return;
		const { id } = change;
		selected = id;
		let value: string | undefined = change.value;
		if (id === "model") {
			value = await ctx.ui.select("Image model", [
				...API_MODEL_PRESETS,
				"Custom…",
			]);
			if (value === "Custom…")
				value = await ctx.ui.input("Image model ID", settings.api.model);
		} else if (id === "baseUrl" || id === "provider") {
			value = await ctx.ui.input(
				id === "baseUrl"
					? "API base URL (blank restores OpenAI)"
					: "Credential provider (blank restores openai)",
				settings.api[id] ??
					(id === "baseUrl" ? DEFAULT_API_BASE_URL : "openai"),
			);
		}
		if (value === undefined) continue;
		value = value.trim();
		const next = structuredClone(settings);
		if (id === "access")
			next.access = value === "OpenAI API" ? "openai" : "codex";
		else if ((id === "baseUrl" || id === "provider") && value === "")
			delete next.api[id];
		else Object.assign(next.api, { [id]: value });
		try {
			validateImagegenSettings(next);
			writeImagegenSettings(next);
			settings = next;
			refresh();
		} catch (error) {
			ctx.ui.notify(
				error instanceof Error ? error.message : String(error),
				"error",
			);
		}
	}
}

export function registerImagegenSettings(
	pi: ExtensionAPI,
	refresh: () => void,
): void {
	pi.registerCommand("imagegen", {
		description: "Image generation access and defaults",
		handler: async (_args, ctx) => {
			try {
				await openSettings(ctx, refresh);
			} catch (error) {
				ctx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"error",
				);
			}
		},
	});
}
