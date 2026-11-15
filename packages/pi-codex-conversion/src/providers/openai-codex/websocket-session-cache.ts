import { createHash } from "node:crypto";
import type { AcquiredWebSocket, CodexDiagnosticsSink, ProviderEnv, SessionWebSocketCacheEntry, WebSocketLike } from "./types.ts";
import { closeWebSocketSilently, connectWebSocket, isWebSocketReusable, observeWebSocketDiagnostics, resolveWebSocketProxyForTarget } from "./websocket-connection.ts";
import { clearCanonicalSessions } from "./session-continuity.ts";

const websocketSessionCache = new Map<string, Map<string, SessionWebSocketCacheEntry>>();
const websocketPreparations = new Map<string, Set<AbortController>>();
const websocketSseFallbackSessions = new Set<string>();
const retiringWebSockets = new Map<WebSocketLike, string | undefined>();
const CONTINUATION_HEADERS = new Set([
	"openai-beta",
	"session-id",
	"thread-id",
	"x-client-request-id",
	// Upgrade-time model/tier hints may differ from later authoritative bodies.
	"x-codex-routing-hint",
]);

function routeIdentityHeaders(headers: Headers): [string, string][] {
	return [...headers.entries()]
		.filter(([name]) => !CONTINUATION_HEADERS.has(name.toLowerCase()))
		.sort(([left], [right]) => left.localeCompare(right));
}

async function websocketRouteKey(url: string, headers: Headers, accountId: string, env: ProviderEnv | undefined): Promise<string> {
	const proxy = await resolveWebSocketProxyForTarget(url, env);
	const handshakeIdentity = JSON.stringify([
		accountId,
		new URL(url).href,
		proxy ?? null,
		routeIdentityHeaders(headers),
	]);
	return createHash("sha256").update(handshakeIdentity).digest("base64url");
}

export function isWebSocketSseFallbackActive(sessionId: string | undefined): boolean {
	return sessionId ? websocketSseFallbackSessions.has(sessionId) : false;
}

export function recordWebSocketSseFallback(sessionId: string | undefined): void {
	if (sessionId) websocketSseFallbackSessions.add(sessionId);
}

function closeReleasedWebSocket(socket: WebSocketLike, sessionId: string | undefined, closeAfter?: Promise<void>): void {
	if (!closeAfter) { closeWebSocketSilently(socket, 1000, "release"); return; }
	// Detach the cancelled lane immediately; its bounded cleanup still belongs to
	// session shutdown, but the next request must acquire a fresh cached socket.
	retiringWebSockets.set(socket, sessionId);
	const close = () => {
		if (retiringWebSockets.delete(socket)) closeWebSocketSilently(socket, 1000, "release");
	};
	void closeAfter.then(close, close);
}

function removeWebSocketRoute(sessionId: string, routeKey: string, entry: SessionWebSocketCacheEntry): void {
	entry.continuation = undefined;
	const entries = websocketSessionCache.get(sessionId);
	if (entries?.get(routeKey) === entry) entries.delete(routeKey);
	if (entries?.size === 0) websocketSessionCache.delete(sessionId);
}

function retireOtherWebSocketRoutes(sessionId: string, routeKey: string): void {
	for (const [key, entry] of websocketSessionCache.get(sessionId) ?? []) {
		if (key === routeKey) continue;
		// A changed handshake identity must not retain earlier credentials/history,
		// but an in-flight lane owns its socket until release.
		entry.retired = true;
		if (entry.busy) continue;
		removeWebSocketRoute(sessionId, key, entry);
		closeWebSocketSilently(entry.socket, 1000, "stale_socket");
	}
}

function releaseWebSocketRoute(
	sessionId: string,
	routeKey: string,
	entry: SessionWebSocketCacheEntry,
	{ keep, closeAfter }: { keep?: boolean | undefined; closeAfter?: Promise<void> | undefined } = {},
): void {
	if (!keep || entry.retired || !isWebSocketReusable(entry.socket)) {
		removeWebSocketRoute(sessionId, routeKey, entry);
		closeReleasedWebSocket(entry.socket, sessionId, closeAfter);
		return;
	}
	entry.busy = false;
}

function closeWebSocketSessions(sessionId: string | undefined, cause = "session_shutdown"): void {
	for (const [socket, owner] of retiringWebSockets) {
		if (sessionId && owner !== sessionId) continue;
		retiringWebSockets.delete(socket);
		closeWebSocketSilently(socket, 1000, cause);
	}
	// A connecting preparation is not yet in the socket cache, but belongs to
	// the same session teardown boundary as a connected lease.
	const preparations = sessionId ? [websocketPreparations.get(sessionId)] : [...websocketPreparations.values()];
	for (const controllers of preparations) {
		for (const controller of controllers ?? []) controller.abort();
	}
	const closeEntry = (entry: SessionWebSocketCacheEntry) => {
		entry.continuation = undefined;
		closeWebSocketSilently(entry.socket, 1000, cause);
	};

	if (sessionId) {
		for (const entry of websocketSessionCache.get(sessionId)?.values() ?? []) closeEntry(entry);
		websocketSessionCache.delete(sessionId);
		return;
	}

	for (const routeEntries of websocketSessionCache.values()) {
		for (const entry of routeEntries.values()) closeEntry(entry);
	}
	websocketSessionCache.clear();
}

export function resetOpenAICodexWebSocketSessions(sessionId?: string): void {
	closeWebSocketSessions(sessionId, "session_reset");
	clearCanonicalSessions(sessionId);
}

