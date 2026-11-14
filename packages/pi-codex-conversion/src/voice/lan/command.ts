import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CodexLanVoiceServerController } from "./controller.ts";
import {
	isVoiceRequestId,
	writeLanReceipt,
	type LanReceipt,
} from "./receipt.ts";

const USAGE = "Usage: /codex voice server ensure|status [UUIDv4]";

export async function runLanVoiceCommand(
	args: string,
	ctx: ExtensionCommandContext,
	lanVoice: CodexLanVoiceServerController,
	agentDir: string,
): Promise<void> {
	const [action, requestId, ...extra] = args.trim().split(/\s+/);
	if (action !== "ensure" && action !== "status") {
		ctx.ui.notify(USAGE, "warning");
		return;
	}
	const sessionId = ctx.sessionManager.getSessionId();
	let failure: string | undefined;
	try {
		if (requestId && !isVoiceRequestId(requestId))
			throw new Error("Use a UUID v4 request ID");
		if (extra.length) throw new Error(USAGE);
		if (action === "ensure") {
			if (ctx.mode !== "tui")
				throw new Error("LAN voice server requires interactive TUI mode");
			await lanVoice.setEnabled(true, ctx);
		}
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	const state = lanVoice.status();
	const receipt: LanReceipt = {
		version: 1,
		requestId: requestId ?? "",
		action,
		sessionId,
		terminalId: process.env["HC_TERMINAL_ID"] ?? null,
		provider: "codex",
		status: failure ? "error" : state.running ? "running" : "stopped",
		...state,
		...(failure ? { error: failure } : {}),
	};
	if (requestId && isVoiceRequestId(requestId)) {
		try {
			await writeLanReceipt(agentDir, receipt);
		} catch (error) {
			ctx.ui.notify(
				`Voice receipt could not be written: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
		return;
	}
	ctx.ui.notify(
		receipt.error ??
			(receipt.running
				? `LAN voice is running:\n${receipt.urls.join("\n")}`
				: "LAN voice server is stopped"),
		receipt.error ? "error" : "info",
	);
}
