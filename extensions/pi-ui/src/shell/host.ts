import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Capture public host identity and liveness while the context is still valid. */
export function captureShellHost(ctx: ExtensionContext) {
	const manager = ctx.sessionManager;
	const ui = ctx.ui;
	const getSessionId = manager.getSessionId?.bind(manager);
	const sessionId = getSessionId?.();
	// Pi 1.3.0's read-only isIdle() asserts runner activity. Ignore its result:
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
