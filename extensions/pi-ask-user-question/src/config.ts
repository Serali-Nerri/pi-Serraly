/**
 * User configuration for pi-ask-user-question.
 *
 * One optional JSON file lives next to Pi's agent-directory settings:
 * `<agent-dir>/ask-user-question.json`. The module owns the field policy;
 * `pi-config-core` owns the bounded read. A missing, unreadable or malformed
 * file falls back to the defaults instead of failing the tool.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFileBoundedSync } from "pi-config-core";

export const CONFIG_FILE_NAME = "ask-user-question.json";
/** The stored configuration must stay readable by the same bound on the next start. */
const CONFIG_MAX_BYTES = 64 * 1024;

/** Key spec for the overlay collapse/expand shortcut, e.g. `"ctrl+]"` or `"alt+o"`. */
export type CollapseKeySpec = string;

export const DEFAULT_COLLAPSE_KEY: CollapseKeySpec = "ctrl+]";
export const COLLAPSE_KEY_OFF: CollapseKeySpec = "off";

/** Resolved configuration: every field carries its documented value. */
export interface ResolvedConfig {
	collapseKey: CollapseKeySpec;
	/** Non-empty override for the model-facing tool description. */
	description?: string;
}

export const DEFAULT_CONFIG: ResolvedConfig = { collapseKey: DEFAULT_COLLAPSE_KEY };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function defaultAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function resolveConfigPath(agentDir = defaultAgentDir()): string {
	return join(agentDir, CONFIG_FILE_NAME);
}

// Named keys accepted by pi-tui's `matchesKey` (keys.js switch on the parsed base key).
// parseKeyId lowercases the id before matching, so lowercase spellings are canonical.
const SPECIAL_KEYS = new Set([
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageup",
	"pagedown",
	"up",
	"down",
	"left",
	"right",
	...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

function isValidCollapseKeySpec(spec: string): boolean {
	// Mirror pi-tui's KeyId grammar strictly: zero or more distinct modifiers, then a
	// base key that is a single printable character or a named special key. A loose
	// check is not enough — pi-tui's `parseKeyId` takes the LAST `+`-part as the key
	// and ignores unknown parts, so a typo like `ctr+]` would silently match every
	// bare `]` keypress (and the raw terminal listener would consume them globally).
	if (!spec) return false;
	if (spec.startsWith("+") || spec.endsWith("+") || spec.includes("++")) return false;
	const parts = spec.split("+");
	const base = parts[parts.length - 1] ?? "";
	const modifiers = parts.slice(0, -1);
	if (modifiers.length !== new Set(modifiers).size) return false;
	if (!modifiers.every((m) => MODIFIERS.has(m))) return false;
	return base.length === 1 ? /[a-z0-9_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]/.test(base) : SPECIAL_KEYS.has(base);
}

/**
 * Resolve the configured collapse key. Non-strings, empty values and specs that
 * do not match the pi-tui grammar fall back to the default; `"off"` disables the
 * shortcut. Never throws, so a wrong JSON type cannot break the questionnaire.
 */
export function resolveCollapseKey(value: unknown): CollapseKeySpec {
	const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
	if (raw === "") return DEFAULT_COLLAPSE_KEY;
	if (raw === COLLAPSE_KEY_OFF) return COLLAPSE_KEY_OFF;
	return isValidCollapseKeySpec(raw) ? raw : DEFAULT_COLLAPSE_KEY;
}

// The only compound-word names in SPECIAL_KEYS — first-letter capitalization
// alone would render them "Pageup"/"Pagedown".
const COMPOUND_KEY_DISPLAY: Record<string, string> = {
	pageup: "PageUp",
	pagedown: "PageDown",
};

/**
 * Pretty-print a resolved key spec for UI copy: each `+`-part gets its first
 * character uppercased (`"ctrl+]"` → `"Ctrl+]"`, `"alt+o"` → `"Alt+O"`,
 * `"f9"` → `"F9"`, `"ctrl+pagedown"` → `"Ctrl+PageDown"`). Display-only — key
 * matching always uses the raw lowercase spec (`matchesKey` lowercases ids),
 * so never feed the result back into it.
 */
export function formatKeySpecForDisplay(spec: CollapseKeySpec): string {
	return spec
		.split("+")
		.map(
			(part) =>
				COMPOUND_KEY_DISPLAY[part] ??
				(part.length <= 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)),
		)
		.join("+");
}

/** Read and normalize the optional config file; every failure means defaults. */
export function loadConfig(path = resolveConfigPath()): ResolvedConfig {
	let value: unknown;
	try {
		const read = readJsonFileBoundedSync(path, CONFIG_MAX_BYTES);
		value = read.source === "file" ? read.value : undefined;
	} catch (error) {
		const cause = error instanceof Error ? error.message : String(error);
		console.warn(`pi-ask-user-question: ignoring unusable config at ${path}: ${cause}`);
		value = undefined;
	}
	const source = isRecord(value) ? value : {};
	const guidance = isRecord(source.guidance) ? source.guidance : {};
	const description = guidance.description;
	return {
		collapseKey: resolveCollapseKey(source.collapseKey),
		...(typeof description === "string" && description.length > 0 ? { description } : {}),
	};
}
