import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

export const DEFAULT_API_BASE_URL = "https://api.openai.com/v1";
export const API_MODEL_PRESETS = [
	"gpt-image-2.6-flare",
	"gpt-image-2.6-sunburst",
] as const;

export function supportsExtendedImageControls(model: string): boolean {
	return API_MODEL_PRESETS.some((preset) => preset === model);
}

const settingsSchema = Type.Object(
	{
		access: Type.Enum(["codex", "openai"]),
		api: Type.Object(
			{
				baseUrl: Type.Optional(Type.String({ minLength: 1 })),
				provider: Type.Optional(Type.String({ pattern: "^\\S+$" })),
				model: Type.String({ pattern: "^\\S+$" }),
				quality: Type.Enum(["auto", "low", "medium", "high", "xhigh", "max"]),
				complexity: Type.Enum(["low", "medium", "high"]),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
export type ImagegenSettings = Static<typeof settingsSchema>;

function defaultImagegenSettings(): ImagegenSettings {
	return {
		access: "codex",
		api: { model: "gpt-image-2.6-flare", quality: "auto", complexity: "high" },
	};
}

export function validateImagegenSettings(
	value: unknown,
): asserts value is ImagegenSettings {
	if (!Check(settingsSchema, value))
		throw new Error(
			"Invalid imagegen.json. Correct or remove it in Pi's agent directory, then reopen /imagegen.",
		);
	if (value.api.baseUrl !== undefined) {
		const url = URL.parse(value.api.baseUrl);
		if (
			!url ||
			!["http:", "https:"].includes(url.protocol) ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		)
			throw new Error(
				"API base URL must be HTTP(S), without credentials, query or fragment. Enter the base before /images in /imagegen.",
			);
	}
}

function settingsPath(): string {
	return join(getAgentDir(), "imagegen.json");
}

export function readImagegenSettings(): ImagegenSettings {
	let text: string;
	try {
		text = readFileSync(settingsPath(), "utf8");
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ENOENT"
		)
			return defaultImagegenSettings();
		throw error;
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error(
			"Could not read imagegen.json. Correct or remove it, then reopen /imagegen.",
		);
	}
	validateImagegenSettings(value);
	return value;
}

export function writeImagegenSettings(settings: ImagegenSettings): void {
	mkdirSync(getAgentDir(), { recursive: true });
	writeFileSync(settingsPath(), JSON.stringify(settings, null, 2) + "\n", {
		mode: 0o600,
	});
}
