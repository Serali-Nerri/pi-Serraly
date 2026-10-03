import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type CompactStyleMode = "on" | "compact" | "off";
export interface Config {
	mode: CompactStyleMode;
	excludeRenderers: string[];
	writePreviewLines: number;
	editPreviewLines: number;
	fileExpandedMaxLines: number;
	useSummaryTitlesAsThinkingTitle: boolean;
	previewLines: number;
	animationIntervalMs: number;
	inputClip: number;
	expandedInputMaxLines: number;
	expandedOutputMaxLines: number;
	enableContextCommand: boolean;
}

export const DEFAULT_CONFIG: Config = {
	mode: "on",
	excludeRenderers: [],
	writePreviewLines: 10,
	editPreviewLines: 14,
	fileExpandedMaxLines: 80,
	useSummaryTitlesAsThinkingTitle: true,
	previewLines: 3,
	animationIntervalMs: 90,
	inputClip: 100,
	expandedInputMaxLines: 5,
	expandedOutputMaxLines: 10,
	enableContextCommand: true,
};

// Migration-only keys: never expose or execute them; remove them on explicit save.
const discardedKeys = ["dimThinkingText", "expandedPreviewMaxLines", "scrollStepLines"] as const;

const numericBounds: Partial<Record<keyof Config, [number, number]>> = {
	writePreviewLines: [0, 500], editPreviewLines: [1, 500], fileExpandedMaxLines: [1, 50_000],
	expandedInputMaxLines: [1, 5_000], expandedOutputMaxLines: [1, 5_000],
	inputClip: [8, 500], previewLines: [0, 100], animationIntervalMs: [40, 1_000],
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeConfig(input: unknown): Config {
	const source = isRecord(input) ? input : {};
	const result = { ...DEFAULT_CONFIG, excludeRenderers: [] } as Config;
	if (source.mode === "on" || source.mode === "compact" || source.mode === "off") result.mode = source.mode;
	if (Array.isArray(source.excludeRenderers)) {
		result.excludeRenderers = [...new Set(source.excludeRenderers.filter((name): name is string =>
			typeof name === "string" && /^[\w.:-]+$/.test(name)))];
	}
	for (const [key, bounds] of Object.entries(numericBounds)) {
		const value = source[key];
		if (typeof value === "number" && Number.isFinite(value)) {
			(result as unknown as Record<string, unknown>)[key] = Math.max(bounds[0], Math.min(bounds[1], Math.floor(value)));
		}
	}
	for (const key of ["useSummaryTitlesAsThinkingTitle", "enableContextCommand"] as const) {
		if (typeof source[key] === "boolean") result[key] = source[key];
	}
	return result;
}

export function configPath(): string {
	return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "claude-style-tools.json");
}

function loadConfig(): Config {
	try { return normalizeConfig(JSON.parse(readFileSync(configPath(), "utf8"))); }
	catch { return normalizeConfig(undefined); }
}

function readStoredConfig(path: string): Record<string, unknown> {
	let contents: string;
	try { contents = readFileSync(path, "utf8"); }
	catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw cause;
	}
	const stored: unknown = JSON.parse(contents);
	if (!isRecord(stored)) throw new Error("Style configuration must be a JSON object");
	return stored;
}

// Loading is read-only: migration happens only when the user explicitly saves.
export const config = loadConfig();

export function setConfig(next: Partial<Config>): void {
	Object.assign(config, normalizeConfig(next));
}

export function updateConfig(next: Partial<Config>): void {
	const normalized = normalizeConfig({ ...config, ...next });
	const path = configPath();
	// Re-read at save time so unrelated fields written since startup survive.
	const stored: Record<string, unknown> = { ...readStoredConfig(path), ...normalized };
	for (const key of discardedKeys) delete stored[key];
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		renameSync(temporary, path);
	} finally {
		try { unlinkSync(temporary); } catch { /* Already renamed, or never created. */ }
	}
	Object.assign(config, normalized);
}

export function getCompactThinkingConfig() {
	return {
		useSummaryTitlesAsThinkingTitle: config.useSummaryTitlesAsThinkingTitle,
		previewLines: config.previewLines,
		animationIntervalMs: config.animationIntervalMs,
	};
}

export function formatConfigStatus(): string {
	return (Object.keys(DEFAULT_CONFIG) as Array<keyof Config>).map((key) => {
		const value = config[key];
		return `${key}=${Array.isArray(value) ? value.join(",") || "none" : value}`;
	}).join(" · ");
}
