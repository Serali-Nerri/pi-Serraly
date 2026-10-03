import type { AgentSession, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";

const closingSessions = new WeakMap<AgentSession, Promise<void>>();

/**
 * Close native extension resources before invalidating their session context.
 * Abort requests cancellation; its idle wait is deliberately not a close gate.
 */
export function closeAgentSession(
  session: AgentSession | undefined,
  reason: SessionShutdownEvent["reason"] = "quit",
  ready?: Promise<void>,
): Promise<void> {
  if (!session) return Promise.resolve();
  const closing = closingSessions.get(session);
  if (closing) return closing;

  // Publish before invoking abort or extension handlers, which may re-enter.
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  closingSessions.set(session, promise);
  void shutdown(session, reason, ready).then(resolve, reject);
  return promise;
}

async function shutdown(
  session: AgentSession,
  reason: SessionShutdownEvent["reason"],
  ready?: Promise<void>,
): Promise<void> {
  const errors: unknown[] = [];
  let finished = false;
  try {
    void session.abort().catch((error: unknown) => {
      if (!finished) errors.push(error);
      else session.extensionRunner.emitError({
        extensionPath: "subagents",
        event: "session_shutdown",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } catch (error) {
    errors.push(error);
  }

  if (ready) {
    // Initialization's caller reports its rejection. This is a readiness
    // boundary, not another shutdown failure: still release allocated resources.
    await ready.catch(() => {});
  }

  // Pi reports extension handler exceptions through onError rather than
  // rejecting emit. Preserve those failures for the awaited close owner too.
  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = session.extensionRunner.onError((error) => {
      if (error.event === "session_shutdown") errors.push(new Error(error.error));
    });
    await session.extensionRunner.emit({ type: "session_shutdown", reason });
  } catch (error) {
    errors.push(error);
  } finally {
    unsubscribe?.();
    try { session.dispose(); } catch (error) { errors.push(error); }
    finished = true;
  }

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Failed to close subagent session.");
}
