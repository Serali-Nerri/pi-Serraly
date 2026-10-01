import { VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatCwd, formatModelLabel, sanitizeStatus } from "./utils.ts";

// Startup layout and settled logo from pi-open-tui 0.3.3 (MIT); see UPSTREAM.md.
const LOGO = [
	"            ",
	"            ",
	"█████████   ",
	"███   ███   ",
	"██████   ███",
	"███      ███",
	"            ",
];

// pi.getCommands() supplies extensions, prompts, and skills; built-ins are separate.
const BUILTIN_COMMANDS = [
	"settings", "model", "thinking", "scoped-models", "export", "import", "share", "copy",
	"name", "session", "changelog", "hotkeys", "fork", "clone", "tree", "trust",
	"login", "logout", "new", "compact", "resume", "reload", "quit",
];

function pickCommandTips(pi: ExtensionAPI): string[] {
	const names = [...BUILTIN_COMMANDS, ...pi.getCommands().map((command) => command.name)];
	const pool = [...new Set(names.map((name) => sanitizeStatus(name).replace(/^\//, "")))]
		.filter(Boolean);
	for (let i = pool.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[pool[i], pool[j]] = [pool[j], pool[i]];
	}
	return pool.slice(0, 4).map((name) => `/${name}`);
}

function padRight(text: string, width: number, ellipsis = ""): string {
	const clipped = truncateToWidth(text, width, ellipsis);
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function center(text: string, width: number): string {
	const textWidth = visibleWidth(text);
	if (textWidth >= width) return truncateToWidth(text, width, "...");
	return " ".repeat(Math.floor((width - textWidth) / 2)) + text;
}

function columnWidths(innerWidth: number): { left: number; right: number } {
	const minLeft = 28;
	const minRight = 16;
	const gap = 3;
	if (innerWidth < minLeft + gap + minRight) return { left: innerWidth, right: 0 };
	const right = Math.min(28, Math.max(minRight, Math.round(innerWidth * 0.28)), innerWidth - gap - minLeft);
	return { left: innerWidth - gap - right, right };
}

export class StartupHeader implements Component {
	private readonly tipCommands: string[];

	constructor(private readonly pi: ExtensionAPI, private readonly ctx: ExtensionContext) {
		this.tipCommands = pickCommandTips(pi);
	}

	render(width: number): string[] {
		if (width <= 0) return [""];
		const theme = this.ctx.ui.theme;
		const paint = (text: string) => theme.fg("accent", text);
		const muted = (text: string) => theme.fg("muted", text);
		const title = `${paint("Pi")} v${VERSION}`;
		if (width < 24) return [truncateToWidth(paint(`Pi v${VERSION}`), width, "")];

		const { left, right } = columnWidths(width - 2);
		const model = sanitizeStatus(formatModelLabel(this.ctx.model));
		const level = this.pi.getThinkingLevel();
		const effort = level === "off" ? "thinking off" : `${level} effort`;
		const leftLines = [
			...LOGO.map((line) => center(paint(line), left)),
			center(theme.bold("Let's build something great"), left),
			center(muted(`${model} · ${effort}`), left),
			center(theme.fg("dim", sanitizeStatus(formatCwd(this.ctx.cwd))), left),
		];
		const tipLines = [
			"",
			paint(theme.bold("Welcome")),
			muted("Ask Pi anything"),
			paint("─".repeat(Math.max(8, Math.min(right, 22)))),
			paint(theme.bold("Commands")),
			...this.tipCommands.map(muted),
			"",
		];

		const titlePrefix = "╭─── ";
		const titleSuffix = " ─────";
		const fill = Math.max(0, width - visibleWidth(titlePrefix + title + titleSuffix) - 1);
		const lines = [paint(titlePrefix) + title + paint(titleSuffix + "─".repeat(fill) + "╮")];
		for (let i = 0; i < leftLines.length; i++) {
			const content = right > 0
				? `${padRight(leftLines[i], left)} ${paint("│")} ${padRight(tipLines[i], right, "…")}`
				: padRight(leftLines[i], left);
			lines.push(paint("│") + content + paint("│"));
		}
		lines.push(paint("╰" + "─".repeat(width - 2) + "╯"));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	invalidate(): void {}
}

/** Capture public host identity and liveness while the context is still valid. */
export function captureShellHost(ctx: ExtensionContext) {
	const manager = ctx.sessionManager;
	const ui = ctx.ui;
	const getSessionId = manager.getSessionId?.bind(manager);
	const sessionId = getSessionId?.();
	// Pi 0.99.2's read-only isIdle() asserts runner activity. Ignore its result:
	// a busy session still owns its shell. Binding avoids stale context getters.
	const isIdle = ctx.isIdle?.bind(ctx);
	return {
		manager, ui, sessionId,
		isCurrentSession(): boolean {
			try {
				isIdle?.();
				return getSessionId?.() === sessionId;
			} catch { return false; }
		},
	};
}

const headerOwners = new WeakMap<ExtensionContext["ui"], symbol>();

export function installHeader(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	isCurrent: () => boolean = () => true,
): (clearHost?: boolean) => void {
	const owner = Symbol("shell-header");
	const host = captureShellHost(ctx);
	const { ui } = host;
	let installed = true;
	let hostOwnsHeader = true;
	let latestComponent: symbol | undefined;
	const current = () => installed && isCurrent() && headerOwners.get(ui) === owner
		&& host.isCurrentSession();
	headerOwners.set(ui, owner);
	const factory = () => {
		if (!current()) return { invalidate() {}, render: () => [] };
		const component = Symbol("shell-header-component");
		latestComponent = component;
		hostOwnsHeader = true;
		let disposed = false;
		const header = new StartupHeader(pi, ctx);
		return {
			invalidate: () => header.invalidate(),
			render: (width: number) => !disposed && current() ? header.render(width) : [],
			dispose: () => {
				disposed = true;
				if (latestComponent === component) hostOwnsHeader = false;
			},
		};
	};
	const cleanup = (clearHost = true) => {
		if (!installed) return;
		installed = false;
		if (headerOwners.get(ui) !== owner) return;
		headerOwners.delete(ui);
		if (clearHost && hostOwnsHeader && host.isCurrentSession()) ui.setHeader(undefined);
	};
	try { ui.setHeader(factory); }
	catch (error) { cleanup(false); throw error; }
	return cleanup;
}
