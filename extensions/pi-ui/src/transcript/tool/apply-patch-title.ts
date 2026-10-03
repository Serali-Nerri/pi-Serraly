// Titles consume captured patch reports, never the current filesystem.
import { posix, win32 } from "node:path";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import type { ApplyPatchChange, ApplyPatchDetails } from "./apply-patch.ts";
import { displayPath, truncatePathToWidth } from "./names.ts";

export type PatchTitle =
	| { status: "Patch" | "Applying patch" | "Failed" | "Result unavailable" | "No changes" }
	| { action: "Add" | "Update" | "Delete" | "Move" | "Move + Update"; paths: string[] }
	| { changes: number; directories: string[] };

function resolvedPath(path: string, cwd?: string) {
	const api = posix.isAbsolute(path) ? posix
		: win32.isAbsolute(path) ? win32
		: cwd && win32.isAbsolute(cwd) && !posix.isAbsolute(cwd) ? win32 : posix;
	const absolute = api.isAbsolute(path) ? api.normalize(path)
		: cwd && api.isAbsolute(cwd) ? api.resolve(cwd, path) : api.normalize(path);
	return { api, absolute };
}

/** Lexical display only: no filesystem calls, including for paths outside cwd. */
export function patchDisplayPath(path: string, cwd?: string): string {
	return displayPath(resolvedPath(path, cwd).absolute, cwd);
}

function parentDirectory(path: string, cwd?: string): string {
	const { api, absolute } = resolvedPath(path, cwd);
	const parent = api.dirname(absolute);
	const sameAsCwd = cwd && api.isAbsolute(cwd) && api.relative(cwd, parent) === "";
	const shown = sameAsCwd ? "." : displayPath(parent, cwd);
	return shown.endsWith(api.sep) ? shown : shown + api.sep;
}

function movedContentChanged(change: ApplyPatchChange): boolean {
	if (change.contentChanged !== undefined) return change.contentChanged;
	// Older v1 reports only have a source->destination comparison for new
	// destinations. Overwrite views use other bases and cannot prove this.
	const view = change.views.find((view) => view.role === "move");
	if (!view || view.added === null || view.removed === null) return false;
	return view.added > 0 || view.removed > 0 || view.lineEndingsChanged ||
		view.before.bytes !== view.after.bytes || view.before.bom !== view.after.bom ||
		view.before.finalNewline !== view.after.finalNewline;
}

export function describePatchTitle(details: ApplyPatchDetails, cwd?: string): PatchTitle {
	if (details.changes.length === 0) {
		return { status: details.reportUnavailable ? "Result unavailable" : "No changes" };
	}
	if (details.changes.length === 1) {
		const change = details.changes[0]!;
		if (change.moveFrom) return {
			action: movedContentChanged(change) ? "Move + Update" : "Move",
			paths: [patchDisplayPath(change.moveFrom, cwd), patchDisplayPath(change.path, cwd)],
		};
		return {
			action: { add: "Add", update: "Update", delete: "Delete" }[change.kind] as "Add" | "Update" | "Delete",
			paths: [patchDisplayPath(change.path, cwd)],
		};
	}
	const directories = new Set<string>();
	for (const change of details.changes) {
		if (change.moveFrom) directories.add(parentDirectory(change.moveFrom, cwd));
		directories.add(parentDirectory(change.path, cwd));
	}
	return { changes: details.changes.length, directories: [...directories] };
}

function fitPath(path: string, width: number): string {
	if (visibleWidth(path) <= width) return path;
	const trailing = /[/\\]$/u.test(path) ? path.slice(-1) : "";
	return truncatePathToWidth(trailing ? path.slice(0, -1) : path, Math.max(0, width - trailing.length), "...") +
		(width > 0 ? trailing : "");
}

/** Share the available columns between endpoints, giving spare space to the longer path. */
export function fitPatchPaths(paths: string[], width: number, separator = " → "): string {
	if (!paths.length || width <= 0) return "";
	if (paths.length === 1) return fitPath(paths[0]!, width);
	const pathSpace = Math.max(0, width - visibleWidth(separator) * (paths.length - 1));
	const full = paths.map((path) => visibleWidth(path));
	const share = Math.floor(pathSpace / paths.length);
	const budgets = full.map((size) => Math.min(size, share));
	let remaining = pathSpace - budgets.reduce((sum, value) => sum + value, 0);
	for (let index = 0; index < budgets.length && remaining > 0; index++) {
		const extra = Math.min(full[index]! - budgets[index]!, remaining);
		budgets[index]! += extra;
		remaining -= extra;
	}
	return truncateToWidth(paths.map((path, index) => fitPath(path, budgets[index]!)).join(separator), width, "");
}

export function formatPatchTitle(title: PatchTitle, width: number): string {
	if ("status" in title) return truncateToWidth(title.status, Math.max(0, width), "...");
	if ("action" in title) {
		const prefix = `${title.action} · `;
		const available = Math.max(0, width - visibleWidth(prefix));
		// Don't leave a dangling separator or fractions of "..." when no
		// meaningful path fragment (or either move endpoint) can fit.
		if (available < (title.paths.length > 1 ? 11 : 4)) {
			return truncateToWidth(title.action, Math.max(0, width), "...");
		}
		return truncateToWidth(prefix + fitPatchPaths(title.paths, available), Math.max(0, width), "");
	}
	const count = `${title.changes} changes`;
	if (title.directories.length >= 3) {
		return truncateToWidth(`${count} · ${title.directories.length} directories`, Math.max(0, width), "...");
	}
	const suffix = ` · ${count}`;
	const available = Math.max(0, width - visibleWidth(suffix));
	// At widths too narrow even for directory initials, preserve the count.
	if (available < title.directories.length * 4) return truncateToWidth(count, Math.max(0, width), "...");
	return fitPatchPaths(title.directories, available, ", ") + suffix;
}
