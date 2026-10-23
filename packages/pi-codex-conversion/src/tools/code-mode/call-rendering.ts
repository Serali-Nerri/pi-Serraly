import { highlightCode } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import {
	cardSection,
	cardState,
	describeCardInput,
	safeCardText,
	toggleBody,
} from "./card-rendering.js";
import type { CodeModeRenderTracker } from "./render-tracker.js";
import type { CodeModeRenderContext, CodeModeRenderTheme } from "./types.js";

export function renderExecCall(
	args: { code?: unknown },
	theme: CodeModeRenderTheme,
	context: CodeModeRenderContext | undefined,
	tracker: CodeModeRenderTracker,
	richRendering = true,
	minimalOutput = false,
): Component {
	tracker.register(context?.toolCallId, context?.invalidate);
	const view = cardState(context);
	if (!richRendering) {
		if (!context?.executionStarted || !context.isPartial) return new Text("", 0, 0);
		const running = tracker.status(context.toolCallId) !== "yielded";
		return new Text(
			theme.fg("toolTitle", theme.bold(running ? "Running code" : "Started code")),
			0,
			0,
		);
	}
	const code = typeof args.code === "string" ? safeCardText(args.code).trimEnd() : "";
	return cardSection(
		"exec",
		new Text(highlightCode(code, "javascript").join("\n"), 0, 0),
		view.script ?? view.global,
		theme,
		toggleBody(view, "script"),
		minimalOutput ? 0 : 10,
	);
}

export function renderWaitCall(
	args: { cell_id?: unknown; terminate?: unknown },
	theme: CodeModeRenderTheme,
	context: CodeModeRenderContext | undefined,
	tracker: CodeModeRenderTracker,
	richRendering = true,
): Text {
	tracker.register(context?.toolCallId, context?.invalidate);
	cardState(context);
	if (!richRendering) return new Text("", 0, 0);
	return new Text(
		`${theme.fg("toolTitle", theme.bold("wait"))} ${theme.fg("muted", describeCardInput(args.cell_id))}`,
		0,
		0,
	);
}
