import { type Component, Container, MouseRegion, Spacer, Text } from "@earendil-works/pi-tui";
import {
	cardSection,
	cardState,
	describeCardInput,
	isCardClick,
	safeCardText,
	toggleBody,
	togglePatch,
} from "./card-rendering.js";
import { imagesByMimeType, type RenderedToolContent } from "./render-content.js";
import type { CodeModeRenderTracker } from "./render-tracker.js";
import { formatNotebookMemoryWarning } from "./tool-result.js";
import { type CodeModeNestedRenderStore, renderTrace } from "./trace-rendering.js";
import type {
	CodeModeRenderContext,
	CodeModeRenderTheme,
	CodeModeToolDefinition,
	NotebookMemoryUsage,
	RuntimeToolTrace,
} from "./types.js";

interface CodeModeResultDetails {
	cellId?: string | undefined;
	status?: string | undefined;
	statusPrefix?: boolean | undefined;
	deliveryPending?: boolean | undefined;
	notification?: boolean | undefined;
	traces?: unknown;
	droppedTraceCount?: number | undefined;
	scriptError?: string | undefined;
	notebookMemory?: NotebookMemoryUsage | undefined;
	opaqueOutputs?: unknown[] | undefined;
	opaqueDeliveryId?: string | undefined;
	contextNotesSaved?: boolean | undefined;
}

export function renderTrackedCodeModeResult(
	result: { content: RenderedToolContent[]; details?: unknown },
	options: { expanded: boolean; isPartial: boolean },
	theme: CodeModeRenderTheme,
	context: CodeModeRenderContext | undefined,
	tracker: CodeModeRenderTracker,
	renderStore: CodeModeNestedRenderStore,
	tools: CodeModeToolDefinition[] = [],
	richRendering = true,
	minimalOutput = false,
): Component {
	const details = asDetails(result.details);
	if (!options.isPartial && context?.toolCallId) {
		tracker.finish(context.toolCallId, details.status === "yielded" ? "yielded" : "done");
	}
	const view = cardState(context, options.expanded);
	const box = new Container();
	const add = (text: string, tone = "muted") =>
		box.addChild(new Text(theme.fg(tone, safeCardText(text)), 0, 0));
	box.addChild(new Spacer(1));
	if (details.notification || details.status !== "result" || context?.isError) {
		const label = details.status ?? (details.notification ? "notification" : "result");
		add(
			`${label}${details.cellId ? ` · ${details.cellId}` : ""}`,
			context?.isError || details.scriptError ? "error" : options.isPartial ? "warning" : "muted",
		);
	}
	if (Array.isArray(details.opaqueOutputs) && details.opaqueOutputs.length) {
		const count = details.opaqueOutputs.length;
		add(
			`Protected output: ${count} item${count === 1 ? "" : "s"} · delivery ${details.opaqueDeliveryId ? "recorded" : "not recorded"}`,
		);
	} else if (details.opaqueDeliveryId) add("Protected output delivery recorded");
	if (details.deliveryPending) add("Cell complete; results pending delivery", "warning");
	if (typeof details.contextNotesSaved === "boolean")
		add(details.contextNotesSaved ? "Notes saved" : "Notes not saved");

	const traces = Array.isArray(details.traces) ? details.traces.filter(isTrace) : [];
	if (
		details.traces !== undefined &&
		(!Array.isArray(details.traces) || traces.length !== details.traces.length)
	) {
		add("Some call details are unavailable", "warning");
	}
	const patchIds = new Set(
		traces.filter((trace) => trace.name === "apply_patch").map((trace) => trace.id),
	);
	for (const id of view.patches.keys()) if (!patchIds.has(id)) view.patches.delete(id);
	const hidden = options.expanded
		? 0
		: Math.max(0, traces.filter((trace) => trace.name !== "apply_patch").length - 8);
	if (typeof details.droppedTraceCount === "number" && details.droppedTraceCount > 0) {
		add(`${details.droppedTraceCount} earlier calls omitted`, "warning");
	}
	if (hidden) add(`... (${hidden} earlier calls; expand to view)`);
	const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
	const emittedImages = imagesByMimeType(
		result.content.filter(
			(item): item is RenderedToolContent & { data: string; mimeType: string } =>
				item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string",
		),
	);
	let ordinary = 0;
	for (const trace of traces) {
		if (trace.name === "apply_patch") {
			const patch = new Container();
			const expanded = view.patches.get(trace.id) ?? view.global;
			for (const part of renderTrace(
				trace,
				toolsByName.get(trace.name),
				{ ...options, expanded },
				theme,
				context,
				emittedImages,
				renderStore,
			)) {
				patch.addChild(part);
			}
			box.addChild(new MouseRegion(patch, patchClick(togglePatch(view, trace.id))));
			continue;
		}
		if (ordinary++ < hidden) continue;
		box.addChild(renderCallRow(trace, options.expanded, theme));
	}

	// Older stored results carried a leading status block; new results say explicitly.
	const prefix = details.statusPrefix ?? (details.status !== undefined && !details.notification);
	const content = prefix ? result.content.slice(1) : result.content;
	const memory = validMemory(details.notebookMemory) ? details.notebookMemory : undefined;
	const memoryWarning = memory && formatNotebookMemoryWarning(memory);
	const outputItems =
		memoryWarning && content[0]?.type === "text" && content[0].text === memoryWarning
			? content.slice(1)
			: content;
	if (memoryWarning && memory)
		add(memoryWarning, memory.heapUsedBytes / memory.heapLimitBytes >= 0.9 ? "error" : "warning");
	const output = safeCardText(
		outputItems
			.filter((item) => item.type === "text" && typeof item.text === "string")
			.map((item) => item.text)
			.join("\n"),
	).trim();
	const truncated = output.includes("[Output truncated]");
	const important = Boolean(
		context?.isError || details.scriptError || details.notification || details.status === undefined,
	);
	if (output && (!options.isPartial || important) && (richRendering || important)) {
		box.addChild(new Spacer(1));
		box.addChild(
			cardSection(
				undefined,
				new Text(
					theme.fg(context?.isError || details.scriptError ? "error" : "toolOutput", output),
					0,
					0,
				),
				view.output ?? view.global,
				theme,
				toggleBody(view, "output"),
				important ? 5 : minimalOutput ? 0 : 5,
				truncated ? "[Output truncated]" : undefined,
			),
		);
	} else if (truncated) add("[Output truncated]", "warning");
	if (details.scriptError) add(`Script error: ${details.scriptError}`, "error");
	const duration = context?.durationMs;
	if (
		!options.isPartial &&
		typeof duration === "number" &&
		Number.isFinite(duration) &&
		duration >= 0
	) {
		box.addChild(new Spacer(1));
		add(`Took ${(duration / 1000).toFixed(1)}s`);
	}
	return box;
}

