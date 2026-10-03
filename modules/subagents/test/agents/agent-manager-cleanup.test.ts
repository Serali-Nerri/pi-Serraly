import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateAgentSessionResult } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "../../src/types.js";
import { AgentManager } from "../../src/agents/agent-manager.js";
import { registerAgents } from "../../src/agents/agent-types.js";
import { createMockExtensionAPI, fakeCtx, fakePi } from "../fixtures.js";
import { asExtensionAPI } from "../pi-boundaries.js";
import { loadConfigAndRegisterAgents, setupEventListeners } from "../../src/events.js";
import { getWidget, setManager, setWidget, setCoordinator } from "../../src/shell.js";
import { deferred, sessionFixture } from "./session-cleanup-fixture.js";

const boundary = vi.hoisted(() => ({ allocate: vi.fn<() => Promise<CreateAgentSessionResult>>() }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
  ...await original<typeof import("@earendil-works/pi-coding-agent")>(),
  createAgentSession: () => boundary.allocate(),
}));

describe("AgentManager session ownership", () => {
  let manager: AgentManager;
  const fixtures: Awaited<ReturnType<typeof sessionFixture>>[] = [];

  beforeEach(() => {
    boundary.allocate.mockReset();
    registerAgents(new Map([["cleanup", {
      name: "cleanup", description: "cleanup fixture", systemPrompt: "No model requests.",
      extensions: false, skills: false, tools: false, includeContextFiles: false, outputTranscript: false,
    }]]));
    manager = new AgentManager(undefined, { default: 1 });
  });

  afterEach(async () => {
    await manager.dispose();
    getWidget()?.dispose();
    setWidget(null);
    setManager(null);
    setCoordinator(null);
    for (const fixture of fixtures.splice(0)) fixture.remove();
  });

  async function makeSession(options: Parameters<typeof sessionFixture>[0] = {}) {
    const fixture = await sessionFixture(options);
    fixtures.push(fixture);
    return fixture;
  }

  function spawn(directory: string, extra = {}) {
    const pi = fakePi();
    pi.exec.mockResolvedValue({ code: 0, stdout: "", stderr: "", killed: false });
    return manager.spawn(pi, fakeCtx({ cwd: directory }), "cleanup", "task", {
      description: "task", modelKey: "test/model", ...extra,
    });
  }

  async function waitForBoundary(boundary: Promise<void>, record: AgentRecord): Promise<void> {
    await Promise.race([
      boundary,
      record.execution.promise!.then(() => {
        throw new Error(record.error ?? "Agent settled before the scripted SDK boundary.");
      }),
    ]);
  }

  it("clear of a stopped-but-settling agent shuts down the native resources and invalidates context", async () => {
    const fixture = await makeSession();
    boundary.allocate.mockResolvedValue(fixture.result);
    const id = spawn(fixture.directory);
    const record = manager.getRecord(id)!;
    await waitForBoundary(fixture.promptEntered.promise, record);
    expect(fixture.connected).toBe(true);

    expect(manager.abort(id, "user")).toBe(true);
    expect(fixture.connected).toBe(true); // Ordinary Stop is not Clear.
    expect(manager.clear(id)).toBe(true);
    expect(manager.getRecord(id)).toBeUndefined();
    await record.execution.promise;
    await manager.dispose();

    expect(fixture.connected).toBe(false);
    expect(fixture.shutdowns).toBe(1);
    expect(() => fixture.readContext()).toThrow(/stale/);
    // The uncooperative model prompt remains unresolved; disposal must not wait for it.
  });

  it("dispose drains allocation arriving after Clear even when startup is cancelled", async () => {
    const allocation = deferred<CreateAgentSessionResult>();
    const allocationEntered = deferred();
    const fixture = await makeSession();
    boundary.allocate.mockImplementation(() => { allocationEntered.resolve(); return allocation.promise; });
    const id = spawn(fixture.directory);
    const record = manager.getRecord(id)!;
    await waitForBoundary(allocationEntered.promise, record);
    manager.abort(id, "user");
    manager.clear(id);
    const disposed = manager.dispose("reload");
    let finished = false;
    Promise.resolve(disposed).then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);

    allocation.resolve(fixture.result);
    await disposed;
    await record.execution.promise;
    expect(fixture.connected).toBe(false);
    expect(fixture.shutdowns).toBe(1);
    expect(fixture.reasons).toEqual(["reload"]);
    expect(record.execution.session).toBeUndefined();
    expect(() => fixture.readContext()).toThrow(/stale/);
  });

  it("Stop then Clear drains a connection established by still-pending native startup", async () => {
    const startup = deferred();
    const fixture = await makeSession({ startup: startup.promise });
    boundary.allocate.mockResolvedValue(fixture.result);
    const id = spawn(fixture.directory);
    const record = manager.getRecord(id)!;
    await waitForBoundary(fixture.startupEntered.promise, record);
    manager.abort(id, "user");
    manager.clear(id);
    const disposed = manager.dispose();
    let finished = false;
    disposed.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(fixture.shutdowns).toBe(0);
    startup.resolve();
    await disposed;
    expect(fixture.shutdowns).toBe(1);
    expect(fixture.connected).toBe(false);
    expect(() => fixture.readContext()).toThrow(/stale/);
  });

  it("disposal opens foreground gates, aborts active work and refuses new spawns", async () => {
    const fixture = await makeSession();
    boundary.allocate.mockResolvedValue(fixture.result);
    const id = spawn(fixture.directory);
    const record = manager.getRecord(id)!;
    await waitForBoundary(fixture.promptEntered.promise, record);
    const queuedId = spawn(fixture.directory);
    const queued = manager.getRecord(queuedId)!;
    const disposal = manager.dispose("quit");
    expect(record.execution.abortController!.signal.aborted).toBe(true);
    await record.execution.promise;
    await queued.execution.promise;
    expect(queued.lifecycle.status).toBe("error");
    expect(() => spawn(fixture.directory)).toThrow(/disposed/);
    await disposal;
    expect(fixture.connected).toBe(false);
  });

  it("late settlement cannot restore a removed session or notify a replacement coordinator", async () => {
    const fixture = await makeSession();
    boundary.allocate.mockResolvedValue(fixture.result);
    const notifications: string[] = [];
    manager.setOnComplete((record) => notifications.push(record.id));
    const id = spawn(fixture.directory);
    const record = manager.getRecord(id)!;
    await waitForBoundary(fixture.promptEntered.promise, record);
    await manager.dispose();
    fixture.promptFinished.resolve();
    // The native prompt boundary settles independently of the foreground gate.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(record.execution.settled).toBe(true);
    expect(notifications).toEqual([]);
    expect(record.execution.session).toBeUndefined();
    expect(record.execution.spawnCtx).toBeUndefined();
    expect(manager.listAgents()).toEqual([]);
    expect(await manager.steer(id, "continue")).toBe(false);
  });

  it("normal completion retains the native session for continuation until Clear", async () => {
    const fixture = await makeSession();
    fixture.promptFinished.resolve();
    boundary.allocate.mockResolvedValue(fixture.result);
    const id = spawn(fixture.directory);
    const record = manager.getRecord(id)!;
    await record.execution.promise;
    expect(record.error).toBeUndefined();
    expect(record.lifecycle.status).toBe("completed");
    expect(fixture.connected).toBe(true);
    expect(fixture.shutdowns).toBe(0);
    expect(await manager.steer(id, "continue")).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(record.execution.settlementCount).toBe(2);
    expect(fixture.connected).toBe(true);
    manager.clear(id);
    await manager.dispose();
    expect(fixture.connected).toBe(false);
  });

  it.each(["user", "watchdog"] as const)(
    "%s Stop retains native resources for continuation after the old run settles", async (initiator) => {
      const fixture = await makeSession();
      boundary.allocate.mockResolvedValue(fixture.result);
      const id = spawn(fixture.directory);
      const record = manager.getRecord(id)!;
      await waitForBoundary(fixture.promptEntered.promise, record);
      manager.abort(id, initiator);
      fixture.promptFinished.resolve();
      await record.execution.promise;
      expect(record.lifecycle.status).toBe("stopped");
      expect(fixture.connected).toBe(true);
      expect(fixture.shutdowns).toBe(0);
      expect(await manager.steer(id, "continue")).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(record.execution.settlementCount).toBe(2);
      expect(fixture.connected).toBe(true);
      manager.clear(id);
      await manager.dispose();
      expect(fixture.shutdowns).toBe(1);
      expect(() => fixture.readContext()).toThrow(/stale/);
    },
  );

  it("non-TUI startup does not create a widget or UI timers", async () => {
    const fixture = await makeSession();
    await manager.dispose();
    vi.useFakeTimers();
    try {
      manager = new AgentManager();
      setManager(manager);
      setWidget(null);
      setCoordinator(null);
      const ctx = fakeCtx({ cwd: fixture.directory, hasUI: false });
      await loadConfigAndRegisterAgents(ctx);
      const api = createMockExtensionAPI();
      setupEventListeners(asExtensionAPI(api.api));
      await api.listeners.find((listener) => listener.event === "turn_start")!.handler({ type: "turn_start" }, ctx);
      expect(getWidget()).toBeNull();
      // The business watchdog remains; no presentation refresh timers exist.
      expect(vi.getTimerCount()).toBe(1);
      await manager.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["reload", "quit", "new", "resume", "fork"] as const)(
    "parent %s shutdown awaits native child shutdown with the original reason", async (reason) => {
      const fixture = await makeSession();
      boundary.allocate.mockResolvedValue(fixture.result);
      const id = spawn(fixture.directory);
      const record = manager.getRecord(id)!;
      await waitForBoundary(fixture.promptEntered.promise, record);
      setManager(manager);
      const api = createMockExtensionAPI();
      setupEventListeners(asExtensionAPI(api.api));
      const handler = api.listeners.find((listener) => listener.event === "session_shutdown")!.handler;
      await handler({ type: "session_shutdown", reason }, fakeCtx({ hasUI: false }));
      expect(fixture.reasons).toEqual([reason]);
      expect(() => fixture.readContext()).toThrow(/stale/);
    },
  );

  it("a queued Stop opens its foreground gate without allocating a session", async () => {
    const fixture = await makeSession();
    boundary.allocate.mockResolvedValue(fixture.result);
    const id = spawn(fixture.directory);
    const record = manager.getRecord(id)!;
    await waitForBoundary(fixture.promptEntered.promise, record);
    const queuedId = spawn(fixture.directory);
    const queued = manager.getRecord(queuedId)!;
    expect(manager.abort(queuedId, "user")).toBe(true);
    expect(await queued.execution.promise).toBe("");
    expect(queued.lifecycle.started).toBe(false);
    expect(queued.execution.session).toBeUndefined();
    expect(fixture.shutdowns).toBe(0);
    await manager.dispose();
    expect(fixture.shutdowns).toBe(1);
  });
});
