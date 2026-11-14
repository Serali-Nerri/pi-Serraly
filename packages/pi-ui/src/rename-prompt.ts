import { stripVTControlCharacters } from "node:util";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Input, truncateToWidth } from "@earendil-works/pi-tui";

export interface TitleSuggestion {
	title?: string;
	error?: string;
}

export function normalizeSessionName(text: string): string {
	return stripVTControlCharacters(text).replace(/[\p{Cc}\p{Cf}]/gu, (character) => character === "\u200c" || character === "\u200d" ? character : " ").replace(/\s+/gu, " ").trim();
}

export async function showRenamePrompt(
	ui: Pick<ExtensionUIContext, "custom">,
	initialName: string,
	suggestion: Promise<TitleSuggestion> | undefined,
	signal: AbortSignal,
): Promise<string | undefined> {
	if (signal.aborted) return undefined;
	return ui.custom<string | undefined>((tui, theme, keys, done) => {
		const input = new Input();
		input.setValue(initialName);
		let edited = false;
		let closed = false;
		let status = suggestion ? "Generating a title suggestion…" : "";
		const close = (name?: string): void => {
			if (closed) return;
			closed = true;
			done(name);
		};
		const abort = (): void => close();
		signal.addEventListener("abort", abort, { once: true });
		input.onSubmit = (value) => {
			const name = normalizeSessionName(value);
			if (name) close(name);
			else status = "Name cannot be empty.";
		};
		void suggestion?.then((result) => {
			if (closed || signal.aborted) return;
			if (result.title && !edited) {
				input.setValue(result.title);
				status = "Suggested from this conversation";
			} else status = result.error ?? "";
			tui.requestRender();
		});
		return {
			get focused() { return input.focused; },
			set focused(value: boolean) { input.focused = value; },
			render(width: number) {
				return [theme.fg("accent", theme.bold("Rename session")), "", ...input.render(width),
					...(status ? [theme.fg("muted", status)] : []), "", theme.fg("dim", "Enter to save · Esc to cancel")]
					.map((line) => truncateToWidth(line, width, ""));
			},
			invalidate() { input.invalidate(); },
			handleInput(data: string) {
				if (closed) return;
				if (keys.matches(data, "tui.select.cancel")) { close(); return; }
				const before = input.getValue();
				input.handleInput(data);
				if (input.getValue() !== before) { edited = true; status = ""; }
				if (!closed) tui.requestRender();
			},
			handleMouse(event) { return input.handleMouse({ ...event, y: event.y - 2 }); },
			dispose() { closed = true; signal.removeEventListener("abort", abort); },
		};
	}, { blocked: { kind: "question", message: "Rename session" } });
}
