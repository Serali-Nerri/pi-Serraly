/** Private tool diagnostics: host state at view open, never request evidence inferred from inventory. */
import type { ExtensionCommandContext, Theme, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, wrapTextWithAnsi, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { normalizeInlineText, normalizePreviewText } from "../text.ts";
import type { ToolObservation } from "../tool-observation.ts";
import { ListNavigator, PreviewScroller } from "./injections-model.ts";
import {
	DEFAULT_TERMINAL_ROWS, fitLine, fitToTerminalHeight, hintRow, isPageBackKey, isPageForwardKey,
	isStepBackKey, isStepForwardKey, normalizeTerminalRows,
} from "./layout.ts";
import { DEFAULT_WHEEL_SCROLL_LINES, parseWheelDirection } from "./wheel.ts";

interface ToolsViewInput {
	readonly tools: readonly ToolInfo[];
	readonly active: readonly string[];
	readonly sampledAt: string;
	readonly observation?: ToolObservation;
}
interface ToolRow { readonly label: string; readonly text: string; }
type Destination = "usage" | "injections" | undefined;

export async function showToolsView(context: ExtensionCommandContext, input: ToolsViewInput): Promise<Destination> {
	return context.ui.custom<Destination>((tui, theme, _keys, done) => {
		const view = new ToolsView(theme, input, done, () => tui.terminal.rows);
		return {
			render: (width: number) => view.render(width), invalidate: () => view.invalidate(),
			handleMouse: (event: TuiMouseEvent) => view.handleMouse(event),
			handleInput: (data: string) => { view.handleInput(data); tui.requestRender(); },
		};
	}, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 } });
}

/** Render/input boundary, following the retained viewer conventions. */
class ToolsView {
	private readonly rows: ToolRow[];
	private readonly navigator: ListNavigator;
	private readonly scroller = new PreviewScroller();
	private preview: ToolRow | undefined;
	private readonly theme: Theme;
	private readonly done: (result: Destination) => void;
	private readonly getTerminalRows: () => number;
	private readonly summary: string;
	private readonly observedAt: string | undefined;
	private readonly sampledAt: string;

	public constructor(
		theme: Theme,
		input: ToolsViewInput,
		done: (result: Destination) => void,
		getTerminalRows: () => number = () => process.stdout.rows ?? DEFAULT_TERMINAL_ROWS,
	) {
		this.theme = theme;
		this.done = done;
		this.getTerminalRows = getTerminalRows;
		this.summary = input.observation?.summary ?? "Not yet observed";
		this.observedAt = input.observation?.observedAt;
		this.sampledAt = input.sampledAt;
		this.rows = [{ label: "Observation details", text: [
			this.summary,
			input.observation ? `Observed at: ${input.observation.observedAt}` : "No tool declaration observation has occurred in this runtime.",
			`Host state sampled at view open: ${input.sampledAt}`,
			"Registered inventory is not request evidence.",
			"Stage: before_provider_request (this extension's handler).",
			"Request identity and purpose unknown; observations may include cache warming.",
			"Not final wire, proof of sending, or provider acceptance.",
			"Active is not internal callability or a request declaration. Differences are not automatically errors.",
			"No independent declaration does not mean a schema is invisible in all content.",
			"Internal callability is derived from exposure and active, not verified by execution.",
		].join("\n\n") }];
		for (const tool of input.tools) {
			const active = input.active.includes(tool.name);
			const callable = tool.exposure === "codemode" || tool.exposure === "deferred" || (tool.exposure === "direct" && active);
			const reason = {
				direct: active ? "Direct tools are internally callable while active." : "Inactive direct tools are not internally callable.",
				"model-only": "Model-only tools can have declarations while active, but are never internally callable.",
				codemode: "Registered codemode tools remain internally callable even while inactive.",
				deferred: "Registered deferred tools remain internally callable even before search activation.",
				hidden: "Hidden tools are registered but unreachable, not internally callable.",
			}[tool.exposure];
			this.rows.push({
				label: `Registered ${tool.name} · ${tool.exposure} · ${active ? "active" : "inactive"}`,
				text: [
					`Registered: ${tool.name}`, `Exposure: ${tool.exposure}`, `Active: ${active ? "active" : "inactive"}`,
					`Derived internal callability: ${callable ? "yes" : "no"} (exposure + active; not execution tested)`, reason,
					`Source: ${tool.sourceInfo.source} · ${tool.sourceInfo.path}`,
					`Scope: ${tool.sourceInfo.scope} · Origin: ${tool.sourceInfo.origin}`,
					`Host state sampled at view open: ${input.sampledAt}`,
					"This inventory is not an observed request declaration.", `Registered description:\n${tool.description}`,
				].join("\n\n"),
			});
		}
		for (const declaration of input.observation?.declarations ?? []) {
			this.rows.push({ label: `Observed ${declaration.name} · ${declaration.position}`, text: [
				`Observed definition: ${declaration.name}`, `Position: ${declaration.position}`,
				`Observed at: ${input.observation!.observedAt}`,
				"Stage: before_provider_request (this extension's handler). Not final wire or provider acceptance.",
				declaration.definition,
			].join("\n\n") });
		}
		this.navigator = new ListNavigator(this.rows.length, 1);
	}

