// Card presentation and terminal-text normalization adapted from pi-Serraly pi-ui.
// Copyright (c) 2026 Serali-Nerri. MIT; see CARD-LICENSE.md.
import { keyHint } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	stripTerminalSequences,
	Text,
	type TuiMouseEvent,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { CodeModeRenderContext, CodeModeRenderTheme } from "./types.js";

interface CardState {
	global: boolean;
	script?: boolean | undefined;
	output?: boolean | undefined;
	patches: Map<string, boolean>;
	invalidate?: (() => void) | undefined;
}

/** Per-row choices only. Never retain a frame/context/lastComponent here. */
export function cardState(
	context: CodeModeRenderContext | undefined,
	expanded = context?.expanded ?? false,
): CardState {
	const state = context?.state;
	const view = (state?.["codex-conversion.card"] ?? {
		global: expanded,
		patches: new Map(),
	}) as CardState;
	if (state) state["codex-conversion.card"] = view;
	if (view.global !== expanded) {
		view.global = expanded;
		view.script = undefined;
		view.output = undefined;
		view.patches.clear();
	}
	view.invalidate = context?.invalidate;
	return view;
}

export function toggleBody(view: CardState, field: "script" | "output"): () => void {
	return () => {
		view[field] = !(view[field] ?? view.global);
		view.invalidate?.();
	};
}

export function togglePatch(view: CardState, id: string): () => void {
	return () => {
		view.patches.set(id, !(view.patches.get(id) ?? view.global));
		view.invalidate?.();
	};
}

export function isCardClick(event: TuiMouseEvent): boolean {
	return (
		event.type === "click" && event.button === "left" && !event.shift && !event.alt && !event.ctrl
	);
}

/** A disposable current frame; handlers capture only per-row choices. */
export function cardSection(
	title: string | undefined,
	body: Component,
	open: boolean,
	theme: CodeModeRenderTheme,
	toggle: () => void,
	previewLines: number,
	notice?: string,
): Component {
	return {
		invalidate() {
			body.invalidate();
		},
		render(width: number): string[] {
			const header = title
				? new Text(theme.fg("toolTitle", theme.bold(title)), 0, 0).render(width)
				: [];
			const lines = body.render(width);
			const visible = open ? lines : lines.slice(0, previewLines);
			const hidden = lines.length - visible.length;
			const hiddenNotice =
				notice &&
				hidden > 0 &&
				!stripTerminalSequences(visible.join(""))
					.replace(/\s/g, "")
					.includes(notice.replace(/\s/g, ""));
			return [
				...header,
				...visible,
				...(hidden > 0
					? new Text(
							`${theme.fg("muted", `... (${hidden} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
							0,
							0,
						).render(width)
					: []),
				...(open && !title && lines.length > previewLines
					? new Text(theme.fg("muted", "... (click to collapse)"), 0, 0).render(width)
					: []),
				...(hiddenNotice ? new Text(theme.fg("warning", notice), 0, 0).render(width) : []),
			];
		},
		handleMouse(event) {
			if (!isCardClick(event)) return undefined;
			toggle();
			return { handled: true };
		},
	};
}

/** Program text is plain themed content, never terminal commands or panel colors. */
export function safeCardText(text: string): string {
	const plain = stripTerminalSequences(text)
		.replace(/\x9b[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x07\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
	if (!/[\r\b\t]/.test(plain)) return plain;
	const lines: string[] = [];
	let cells: string[] = [],
		cursor = 0;
	for (const char of plain) {
		if (char === "\r") {
			cursor = 0;
			continue;
		}
		if (char === "\b") {
			cursor = Math.max(0, cursor - 1);
			continue;
		}
		if (char === "\n") {
			lines.push(cells.join(""));
			cells = [];
			cursor = 0;
			continue;
		}
		const value = char === "\t" ? " ".repeat(4 - (cursor % 4)) : char;
		const width = visibleWidth(value);
		if (!width) {
			if (cursor) cells[cursor - 1] = (cells[cursor - 1] ?? "") + value;
			continue;
		}
		while (cells.length < cursor) cells.push(" ");
		// Overwriting either column of a wide glyph must not leave half a glyph.
		if (cells[cursor] === "" && cursor) cells[cursor - 1] = " ";
		if (cells[cursor + width] === "") cells[cursor + width] = " ";
		cells[cursor] = value;
		for (let col = 1; col < width; col++) cells[cursor + col] = "";
		cursor += width;
	}
	return [...lines, cells.join("")].join("\n");
}

export function describeCardInput(value: unknown): string {
	if (typeof value === "string") return safeCardText(value);
	try {
		return safeCardText(JSON.stringify(value) ?? "");
	} catch {
		return "[unavailable]";
	}
}