function patchClick(toggle: () => void): NonNullable<Component["handleMouse"]> {
	return (event) => {
		if (!isCardClick(event)) return undefined;
		toggle();
		return { handled: true };
	};
}

function renderCallRow(
	trace: RuntimeToolTrace,
	expanded: boolean,
	theme: CodeModeRenderTheme,
): Component {
	const row = new Container();
	const icon =
		trace.status === "done"
			? "✓"
			: trace.status === "error"
				? "✗"
				: trace.status === "blocked"
					? "!"
					: trace.status === "running"
						? "…"
						: "?";
	const input = describeCardInput(trace.input);
	const chars = [...(expanded ? input : input.replace(/\s+/g, " "))];
	const summary =
		!expanded && chars.length > 80 ? `${chars.slice(0, 77).join("")}...` : chars.join("");
	const details = trace.result?.details as { wall_time_seconds?: unknown } | undefined;
	const seconds = details?.wall_time_seconds;
	const duration =
		typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
			? ` ${seconds < 1 ? `${Math.round(seconds * 1000)}ms` : `${seconds.toFixed(1)}s`}`
			: "";
	row.addChild(
		new Text(
			`${theme.fg(trace.status === "error" ? "error" : trace.status === "done" ? "success" : "warning", icon)} ${theme.fg("toolTitle", safeCardText(trace.name))} ${theme.fg("muted", summary)}${theme.fg("dim", duration)}`,
			0,
			0,
		),
	);
	if (icon === "?")
		row.addChild(new Text(theme.fg("warning", `Status: ${safeCardText(trace.status)}`), 0, 0));
	if (expanded && typeof trace.error === "string")
		row.addChild(new Text(theme.fg("error", safeCardText(trace.error)), 0, 0));
	return row;
}

function asDetails(value: unknown): CodeModeResultDetails {
	return value && typeof value === "object" ? (value as CodeModeResultDetails) : {};
}

function isTrace(value: unknown): value is RuntimeToolTrace {
	if (!value || typeof value !== "object") return false;
	const trace = value as Partial<RuntimeToolTrace>;
	return (
		typeof trace.id === "string" &&
		typeof trace.name === "string" &&
		typeof trace.status === "string"
	);
}

function validMemory(value: NotebookMemoryUsage | undefined): value is NotebookMemoryUsage {
	return Boolean(
		value &&
		[
			value.heapUsedBytes,
			value.heapTotalBytes,
			value.heapLimitBytes,
			value.rssBytes,
			value.externalBytes,
		].every((number) => typeof number === "number" && Number.isFinite(number) && number >= 0),
	);
}
