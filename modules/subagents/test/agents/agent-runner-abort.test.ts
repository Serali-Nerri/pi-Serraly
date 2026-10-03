import { mockModules, resetMocks, createMockSession } from "./agent-runner-mocks.js";
import { beforeEach, expect, it, vi } from "vitest";
import { fakeCtx, fakePi } from "../fixtures.js";
import { asAgentSession } from "../pi-boundaries.js";
import { continueAgentSession, runAgent } from "../../src/agents/agent-runner.js";

beforeEach(() => resetMocks());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

it("an already aborted continuation does not request a model response", async () => {
  const session = createMockSession();
  const requests: string[] = [];
  session.prompt.mockImplementation(async (prompt) => { requests.push(prompt); });
  const controller = new AbortController();
  controller.abort();
  const result = await continueAgentSession(asAgentSession(session), "do not run", { signal: controller.signal });
  expect(requests).toEqual([]);
  expect(result.aborted).toBe(true);
});

it("publishes allocated session ownership before asynchronous binding completes", async () => {
  const session = createMockSession();
  const binding = deferred();
  const entered = deferred();
  const events: string[] = [];
  let initialized = false;
  session.bindExtensions.mockImplementation(() => {
    events.push("bind");
    entered.resolve();
    return binding.promise;
  });
  mockModules.mockCreateAgentSession.mockResolvedValue({ session });
  const running = runAgent(fakeCtx(), "test-agent", "test", {
    pi: fakePi(),
    onSessionAllocated: (_session, ready) => {
      events.push("allocated");
      void ready.then(() => { initialized = true; });
    },
    onSessionCreated: () => { events.push("created"); },
  });
  try {
    await entered.promise;
    expect(events).toEqual(["allocated", "bind"]);
    expect(initialized).toBe(false);
  } finally { binding.resolve(); await running; }
  expect(initialized).toBe(true);
  expect(events).toEqual(["allocated", "bind", "created"]);
});

it("failed initialization shuts down allocated resources before disposing the session", async () => {
  const session = createMockSession();
  const events: string[] = [];
  const failure = new Error("binding failed");
  session.bindExtensions.mockImplementation(() => { throw failure; });
  const disposable = Object.assign(session, {
    extensionRunner: {
      onError: () => () => {},
      emit: async () => { events.push("shutdown"); },
    },
    dispose: vi.fn(() => { events.push("dispose"); }),
  });
  mockModules.mockCreateAgentSession.mockResolvedValue({ session: disposable });
  await expect(runAgent(fakeCtx(), "test-agent", "test", { pi: fakePi() })).rejects.toBe(failure);
  expect(events).toEqual(["shutdown", "dispose"]);
});
