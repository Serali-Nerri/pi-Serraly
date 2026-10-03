/**
 * agent-manager-concurrency.test.ts — Concurrency limiting for AgentManager.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { fakeCtx, fakePi, makeResolvablePromise } from "../fixtures.js";
import { mockModules, mockStoreState, type OnAgentComplete } from "./manager-mocks.js";
import { mockAgentSession, mockRunResult } from "./manager-cleanup-boundaries.js";
import { asAgentSession } from "../pi-boundaries.js";
import { AgentManager, WATCHDOG_TICK_MS } from "../../src/agents/agent-manager.js";
import type { ConcurrencyConfig } from "../../src/agents/agent-manager.js";
import type { RunCallbacks } from "../../src/types.js";

describe("AgentManager", () => {
  let manager: AgentManager;
  let onComplete: Mock<OnAgentComplete>;

  beforeEach(() => {
    mockModules.resetUuidCounter();
    mockModules.mockRunAgent.mockReset();
    mockModules.mockContinueAgentSession.mockReset();
    mockModules.mockAgentOutputLog.mockClear();
    mockModules.mockGetAgentConfig.mockClear();
    onComplete = vi.fn<OnAgentComplete>();
  });

  afterEach(async () => {
    await manager?.dispose();
  });

  describe("allocated sessions", () => {
    it("queues steers until an allocated session finishes binding, then delivers them in order", async () => {
      manager = new AgentManager(onComplete, { default: 1 });
      const run = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(run.promise);
      const session = asAgentSession(mockAgentSession());
      const delivered: string[] = [];
      session.steer.mockImplementation(async (message) => { delivered.push(message); });
      let finishBinding!: () => void;
      const ready = new Promise<void>((resolve) => { finishBinding = resolve; });
      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task", modelKey: "test/model",
      });
      const record = manager.getRecord(id)!;
      const callbacks: RunCallbacks = mockModules.mockRunAgent.mock.calls[0][3];
      try {
        expect(await manager.steer(id, "before allocation")).toBe(true);
        callbacks.onSessionAllocated!(session, ready);
        expect(record.execution.session).toBe(session);
        expect(await manager.steer(id, "during binding")).toBe(true);
        expect(delivered).toEqual([]);
        expect(record.execution.pendingSteers).toEqual(["before allocation", "during binding"]);

        callbacks.onSessionCreated!(session);
        finishBinding();
        expect(delivered).toEqual(["before allocation", "during binding"]);
        expect(record.execution.pendingSteers).toBeUndefined();
        expect(await manager.steer(id, "after binding")).toBe(true);
        expect(delivered).toEqual(["before allocation", "during binding", "after binding"]);
      } finally {
        finishBinding();
        run.resolve(mockRunResult({ session }));
        await record.execution.promise;
      }
    });
  });

  describe("concurrency", () => {
    it("starts all agents when under per-model limit", () => {
      const config: ConcurrencyConfig = { default: 4, models: {} };
      manager = new AgentManager(onComplete, config);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b_small",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/4b_small",
        isBackground: true,
      });
      const id3 = manager.spawn(pi, ctx, "general-purpose", "task 3", {
        description: "task 3",
        modelKey: "llamacpp/4b_small",
        isBackground: true,
      });

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id3)?.lifecycle.status).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(3);
    });

    it("queues agents when per-model limit is reached", () => {
      const config: ConcurrencyConfig = { default: 1, models: { "llamacpp/4b_small": 1 } };
      manager = new AgentManager(onComplete, config);

      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b_small",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/4b_small",
        isBackground: true,
      });

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("queued");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(1);

      deferred.resolve(mockRunResult());
    });

    it("starts queued agent when running agent completes", async () => {
      const config: ConcurrencyConfig = { default: 1, models: { "llamacpp/4b_small": 1 } };
      manager = new AgentManager(onComplete, config);

      const deferred1 = makeResolvablePromise();
      const deferred2 = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValueOnce(deferred1.promise).mockReturnValueOnce(deferred2.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b_small",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/4b_small",
        isBackground: true,
      });

      expect(manager.getRecord(id2)?.lifecycle.status).toBe("queued");

      deferred1.resolve(mockRunResult());
      await manager.getRecord(id1)!.execution.promise;

      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);

      deferred2.resolve(mockRunResult());
    });

    it("queues agents per-model independently", () => {
      const config: ConcurrencyConfig = {
        default: 4,
        models: { "llamacpp/27b": 1, "llamacpp/4b": 4 },
      };
      manager = new AgentManager(onComplete, config);

      const deferred1 = makeResolvablePromise();
      const deferred2 = makeResolvablePromise();
      const deferred3 = makeResolvablePromise();
      mockModules.mockRunAgent
        .mockReturnValueOnce(deferred1.promise)
        .mockReturnValueOnce(deferred2.promise)
        .mockReturnValueOnce(deferred3.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/27b",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      const id3 = manager.spawn(pi, ctx, "general-purpose", "task 3", {
        description: "task 3",
        modelKey: "llamacpp/27b",
        isBackground: true,
      });

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id3)?.lifecycle.status).toBe("queued");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);

      deferred1.resolve(mockRunResult());
      deferred2.resolve(mockRunResult());
      deferred3.resolve(mockRunResult());
    });

    it("applies default limit for unknown models", () => {
      const config: ConcurrencyConfig = { default: 2, models: {} };
      manager = new AgentManager(onComplete, config);

      const deferred1 = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred1.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "claude/sonnet",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "claude/sonnet",
        isBackground: true,
      });
      const id3 = manager.spawn(pi, ctx, "general-purpose", "task 3", {
        description: "task 3",
        modelKey: "claude/sonnet",
        isBackground: true,
      });

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id3)?.lifecycle.status).toBe("queued");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);

      deferred1.resolve(mockRunResult());
    });

    it("applies per-provider limit to all models from that provider", () => {
      const config: ConcurrencyConfig = {
        default: 4,
        providers: { llamacpp: 2 },
        models: {},
      };
      manager = new AgentManager(onComplete, config);

      const deferred1 = makeResolvablePromise();
      const deferred2 = makeResolvablePromise();
      const deferred3 = makeResolvablePromise();
      mockModules.mockRunAgent
        .mockReturnValueOnce(deferred1.promise)
        .mockReturnValueOnce(deferred2.promise)
        .mockReturnValueOnce(deferred3.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/27b",
        isBackground: true,
      });
      const id3 = manager.spawn(pi, ctx, "general-purpose", "task 3", {
        description: "task 3",
        modelKey: "llamacpp/3b",
        isBackground: true,
      });
      const id4 = manager.spawn(pi, ctx, "general-purpose", "task 4", {
        description: "task 4",
        modelKey: "claude/sonnet",
        isBackground: true,
      });

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id3)?.lifecycle.status).toBe("queued");
      expect(manager.getRecord(id4)?.lifecycle.status).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(3);

      deferred1.resolve(mockRunResult());
      deferred2.resolve(mockRunResult());
      deferred3.resolve(mockRunResult());
    });

    it("per-model limit overrides per-provider limit", () => {
      const config: ConcurrencyConfig = {
        default: 4,
        providers: { llamacpp: 2 },
        models: { "llamacpp/4b": 1 },
      };
      manager = new AgentManager(onComplete, config);

      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("queued");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(1);

      deferred.resolve(mockRunResult());
    });

    it("applies new limit when setConcurrency is called", () => {
      const config: ConcurrencyConfig = { default: 1, models: { "llamacpp/4b": 1 } };
      manager = new AgentManager(onComplete, config);

      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });

      expect(manager.getRecord(id2)?.lifecycle.status).toBe("queued");

      manager.setConcurrency({ default: 1, models: { "llamacpp/4b": 2 } });

      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);

      deferred.resolve(mockRunResult());
    });

    it("removes per-model slot when model entry is removed from config", () => {
      const config: ConcurrencyConfig = { default: 4, models: { "llamacpp/4b": 1 } };
      manager = new AgentManager(onComplete, config);

      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");

      manager.setConcurrency({ default: 4, models: {} });

      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      const id3 = manager.spawn(pi, ctx, "general-purpose", "task 3", {
        description: "task 3",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      const id4 = manager.spawn(pi, ctx, "general-purpose", "task 4", {
        description: "task 4",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id3)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id4)?.lifecycle.status).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(4);

      deferred.resolve(mockRunResult());
    });

    it("removes per-provider slot when provider entry is removed from config", () => {
      const config: ConcurrencyConfig = { default: 4, providers: { llamacpp: 1 }, models: {} };
      manager = new AgentManager(onComplete, config);

      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");

      manager.setConcurrency({ default: 4, providers: {}, models: {} });

      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      const id3 = manager.spawn(pi, ctx, "general-purpose", "task 3", {
        description: "task 3",
        modelKey: "llamacpp/27b",
        isBackground: true,
      });
      const id4 = manager.spawn(pi, ctx, "general-purpose", "task 4", {
        description: "task 4",
        modelKey: "llamacpp/3b",
        isBackground: true,
      });

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id3)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id4)?.lifecycle.status).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(4);

      deferred.resolve(mockRunResult());
    });

    it("reset to defaults clears per-model and per-provider slots", () => {
      const config: ConcurrencyConfig = {
        default: 4,
        providers: { llamacpp: 2 },
        models: { "llamacpp/4b": 1, "claude/sonnet": 2 },
      };
      manager = new AgentManager(onComplete, config);

      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "claude/sonnet",
        isBackground: true,
      });
      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");

      manager.setConcurrency({ default: 4 });

      const id3 = manager.spawn(pi, ctx, "general-purpose", "task 3", {
        description: "task 3",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      const id4 = manager.spawn(pi, ctx, "general-purpose", "task 4", {
        description: "task 4",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      const id5 = manager.spawn(pi, ctx, "general-purpose", "task 5", {
        description: "task 5",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });

      expect(manager.getRecord(id3)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id4)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id5)?.lifecycle.status).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(5);

      deferred.resolve(mockRunResult());
    });

    it("running agent under removed slot still settles without error", async () => {
      const config: ConcurrencyConfig = { default: 4, models: { "llamacpp/4b": 1 } };
      manager = new AgentManager(onComplete, config);

      const deferred1 = makeResolvablePromise();
      const deferred2 = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValueOnce(deferred1.promise).mockReturnValueOnce(deferred2.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");

      manager.setConcurrency({ default: 4, models: {} });

      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");

      deferred1.resolve(mockRunResult());
      await manager.getRecord(id1)!.execution.promise;

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("completed");
      expect(onComplete).toHaveBeenCalledTimes(1);

      deferred2.resolve(mockRunResult());
    });

    it("keeps the model slot occupied across repeated watchdog stalls until the response settles", async () => {
      vi.useFakeTimers();
      mockStoreState.toolTimeoutMinutes = 1;
      mockStoreState.idleTimeoutMinutes = 2;
      const pendingRuns: ReturnType<typeof makeResolvablePromise>[] = [];
      const session = asAgentSession(mockAgentSession());
      try {
        manager = new AgentManager(onComplete, { default: 1 });
        mockModules.mockRunAgent.mockImplementationOnce(async (_ctx, _type, _prompt, callbacks: RunCallbacks) => {
          callbacks.onSessionAllocated!(session, Promise.resolve());
          callbacks.onSessionCreated!(session);
          return mockRunResult({ session });
        });
        const spawn = (prompt: string) => manager.spawn(fakePi(), fakeCtx(), "general-purpose", prompt, {
          description: prompt, modelKey: "test/model",
        });
        const id = spawn("first");
        const record = manager.getRecord(id)!;
        await record.execution.promise;
        const completed = () => new Promise<void>((resolve) => onComplete.mockImplementationOnce(() => resolve()));

        const firstContinuation = makeResolvablePromise();
        pendingRuns.push(firstContinuation);
        mockModules.mockContinueAgentSession.mockReturnValueOnce(firstContinuation.promise);
        expect(await manager.steer(id, "run a tool")).toBe(true);
        const firstCallbacks: RunCallbacks = mockModules.mockContinueAgentSession.mock.calls[0][2];
        firstCallbacks.onToolActivity!({ type: "start", toolName: "bash", toolCallId: "stalled-tool" });
        vi.advanceTimersByTime(60_000);
        expect(record.lifecycle.stopDetail).toEqual({ kind: "tool", toolName: "bash", elapsedMs: 60_000 });
        expect(record.execution.abortController!.signal.aborted).toBe(true);
        expect(await manager.steer(id, "too early")).toBe(false);
        const firstCompleted = completed();
        firstContinuation.resolve(mockRunResult({ session }));
        await firstCompleted;

        const secondContinuation = makeResolvablePromise();
        pendingRuns.push(secondContinuation);
        mockModules.mockContinueAgentSession.mockReturnValueOnce(secondContinuation.promise);
        expect(await manager.steer(id, "retry without a tool")).toBe(true);
        // The previous stalled tool must not survive this fresh watchdog run.
        vi.advanceTimersByTime(WATCHDOG_TICK_MS);
        expect(record.lifecycle.status).toBe("running");
        const secondCallbacks: RunCallbacks = mockModules.mockContinueAgentSession.mock.calls[1][2];
        secondCallbacks.onTextDelta!("working", "working");
        vi.advanceTimersByTime(120_000);
        expect(record.lifecycle.status).toBe("stopped");
        expect(record.lifecycle.stoppedBy).toBe("watchdog");
        expect(record.lifecycle.stopDetail).toEqual({ kind: "idle", elapsedMs: 120_000 });

        const queuedRun = makeResolvablePromise();
        pendingRuns.push(queuedRun);
        mockModules.mockRunAgent.mockReturnValueOnce(queuedRun.promise);
        const queuedId = spawn("queued behind the stalled response");
        const queued = manager.getRecord(queuedId)!;
        expect(queued.lifecycle.status).toBe("queued");
        expect(await manager.steer(id, "still settling")).toBe(false);
        const secondCompleted = completed();
        secondContinuation.resolve(mockRunResult({ session }));
        await secondCompleted;
        expect(queued.lifecycle.status).toBe("running");
        expect(await manager.steer(id, "slot now belongs to the queued agent")).toBe(false);
        queuedRun.resolve(mockRunResult());
        await queued.execution.promise;
      } finally {
        for (const run of pendingRuns) run.resolve(mockRunResult({ session }));
        try {
          await manager?.dispose();
        } finally {
          mockStoreState.toolTimeoutMinutes = 0;
          mockStoreState.idleTimeoutMinutes = 0;
          vi.useRealTimers();
        }
      }
    });

    it("queues foreground agent when limit is reached", async () => {
      const config: ConcurrencyConfig = { default: 1, models: { "llamacpp/4b": 1 } };
      manager = new AgentManager(onComplete, config);

      const deferred1 = makeResolvablePromise();
      const deferred2 = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValueOnce(deferred1.promise).mockReturnValueOnce(deferred2.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "bg task", {
        description: "bg task",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "fg task", {
        description: "fg task",
        modelKey: "llamacpp/4b",
        isBackground: false,
      });

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("queued");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(1);

      deferred1.resolve(mockRunResult());
      await manager.getRecord(id1)!.execution.promise;
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);
      deferred2.resolve(mockRunResult());
    });
  });
});
