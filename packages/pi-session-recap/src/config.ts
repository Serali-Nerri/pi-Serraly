import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface RecapConfig {
	auto: boolean;
	idleMinutes: number;
	minTurns: number;
	minTurnsBetweenRecaps: number;
	recapModel: string | null;
}

export const DEFAULT_CONFIG: Readonly<RecapConfig> = {
	auto: true,
	idleMinutes: 30,
	minTurns: 3,
	minTurnsBetweenRecaps: 2,
	recapModel: null,
};

export function loadConfig(path: string): { config: RecapConfig; warning: boolean } {
	const config = { ...DEFAULT_CONFIG };
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
			return { config, warning: true };
		try {
			mkdirSync(dirname(path), { recursive: true });
		} catch {
			return { config, warning: true };
		}
		try {
			writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });
			return { config, warning: false };
		} catch (error) {
			// Another Pi may have created the same defaults after our missing-file read.
			return { config, warning: !(error instanceof Error && "code" in error && error.code === "EEXIST") };
		}
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		return { config, warning: true };
	const fields = value as Record<string, unknown>;
	let warning = false;
	if (fields["auto"] !== undefined) {
		if (typeof fields["auto"] === "boolean") config.auto = fields["auto"];
		else warning = true;
	}
	for (const key of ["idleMinutes", "minTurns", "minTurnsBetweenRecaps"] as const) {
		const field = fields[key];
		if (field === undefined) continue;
		if (typeof field === "number" && Number.isFinite(field) && field > 0
			&& (key === "idleMinutes" || Number.isInteger(field))) config[key] = field;
		else warning = true;
	}
	const model = fields["recapModel"];
	if (model !== undefined && model !== null) {
		if (typeof model === "string" && /^[^/\s]+\/\S+$/.test(model)) config.recapModel = model;
		else warning = true;
	}
	return { config, warning };
}