	public invalidate(): void { /* Content is fixed at view open; wrapping is recomputed on render. */ }

	public handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const delta = event.wheelDelta;
		if (event.type !== "wheel" || delta === undefined || !Number.isFinite(delta) || delta === 0) return undefined;
		if (this.preview) this.scroller.scrollBy(Math.trunc(delta));
		else this.navigator.moveBy(delta < 0 ? -1 : 1);
		return { handled: true, render: true };
	}

	public handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			if (this.preview) { this.preview = undefined; this.scroller.reset(); }
			else this.done(undefined);
			return;
		}
		if (!this.preview && (data === "u" || data === "i")) { this.done(data === "u" ? "usage" : "injections"); return; }
		if (!this.preview && matchesKey(data, Key.enter)) { this.preview = this.rows[this.navigator.selected]; return; }
		const wheel = parseWheelDirection(data);
		const target = this.preview ? this.scroller : this.navigator;
		if (wheel !== undefined) {
			if (this.preview) this.scroller.scrollBy(wheel * DEFAULT_WHEEL_SCROLL_LINES);
			else this.navigator.moveBy(wheel);
		} else if (isStepBackKey(data) || isStepForwardKey(data)) {
			const delta = isStepBackKey(data) ? -1 : 1;
			if (this.preview) this.scroller.scrollBy(delta); else this.navigator.moveBy(delta);
		} else if (isPageBackKey(data) || isPageForwardKey(data)) {
			target.page(isPageBackKey(data) ? -1 : 1);
		} else if (matchesKey(data, Key.home) || matchesKey(data, Key.end)) {
			const index = matchesKey(data, Key.home) ? 0 : Number.MAX_SAFE_INTEGER;
			if (this.preview) this.scroller.scrollTo(index); else this.navigator.moveTo(index);
		}
	}

	public render(width: number): string[] {
		const height = normalizeTerminalRows(this.getTerminalRows());
		const border = this.theme.fg("border", "─".repeat(Math.max(1, width)));
		const lines = [border, "", fitLine(this.theme.fg("accent", normalizeInlineText(this.preview?.label ?? "Tool Diagnostics")), width), ""];
		const hints = wrapTextWithAnsi(hintRow(this.theme, this.preview
			? [["↑↓/PgUp/PgDn", "Scroll"], ["Esc", "Back"]]
			: [["↑↓", "Navigate"], ["Enter", "Preview"], ["u/i", "Usage/Initial"], ["Esc", "Close"]]).trimStart(), Math.max(1, width - 2))
			.map((line) => fitLine(`  ${line}`, width));
		const available = Math.max(1, height - (this.preview ? 10 : 12) - (hints.length - 1));
		if (this.preview) {
			const body = wrapTextWithAnsi(normalizePreviewText(this.preview.text), Math.max(1, width - 2));
			this.scroller.setExtent(body.length, available);
			lines.push(...body.slice(this.scroller.offset, this.scroller.offset + this.scroller.windowSize).map((line) => fitLine(`  ${line}`, width)));
			lines.push(fitLine(this.theme.fg("dim", `  Lines ${this.scroller.offset + 1}-${this.scroller.visibleEnd}/${body.length}`), width));
		} else {
			lines.push(fitLine(`  ${this.summary}`, width));
			lines.push(fitLine(`  Observed: ${this.observedAt ?? "not yet observed"}`, width));
			lines.push(fitLine(`  Host at view open: ${this.sampledAt}`, width));
			this.navigator.setVisibleCount(available - 1);
			for (let i = this.navigator.offset; i < this.navigator.visibleEnd; i++) {
				const text = `${i === this.navigator.selected ? "›" : " "} ${normalizeInlineText(this.rows[i]!.label)}`;
				lines.push(fitLine(this.theme.fg(i === this.navigator.selected ? "accent" : "text", text), width));
			}
			lines.push(fitLine(this.theme.fg("dim", `  Rows ${this.navigator.offset + 1}-${this.navigator.visibleEnd}/${this.rows.length}`), width));
		}
		lines.push("", ...hints, "", border);
		return fitToTerminalHeight(lines, height, border);
	}
}
