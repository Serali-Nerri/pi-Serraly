// Local expansion adapted from pi-Serraly pi-ui.
// Copyright (c) 2026 Serali-Nerri. MIT; see CARD-LICENSE.md.
import { type Component, MouseRegion } from "@earendil-works/pi-tui";
import type { CodeModeRenderContext } from "./types.js";

interface LocalExpansion {
	global: boolean;
	choices: Map<string, boolean>;
	invalidate?: (() => void) | undefined;
}

/** Store only choices and the latest invalidation callback, never a render frame. */
export function localExpansion(
	context: CodeModeRenderContext | undefined,
	expanded = context?.expanded ?? false,
): LocalExpansion {
	const state = context?.state;
	const view = (state?.["codex-conversion.expansion"] ?? {
		global: expanded,
		choices: new Map(),
	}) as LocalExpansion;
	if (state) state["codex-conversion.expansion"] = view;
	if (view.global !== expanded) {
		view.global = expanded;
		view.choices.clear();
	}
	view.invalidate = context?.invalidate;
	return view;
}

export function locallyExpanded(view: LocalExpansion, region: string): boolean {
	return view.choices.get(region) ?? view.global;
}

export function clickToExpand(child: Component, view: LocalExpansion, region: string): Component {
	return new MouseRegion(child, (event) => {
		if (event.type !== "click" || event.button !== "left" || event.shift || event.alt || event.ctrl)
			return undefined;
		view.choices.set(region, !locallyExpanded(view, region));
		view.invalidate?.();
		return { handled: true };
	});
}
