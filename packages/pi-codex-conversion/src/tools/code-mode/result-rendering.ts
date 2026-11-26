import type { ToolDetailsMode } from "../../adapter/activation/config-contract.ts";
import { type Component, Container } from "@earendil-works/pi-tui";
import {
	clickToExpand,
	localExpansion,
	locallyExpanded,
} from "./local-expansion.js";
import {
	previewText,
	renderTextAndImages,
	type RenderedToolContent,
} from "./render-content.js";
import type { CodeModeRenderTracker } from "./render-tracker.js";
import type { NestedRenderState } from "./trace-render-state.js";
import {
	type CodeModeNestedRenderStore,
	renderTraceAndOutput,
} from "./trace-rendering.js";
import type {
	CodeModeRenderContext,
	CodeModeRenderTheme,
	CodeModeToolDefinition,
	RuntimeToolTrace,
} from "./types.js";

interface CodeModeResultDetails {
	cellId?: string | undefined;
	status?: "running" | "yielded" | "terminated" | "result" | undefined;
	statusPrefix?: boolean | undefined;
	nestedFailureSummary?: boolean | undefined;
	deliveryPending?: boolean | undefined;
	notification?: boolean | undefined;
	traces?: RuntimeToolTrace[] | undefined;
	droppedTraceCount?: number | undefined;
	scriptError?: string | undefined;
}

class CodeModeResult extends Container {
	// UI instances belong to this row, not the evictable capture store shared by history.
	readonly traces = new Map<string, NestedRenderState>();
}

export function renderTrackedCodeModeResult(
	result: { content: RenderedToolContent[]; details?: unknown },
	options: { expanded: boolean; isPartial: boolean },
	theme: CodeModeRenderTheme,
	context: CodeModeRenderContext | undefined,
	tracker: CodeModeRenderTracker,
	renderStore: CodeModeNestedRenderStore,
	tools: CodeModeToolDefinition[] = [],
	mode: ToolDetailsMode | boolean = "preview",
	legacyMinimalOutput = false,
): Component {
	const richRendering = typeof mode !== "boolean" || mode;
	const detailsMode: ToolDetailsMode =
		typeof mode === "boolean"
			? legacyMinimalOutput
				? "minimal"
				: "preview"
			: mode;
	const component =
		context?.lastComponent instanceof CodeModeResult
			? context.lastComponent
			: new CodeModeResult();
	const details = asDetails(result.details);
	if (!options.isPartial && context?.toolCallId) {
		tracker.finish(
			context.toolCallId,
			details.status === "yielded" ? "yielded" : "done",
		);
	}
	if (details.traces) {
		const retained = new Set(details.traces.map((trace) => trace.id));
		for (const id of component.traces.keys()) {
			if (!retained.has(id)) component.traces.delete(id);
		}
	}
	component.clear();
	component.addChild(
		renderCodeModeResult(
			result,
			options,
			theme,
			context,
			tools,
			renderStore,
			detailsMode,
			richRendering,
			component.traces,
		),
	);
	return component;
}

function renderCodeModeResult(
	result: { content: RenderedToolContent[]; details?: unknown },
	options: { expanded: boolean; isPartial: boolean },
	theme: CodeModeRenderTheme,
	context: CodeModeRenderContext | undefined,
	tools: CodeModeToolDefinition[],
	renderStore: CodeModeNestedRenderStore,
	mode: ToolDetailsMode,
	richRendering: boolean,
	traceStates: Map<string, NestedRenderState>,
): Component {
	const details = asDetails(result.details);
	const view = localExpansion(context, options.expanded);
	const expanded = locallyExpanded(view, "output");
	// Older results always carried a leading status block. Never strip user output from new results.
	const hasStatusPrefix =
		details.statusPrefix ??
		(details.status !== undefined && !details.notification);
	const content = hasStatusPrefix ? result.content.slice(1) : result.content;
	const textBlocks = content
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text ?? "");
	const nestedFailure = details.nestedFailureSummary
		? textBlocks[0]
		: undefined;
	const outputBlocks = details.nestedFailureSummary
		? textBlocks.slice(1)
		: textBlocks;
	const scriptErrorRenderedByTrace = Boolean(
		details.scriptError &&
		details.traces?.some(
			(trace) =>
				trace.status === "error" && trace.error === details.scriptError,
		),
	);
	const status = scriptErrorRenderedByTrace ? "" : statusText(details);
	const tone = context?.isError
		? "error"
		: details.status === "yielded"
			? "accent"
			: "dim";
	const images = content.filter(
		(item): item is RenderedToolContent & { data: string; mimeType: string } =>
			item.type === "image" &&
			typeof item.data === "string" &&
			typeof item.mimeType === "string",
	);
	const hidePreview =
		mode === "minimal" &&
		!expanded &&
		!context?.isError &&
		!details.scriptError &&
		!details.notification;
	const renderOutput = (visibleTraceText: ReadonlySet<string>) => {
		if (
			!richRendering &&
			!details.scriptError &&
			!nestedFailure &&
			!details.notification &&
			images.length === 0
		)
			return undefined;
		const text = outputBlocks
			.filter((block) => !visibleTraceText.has(block))
			.join("\n");
		const outputText = [text, status].filter(Boolean).join("\n");
		if (!nestedFailure && !outputText) return undefined;
		const renderedText = outputText ? theme.fg(tone, outputText) : "";
		const body = hidePreview
			? [
					previewText(text ? theme.fg(tone, text) : "", theme, true, context),
					status ? theme.fg(tone, status) : "",
				]
					.filter(Boolean)
					.join("\n")
			: expanded || options.isPartial
				? renderedText
				: previewText(renderedText, theme, false, context);
		const displayText = [
			nestedFailure ? theme.fg("error", nestedFailure) : "",
			body,
		]
			.filter(Boolean)
			.join("\n");
		if (!displayText) return undefined;
		return clickToExpand(
			renderTextAndImages(displayText, [], theme),
			view,
			"output",
		);
	};
	return renderTraceAndOutput(
		details.traces,
		details.droppedTraceCount ?? 0,
		tools,
		renderOutput,
		options,
		theme,
		context,
		images,
		renderStore,
		traceStates,
	);
}

function asDetails(value: unknown): CodeModeResultDetails {
	return value && typeof value === "object"
		? (value as CodeModeResultDetails)
		: {};
}

function statusText(details: CodeModeResultDetails): string {
	if (details.deliveryPending)
		return `Cell #${details.cellId} complete; results pending delivery`;
	if (details.scriptError) return `Script error: ${details.scriptError}`;
	if (details.status === "yielded" && details.cellId)
		return `Cell #${details.cellId} still running`;
	if (details.status === "terminated")
		return details.cellId
			? `Cell #${details.cellId} terminated`
			: "Cell terminated";
	return "";
}
