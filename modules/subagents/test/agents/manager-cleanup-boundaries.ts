import type { AgentManager } from "../../src/agents/agent-manager.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  mockAgentSession as upstreamSession,
  mockRunResult as upstreamResult,
  type MockAgentSessionOptions,
  type MockRunResult,
} from "./manager-mocks.js";

/** Complete the host-session boundary for existing non-lifecycle behavior suites. */
function withShutdownBoundary<S extends object>(session: S): S {
  return Object.assign(session, {
    extensionRunner: {
      onError: () => () => {},
      emit: async () => undefined,
      emitError: () => {},
    },
  });
}

export function mockAgentSession(options?: MockAgentSessionOptions) {
  return withShutdownBoundary(upstreamSession(options));
}

/** Existing run doubles may never settle; finish their synthetic allocation boundary at teardown. */
export function finishMockInitializations(manager: AgentManager, calls: unknown[][]): void {
  for (const call of calls) {
    const options = call[3] as {
      agentId: string;
      onSessionAllocated?: (session: AgentSession, ready: Promise<void>) => void;
    };
    const session = manager.getRecord(options.agentId)?.execution.session ?? mockAgentSession();
    options.onSessionAllocated?.(session as AgentSession, Promise.resolve());
  }
}

export function mockRunResult(overrides?: Partial<MockRunResult>): MockRunResult {
  const result = upstreamResult(overrides);
  if (result.session) withShutdownBoundary(result.session);
  return result;
}
