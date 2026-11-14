import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface UiConfig {
	useSummaryTitlesAsThinkingTitle: boolean;
	previewLines: number;
	animationIntervalMs: number;
	stickyUserMessage: boolean;
	autoSessionName: boolean;
	sessionNameModel: { provider: string; id: string } | null;
}

const defaults: UiConfig = {
	useSummaryTitlesAsThinkingTitle: true,
	previewLines: 3,
	animationIntervalMs: 90,
	stickyUserMessage: true,
	autoSessionName: false,
	sessionNameModel: null,
};
const maxBytes = 64 * 1024;

function bounded(value: unknown, fallback: number, min: number, max: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
}

function normalize(value: Record<string, unknown>): UiConfig {
	const model = value["sessionNameModel"];
	let sessionNameModel: UiConfig["sessionNameModel"] = null;
	if (model !== undefined && model !== null) {
		if (typeof model !== "object" || Array.isArray(model)) throw new Error("Session naming model must contain provider and id");
		const { provider, id } = model as Record<string, unknown>;
		if (typeof provider !== "string" || !provider.trim() || typeof id !== "string" || !id.trim()) {
			throw new Error("Session naming model must contain provider and id");
		}
		sessionNameModel = { provider: provider.trim(), id: id.trim() };
	}
	return {
		useSummaryTitlesAsThinkingTitle: typeof value["useSummaryTitlesAsThinkingTitle"] === "boolean" ? value["useSummaryTitlesAsThinkingTitle"] : defaults.useSummaryTitlesAsThinkingTitle,
		previewLines: bounded(value["previewLines"], defaults.previewLines, 0, 20),
		animationIntervalMs: bounded(value["animationIntervalMs"], defaults.animationIntervalMs, 40, 1000),
		stickyUserMessage: typeof value["stickyUserMessage"] === "boolean" ? value["stickyUserMessage"] : defaults.stickyUserMessage,
		autoSessionName: typeof value["autoSessionName"] === "boolean" ? value["autoSessionName"] : defaults.autoSessionName,
		sessionNameModel,
	};
}

function read(path: string): Record<string, unknown> {
	let fd: number;
	try { fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
	try {
		if (!fstatSync(fd).isFile()) throw new Error("UI settings must be a regular file");
		const bytes = Buffer.allocUnsafe(maxBytes + 1);
		let count = 0;
		while (count < bytes.length) {
			const size = readSync(fd, bytes, count, bytes.length - count, null);
			if (size === 0) break;
			count += size;
		}
		if (count > maxBytes) throw new Error("UI settings exceed 64 KiB");
		const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, count)));
		if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("UI settings must be an object");
		return value as Record<string, unknown>;
	} finally { closeSync(fd); }
}

/** Reads are passive; only an explicit, successful atomic save changes memory. */
export function createUiConfig(path = join(getAgentDir(), "pi-ui.json")) {
	let current: UiConfig;
	try { current = normalize(read(path)); }
	catch { current = { ...defaults }; }
	return {
		get: (): UiConfig => ({ ...current, sessionNameModel: current.sessionNameModel ? { ...current.sessionNameModel } : null }),
		update(patch: Partial<UiConfig>): void {
			const stored = read(path); // Never overwrite a malformed or concurrently replaced file.
			const next = normalize({ ...stored, ...patch });
			const bytes = Buffer.from(`${JSON.stringify({ ...stored, ...next }, null, 2)}\n`);
			if (bytes.length > maxBytes) throw new Error("UI settings exceed 64 KiB");
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			const temporary = join(dirname(path), `${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
			try {
				writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
				renameSync(temporary, path);
			} catch (error) {
				try { unlinkSync(temporary); } catch { /* Already renamed or never created. */ }
				throw error;
			}
			current = next;
		},
	};
}