export function closeOpenAICodexWebSocketSessions(sessionId?: string): void {
	closeWebSocketSessions(sessionId);
	clearCanonicalSessions(sessionId);
	if (sessionId) {
		websocketSseFallbackSessions.delete(sessionId);
		return;
	}
	websocketSseFallbackSessions.clear();
}

// A preparation lease owns only the handshake. No response or history state
// advances until handoff validates the final route and releases the lane.
export function preconnectWebSocket(
	url: string,
	headers: Headers,
	sessionId: string,
	accountId: string,
	signal: AbortSignal | undefined,
	connectTimeoutMs: number | undefined,
	env: ProviderEnv | undefined,
	onFailure: (error: unknown) => void,
	diagnostics?: CodexDiagnosticsSink,
) {
	const controller = new AbortController();
	let preparations = websocketPreparations.get(sessionId);
	if (!preparations) {
		preparations = new Set();
		websocketPreparations.set(sessionId, preparations);
	}
	preparations.add(controller);
	const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	let lease: AcquiredWebSocket | undefined;
	let attemptedRoute: string | undefined;
	let failure: { error: unknown } | undefined;
	const release = (keep: boolean) => {
		combinedSignal.removeEventListener("abort", onAbort);
		preparations.delete(controller);
		if (preparations.size === 0 && websocketPreparations.get(sessionId) === preparations) websocketPreparations.delete(sessionId);
		lease?.release({ keep });
		lease = undefined;
	};
	const onAbort = () => release(false);
	combinedSignal.addEventListener("abort", onAbort, { once: true });
	if (combinedSignal.aborted) release(false);
	const operation = (async () => {
		attemptedRoute = await websocketRouteKey(url, headers, accountId, env);
		lease = await acquireWebSocket(url, headers, sessionId, accountId, combinedSignal, connectTimeoutMs, env, diagnostics, false);
		if (combinedSignal.aborted) release(false);
	})().catch((error: unknown) => {
		// Only a failure on the finalized route may influence transport fallback.
		failure = { error };
		if (!combinedSignal.aborted) onFailure(error);
	});
	return {
		async handoff(finalUrl: string, finalHeaders: Headers, finalAccountId: string, finalEnv: ProviderEnv | undefined, keep: boolean) {
			await operation;
			if (!lease && !failure) return;
			const finalRoute = await websocketRouteKey(finalUrl, finalHeaders, finalAccountId, finalEnv);
			const matched = keep && !combinedSignal.aborted && (lease?.routeKey ?? attemptedRoute) === finalRoute;
			if (matched && lease?.entry && !lease.entry.retired) retireOtherWebSocketRoutes(sessionId, finalRoute);
			release(matched);
			return matched ? failure : undefined;
		},
		async close() {
			controller.abort();
			await operation;
			release(false);
		},
	};
}

export async function acquireWebSocket(
	url: string,
	headers: Headers,
	sessionId: string | undefined,
	accountId: string,
	signal: AbortSignal | undefined,
	connectTimeoutMs?: number,
	env?: ProviderEnv,
	diagnostics?: CodexDiagnosticsSink,
	retirePreviousRoutes = true,
): Promise<AcquiredWebSocket> {
	if (!sessionId) {
		const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env, diagnostics);
		return {
			socket,
			reused: false,
			socketAgeMs: 0,
			release: ({ closeAfter } = {}) => closeReleasedWebSocket(socket, sessionId, closeAfter),
		};
	}

	const routeKey = await websocketRouteKey(url, headers, accountId, env);
	if (signal?.aborted) throw new Error("Request was aborted");
	let routeEntries = websocketSessionCache.get(sessionId);
	const cached = routeEntries?.get(routeKey);
	if (cached) {
		if (!cached.busy && isWebSocketReusable(cached.socket)) {
			observeWebSocketDiagnostics(cached.socket, diagnostics);
			cached.busy = true;
			if (retirePreviousRoutes) retireOtherWebSocketRoutes(sessionId, routeKey);
			return {
				socket: cached.socket,
				routeKey,
				entry: cached,
				reused: true,
				socketAgeMs: Math.max(0, Date.now() - cached.createdAtMs),
				release: options => releaseWebSocketRoute(sessionId, routeKey, cached, options),
			};
		}

		if (cached.busy) {
			const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env, diagnostics);
			return {
				socket,
				routeKey,
				reused: false,
				socketAgeMs: 0,
				release: ({ closeAfter } = {}) => closeReleasedWebSocket(socket, sessionId, closeAfter),
			};
		}

		if (!isWebSocketReusable(cached.socket)) {
			removeWebSocketRoute(sessionId, routeKey, cached);
			closeWebSocketSilently(cached.socket, 1000, "stale_socket");
		}
	}

	const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env, diagnostics);
	if (signal?.aborted) {
		closeWebSocketSilently(socket, 1000, "aborted");
		throw new Error("Request was aborted");
	}
	const entry: SessionWebSocketCacheEntry = { socket, busy: true, retired: false, createdAtMs: Date.now() };
	const onClose = () => {
		socket.removeEventListener("close", onClose);
		removeWebSocketRoute(sessionId, routeKey, entry);
	};
	socket.addEventListener("close", onClose);
	routeEntries = websocketSessionCache.get(sessionId);
	if (!routeEntries) {
		routeEntries = new Map();
		websocketSessionCache.set(sessionId, routeEntries);
	}
	routeEntries.set(routeKey, entry);
	if (retirePreviousRoutes) retireOtherWebSocketRoutes(sessionId, routeKey);
	return {
		socket,
		routeKey,
		entry,
		reused: false,
		socketAgeMs: 0,
		release: options => releaseWebSocketRoute(sessionId, routeKey, entry, options),
	};
}
