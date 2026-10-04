import { createBashToolDefinition, createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition,
	initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, TuiAltScreen, type Component } from "@earendil-works/pi-tui";
import { theme } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import extension from "../src/index.ts";
import { setConfig } from "../src/config/config.ts";

initTheme("dark", false);
export { theme };
export const strip = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b[_\]][\s\S]*?(?:\x07|\x1b\\)/g, "");

export type HarnessOptions = {
	mode?: "on" | "compact" | "off";
	headless?: boolean;
	/** Runs after the extension factory and before `session_start`; host mutations and spies belong here. */
	beforeStart?: () => void;
};

export async function harness(options: HarnessOptions = {}) {
	setConfig({ mode: options.mode ?? "on" });
	const events = new Map<string, Function[]>();
	const commands = new Map<string, any>();
	const entries: any[] = [];
	const registered: any[] = [];
	const mutations: string[] = [];
	const widgets = new Map<string, Component>();
	const root = new Container();
	const output: string[] = [];
	/** Every `ui.notify` call, including the ones emitted during session_start. */
	const notices: Array<{ message: string; level: string | undefined }> = [];
	const terminal = { columns: 100, rows: 36, write: (s: string) => output.push(s),
		start() {}, stop() {}, hideCursor() {}, showCursor() {}, moveBy() {}, clearLine() {}, clearFromCursor() {},
		setTitle() {}, drainInput: async () => {}, };
	const tui = new TuiAltScreen(terminal as any) as any;
	tui.requestRender = () => {};
	tui.addChild(root);
	tui.stopped = false; tui.altScreenActive = true;
	let overlay: Component | undefined;
	let header: Component | undefined;
	let footer: (Component & { dispose?(): void }) | undefined;
	const definitions: Record<string, any> = {
		bash: createBashToolDefinition(process.cwd()), read: createReadToolDefinition(process.cwd()),
		write: createWriteToolDefinition(process.cwd()), edit: createEditToolDefinition(process.cwd()),
	};
	const toolMetadata = new Map(Object.entries(definitions).map(([name, definition]) => [name, {
		name, description: definition.description, parameters: definition.parameters, exposure: "direct",
		sourceInfo: { path: `builtin:${name}`, source: "builtin", scope: "temporary", origin: "top-level" },
	}]));
	const ctx: any = {
		mode: options.headless ? "print" : "tui", hasUI: !options.headless, cwd: process.cwd(),
		sessionManager: {
			getCwd: () => process.cwd(), getSessionName: () => undefined, getSessionId: () => "fixture",
			getBranch: () => [], getEntries: () => entries,
			buildSessionProjection: () => ({ entries: [], messages: [], thinkingLevel: "off", model: null }),
		},
		getContextUsage: () => undefined,
		ui: {
			theme, getToolsExpanded: () => false, getThinkingVisible: () => false,
			notify(message: string, level?: string) { notices.push({ message, level }); }, requestRender() {},
			setWidget(id: string, factory: any) {
				if (!factory) widgets.delete(id); else widgets.set(id, factory(tui, theme));
			},
			setHeader(factory: any) { header = factory?.(tui, theme); },
			setFooter(factory: any) {
				footer?.dispose?.();
				footer = factory?.(tui, theme, {
					onBranchChange: () => () => {},
					getExtensionStatuses: () => new Map(), getGitBranch: () => undefined,
				});
			},
			custom(factory: any) {
				return new Promise((done) => { overlay = factory(tui, theme, {}, (value: any) => { overlay = undefined; done(value); }); });
			},
		},
	};
	const pi: any = {
		on(event: string, handler: Function) { events.set(event, [...events.get(event) ?? [], handler]); },
		registerTool(tool: any) { registered.push(tool); },
		registerCommand(name: string, command: any) { commands.set(name, command); },
		registerMarkdownTransformer() {},
		appendEntry(customType: string, data: any) { entries.push({ type: "custom", customType, data }); },
		setActiveTools() { mutations.push("activeTools"); },
		getAllTools: () => [...toolMetadata.values()],
		getCommands: () => [...commands.keys()].map((name) => ({ name })),
		getThinkingLevel: () => "off",
		getSettings: () => ({}),
	};
	extension(pi);
	const emit = async (name: string, event: any = {}, context = ctx) => {
		for (const handler of events.get(name) ?? []) await handler(event, context);
	};
	options.beforeStart?.();
	await emit("session_start");
	const tool = (name: string, id: string, args: any, result?: any, definition = definitions[name]) => {
		if (definition !== definitions[name] || !toolMetadata.has(name)) {
			toolMetadata.set(name, {
				name, description: definition?.description ?? "", parameters: definition?.parameters, exposure: "direct",
				sourceInfo: { path: "fixture-extension.ts", source: "local", scope: "temporary", origin: "top-level" },
			});
		}
		const component = new ToolExecutionComponent(name, id, args, { showImages: false }, definition, tui, process.cwd()) as any;
		component.markExecutionStarted();
		if (result) component.updateResult(result);
		root.addChild(component);
		return component;
	};
	const render = () => {
		for (const widget of widgets.values()) widget.render(terminal.columns);
		tui.doRender();
		return (tui.previousScreen as string[]).map(strip);
	};
	const pointer = (x: number, y: number, type: "press" | "release" | "move" | "drag" = "press") => {
		const button = type === "move" ? 35 : type === "drag" ? 32 : 0;
		return tui.handleViewportInput(`\x1b[<${button};${x + 1};${y + 1}${type === "release" ? "m" : "M"}`);
	};
	const click = (x: number, y: number) => { pointer(x, y); pointer(x, y, "release"); };
	const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
	return { pi, ctx, tui, root, widgets, commands, entries, registered, mutations, definitions, events, terminal, notices, toolMetadata,
		tool, emit, render, pointer, click, flush, get overlay() { return overlay; },
		get header() { return header; }, get footer() { return footer; },
		async close() { await emit("session_shutdown"); tui.stopSelectionAutoScroll(); tui.stopScrollbarHover(); tui.stopScrollbarDrag(); },
	};
}
