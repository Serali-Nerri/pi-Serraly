import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RELOAD_SHELL_HANDOFF_TIMEOUT_MS,
  RELOAD_SHELL_OWNER_PROTOCOL,
  RELOAD_SHELL_OWNER_SYMBOL,
  ReloadSurvivalError,
  createReloadShellOwnerHubForTests,
  createReloadableShellExecutionV1,
  getProcessReloadShellOwnerV1,
  inspectReloadShellOwnerForTests,
  makeReloadShellIdentity,
} from '../../src/core/reload-shell-owner.js';
import type {
  BgTask,
  ReloadShellActivationLeaseV1,
  ReloadShellHostAdapterV1,
  ReloadShellOwnerEventSinkV1,
  ReloadableShellExecutionV1,
} from '../../src/core/common.js';

function fakeTask(id: string): BgTask {
  return {
    id,
    name: id,
    command: 'node fake.js',
    status: 'running',
    outputPath: `.pi/tasks/test/${id}.output`,
    outputAbsPath: `/tmp/${id}.output`,
    metadataAbsPath: `/tmp/${id}.json`,
    cwd: '/tmp',
    startTime: 1,
    bytesWritten: 0,
    surviveReload: true,
    reloadSurvival: {
      schemaVersion: 'pi-background-shell.reload-shell.v1',
      authority: 'same-process-live-owner',
      hostPid: process.pid,
      sessionId: 'owner-test',
      cwdRealpath: '/tmp',
      launchNonce: `${id.padEnd(32, '0').slice(0, 32)}`,
      completionId: `${id}:1`,
      spawnedAt: 1,
      childPid: 101,
      outputCapBytes: 1024,
      leaseGeneration: 1,
      handoffCount: 0,
    },
    notified: false,
    notifyOnCompletion: true,
    triggerOnCompletion: false,
    terminalPublished: false,
    terminalPublicationState: 'pending',
    terminalPublishAttempts: 0,
    waiters: [],
  };
}

function fakeExecution(
  id: string,
  onStop?: (kind: string) => void,
): ReloadableShellExecutionV1 {
  const task = fakeTask(id);
  let resolveTerminal: ((task: BgTask) => void) | undefined;
  const terminal = new Promise<BgTask>((resolve) => {
    resolveTerminal = resolve;
  });
  let sink: ReloadShellOwnerEventSinkV1 | undefined;
  const execution: ReloadableShellExecutionV1 = {
    protocol: RELOAD_SHELL_OWNER_PROTOCOL,
    launchNonce: task.reloadSurvival?.launchNonce ?? id,
    completionId: `${id}:1`,
    task,
    child: undefined,
    outputStream: undefined,
    spawnedAt: 1,
    outputCapBytes: 1024,
    terminal,
    phase: 'running',
    admissionCommitted: false,
    notificationState: 'pending',
    commitInitialMetadata: () => Promise.resolve(),
    failAdmission() {},
    requestStop: async (kind) => {
      onStop?.(kind);
      execution.phase = 'terminal';
      task.status = kind === 'handoff_expired' ? 'failed' : 'killed';
      task.error = kind === 'handoff_expired' ? 'pi_bg_reload_handoff_expired' : task.error;
      resolveTerminal?.(task);
      sink?.onTerminal(execution);
      return task;
    },
    setOwnerEventSink(next) {
      sink = next;
    },
    markAdmissionCommitted(generation, handoffCount) {
      execution.admissionCommitted = true;
      if (task.reloadSurvival) {
        task.reloadSurvival.leaseGeneration = generation;
        task.reloadSurvival.handoffCount = handoffCount;
      }
    },
    updateLeaseAudit(generation, handoffCount) {
      if (task.reloadSurvival) {
        task.reloadSurvival.leaseGeneration = generation;
        task.reloadSurvival.handoffCount = handoffCount;
      }
    },
    abandonReloadHandoff() {
      task.terminalPublicationState = 'abandoned';
      task.terminalPublicationAbandonReason = 'reload_handoff_expired';
    },
    beginNotification() {
      execution.notificationState = 'sending';
      return 'notification-token';
    },
    finishNotification(_token, delivered) {
      execution.notificationState = delivered ? 'delivered' : 'pending';
      task.notified = delivered;
    },
    releaseResources() {
      execution.phase = 'released';
      execution.child = undefined;
      execution.outputStream = undefined;
    },
  };
  return execution;
}

function adapter(
  activationNonce: string,
  events: string[],
  leaseSink?: (lease: ReloadShellActivationLeaseV1) => void,
): ReloadShellHostAdapterV1 {
  return {
    activationNonce,
    onBound(lease) {
      events.push(`bound:${String(lease.generation)}`);
      leaseSink?.(lease);
    },
    onChanged(execution) {
      events.push(`changed:${execution.task.id}`);
    },
    onTerminal(execution) {
      events.push(`terminal:${execution.task.id}`);
    },
  };
}

void describe('same-process reload shell owner', { concurrency: false }, () => {
  void it('uses the v1 global symbol structurally across accessor calls without instanceof', () => {
    assert.equal(RELOAD_SHELL_OWNER_PROTOCOL, 'pi-background-shell.reload-shell-owner.v1');
    assert.equal(RELOAD_SHELL_OWNER_SYMBOL, Symbol.for(RELOAD_SHELL_OWNER_PROTOCOL));
    assert.equal(RELOAD_SHELL_HANDOFF_TIMEOUT_MS, 30_000);
    const first = getProcessReloadShellOwnerV1();
    const second = getProcessReloadShellOwnerV1();
    assert.equal(first, second);
    assert.equal(first.protocol, RELOAD_SHELL_OWNER_PROTOCOL);
    assert.equal(typeof first.beginActivation, 'function');
    assert.equal(Object.getPrototypeOf(first), null);
  });

  void it('leaves the upstream global owner untouched instead of adopting its tasks', () => {
    const upstreamSymbol = Symbol.for('pi-background-tasks.reload-shell-owner.v1');
    const upstreamDescriptor = Object.getOwnPropertyDescriptor(globalThis, upstreamSymbol);
    const forkDescriptor = Object.getOwnPropertyDescriptor(globalThis, RELOAD_SHELL_OWNER_SYMBOL);
    const upstream = { protocol: 'pi-background-tasks.reload-shell-owner.v1', tasks: ['upstream-task'] };
    try {
      Reflect.set(globalThis, upstreamSymbol, upstream);
      Reflect.deleteProperty(globalThis, RELOAD_SHELL_OWNER_SYMBOL);
      const fork = getProcessReloadShellOwnerV1();
      assert.notEqual(fork, upstream);
      assert.equal(fork.protocol, 'pi-background-shell.reload-shell-owner.v1');
      assert.equal(Reflect.get(globalThis, upstreamSymbol), upstream);
      assert.deepEqual(upstream.tasks, ['upstream-task']);
    } finally {
      if (upstreamDescriptor === undefined) Reflect.deleteProperty(globalThis, upstreamSymbol);
      else Object.defineProperty(globalThis, upstreamSymbol, upstreamDescriptor);
      if (forkDescriptor === undefined) Reflect.deleteProperty(globalThis, RELOAD_SHELL_OWNER_SYMBOL);
      else Object.defineProperty(globalThis, RELOAD_SHELL_OWNER_SYMBOL, forkDescriptor);
    }
  });

  void it('keys exact pid/session/real-cwd identities and isolates independent sessions', () => {
    const hub = createReloadShellOwnerHubForTests({ randomNonce: (() => {
      let sequence = 0;
      return () => `${String(++sequence).padStart(32, '0')}`;
    })() });
    const cwd = realpathSync('/tmp');
    const one = makeReloadShellIdentity('session-one', cwd);
    const two = makeReloadShellIdentity('session-two', cwd);
    const oneClaim = hub.beginActivation(one, 'startup', 'a'.repeat(32));
    const oneEvents: string[] = [];
    const oneLease = hub.commitActivation(oneClaim, adapter('a'.repeat(32), oneEvents));
    const twoClaim = hub.beginActivation(two, 'startup', 'b'.repeat(32));
    const twoEvents: string[] = [];
    const twoLease = hub.commitActivation(twoClaim, adapter('b'.repeat(32), twoEvents));
    assert.notEqual(oneLease.identityKey, twoLease.identityKey);
    assert.equal(hub.isCurrentLease(oneLease), true);
    assert.equal(hub.isCurrentLease(twoLease), true);
    hub.releaseActivation(oneLease);
    hub.releaseActivation(twoLease);
  });

  void it('performs a two-phase claim, queues gap completion, and rejects stale mutation', () => {
    let nonce = 0;
    const hub = createReloadShellOwnerHubForTests({
      handoffTimeoutMs: 1000,
      randomNonce: () => `${String(++nonce).padStart(32, '0')}`,
    });
    const identity = makeReloadShellIdentity('owner-test', realpathSync('/tmp'));
    const oldEvents: string[] = [];
    const firstClaim = hub.beginActivation(identity, 'startup', '1'.repeat(32));
    const firstLease = hub.commitActivation(firstClaim, adapter('1'.repeat(32), oldEvents));
    const execution = fakeExecution('owner-gap');
    hub.registerExecution(firstLease, execution);
    hub.markAdmissionCommitted(firstLease, execution);

    const transferred = hub.beginReloadHandoff(firstLease);
    assert.deepEqual(transferred, [execution]);
    execution.setOwnerEventSink;
    const claim = hub.beginActivation(identity, 'reload', '2'.repeat(32));
    assert.equal(claim.generation, 2);
    assert.equal(claim.executions[0], execution);
    assert.equal(claim.expiresAt !== undefined, true);

    // No new adapter is visible during claiming; the event is retained for commit.
    const sink = Reflect.get(execution, '__ownerEventSinkForTests');
    void sink;
    execution.phase = 'terminal';
    execution.task.status = 'completed';
    const freshEvents: string[] = [];
    const nextLease = hub.commitActivation(claim, adapter('2'.repeat(32), freshEvents));
    assert.deepEqual(freshEvents, ['bound:2', 'changed:owner-gap', 'terminal:owner-gap']);
    assert.equal(execution.task.reloadSurvival?.leaseGeneration, 2);
    assert.equal(execution.task.reloadSurvival?.handoffCount, 1);
    assert.throws(
      () => hub.registerExecution(firstLease, fakeExecution('stale')),
      (error: unknown) =>
        error instanceof ReloadSurvivalError && error.code === 'pi_bg_reload_owner_stale_claim',
    );
    hub.releaseExecution(nextLease, execution);
    hub.releaseActivation(nextLease);
  });

  void it('does not extend the absolute handoff deadline when a claim aborts', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let currentTime = 1000;
    let nonce = 0;
    const hub = createReloadShellOwnerHubForTests({
      now: () => currentTime,
      randomNonce: () => `${String(++nonce).padStart(32, '0')}`,
      logger: { error() {} },
    });
    const identity = makeReloadShellIdentity('deadline-test', realpathSync('/tmp'));
    const initial = hub.beginActivation(identity, 'startup', '3'.repeat(32));
    const lease = hub.commitActivation(initial, adapter('3'.repeat(32), []));
    const stops: string[] = [];
    const execution = fakeExecution('owner-expiry', (kind) => stops.push(kind));
    hub.registerExecution(lease, execution);
    hub.markAdmissionCommitted(lease, execution);
    hub.beginReloadHandoff(lease);
    const expiresAt = currentTime + RELOAD_SHELL_HANDOFF_TIMEOUT_MS;
    for (const activation of ['4', '5', '6']) {
      currentTime += 5000;
      t.mock.timers.tick(5000);
      const claim = hub.beginActivation(identity, 'reload', activation.repeat(32));
      assert.equal(claim.expiresAt, expiresAt);
      hub.abortActivation(claim, new Error('synthetic import failure'));
      assert.equal(inspectReloadShellOwnerForTests(hub, identity).expiresAt, expiresAt);
      assert.deepEqual(stops, []);
    }
    currentTime = expiresAt - 1;
    t.mock.timers.tick(14_999);
    assert.deepEqual(stops, []);
    currentTime = expiresAt;
    t.mock.timers.tick(1);
    assert.deepEqual(stops, ['handoff_expired']);
    await execution.terminal;
    assert.equal(execution.task.status, 'failed');
    assert.equal(execution.task.terminalPublicationAbandonReason, 'reload_handoff_expired');
    assert.equal(inspectReloadShellOwnerForTests(hub, identity).executions.length, 0);
  });

  for (const phase of ['handoff', 'claiming'] as const) {
    void it(`rearms early handoff deadline callbacks while ${phase} without moving expiresAt`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      let currentTime = 1000;
      const hub = createReloadShellOwnerHubForTests({
        now: () => currentTime,
        logger: { error() {} },
      });
      const identity = makeReloadShellIdentity(`early-deadline-${phase}`, realpathSync('/tmp'));
      const initial = hub.beginActivation(identity, 'startup', 'a'.repeat(32));
      const lease = hub.commitActivation(initial, adapter('a'.repeat(32), []));
      const stops: string[] = [];
      const execution = fakeExecution(`early-${phase}`, (kind) => stops.push(kind));
      hub.registerExecution(lease, execution);
      hub.markAdmissionCommitted(lease, execution);
      hub.beginReloadHandoff(lease);
      const claim = hub.beginActivation(identity, 'reload', 'b'.repeat(32));
      const expiresAt = 1000 + RELOAD_SHELL_HANDOFF_TIMEOUT_MS;
      assert.equal(claim.expiresAt, expiresAt);
      if (phase === 'handoff') hub.abortActivation(claim, new Error('synthetic import failure'));

      // Dispatch the original timer one clock millisecond before the deadline.
      currentTime = expiresAt - 1;
      t.mock.timers.tick(RELOAD_SHELL_HANDOFF_TIMEOUT_MS);
      assert.deepEqual(stops, []);
      assert.equal(inspectReloadShellOwnerForTests(hub, identity).phase, phase);
      assert.equal(inspectReloadShellOwnerForTests(hub, identity).expiresAt, expiresAt);

      // A backward clock adjustment makes the replacement callback early too.
      currentTime = expiresAt - 2;
      t.mock.timers.tick(1);
      assert.deepEqual(stops, []);
      assert.equal(inspectReloadShellOwnerForTests(hub, identity).expiresAt, expiresAt);
      currentTime = expiresAt;
      t.mock.timers.tick(2);
      assert.deepEqual(stops, ['handoff_expired']);
      await execution.terminal;
      assert.equal(execution.phase, 'released');
      assert.equal(execution.task.status, 'failed');
      assert.equal(execution.task.terminalPublicationAbandonReason, 'reload_handoff_expired');
      assert.equal(inspectReloadShellOwnerForTests(hub, identity).phase, undefined);
      assert.throws(
        () => hub.commitActivation(claim, adapter('b'.repeat(32), [])),
        (error: unknown) =>
          error instanceof ReloadSurvivalError && error.code === 'pi_bg_reload_owner_stale_claim',
      );
    });
  }

  void it('releases an orphaned slot when terminal settlement follows a bounded stop failure', async () => {
    const logs: string[] = [];
    let nonce = 0;
    const hub = createReloadShellOwnerHubForTests({
      handoffTimeoutMs: 20,
      randomNonce: () => String(++nonce).padStart(32, '0'),
      logger: { error: (...args: unknown[]) => logs.push(args.map(String).join(' ')) },
    });
    const identity = makeReloadShellIdentity('late-terminal-release', realpathSync('/tmp'));
    const claim = hub.beginActivation(identity, 'startup', 'a'.repeat(32));
    const lease = hub.commitActivation(claim, adapter('a'.repeat(32), []));
    const task = fakeTask('owner-late-terminal');
    let sink: ReloadShellOwnerEventSinkV1 | undefined;
    let resolveTerminal: (settled: BgTask) => void = () => {};
    const terminal = new Promise<BgTask>((resolve) => {
      resolveTerminal = resolve;
    });
    let released = false;
    let stopCalls = 0;
    const execution: ReloadableShellExecutionV1 = {
      protocol: RELOAD_SHELL_OWNER_PROTOCOL,
      launchNonce: task.reloadSurvival?.launchNonce ?? 'owner-late-terminal',
      completionId: `${task.id}:1`,
      task,
      child: undefined,
      outputStream: undefined,
      spawnedAt: task.startTime,
      outputCapBytes: 1024,
      terminal,
      phase: 'running',
      admissionCommitted: false,
      notificationState: 'disabled',
      commitInitialMetadata: () => Promise.resolve(),
      failAdmission() {},
      setOwnerEventSink(next) {
        sink = next;
      },
      markAdmissionCommitted(generation, handoffCount) {
        execution.admissionCommitted = true;
        if (task.reloadSurvival !== undefined) {
          task.reloadSurvival.leaseGeneration = generation;
          task.reloadSurvival.handoffCount = handoffCount;
        }
      },
      updateLeaseAudit() {},
      abandonReloadHandoff() {
        task.terminalPublicationState = 'abandoned';
        task.terminalPublicationAbandonReason = 'reload_handoff_expired';
      },
      beginNotification() {
        return undefined;
      },
      finishNotification() {},
      releaseResources() {
        released = true;
        execution.phase = 'released';
      },
      async requestStop() {
        stopCalls += 1;
        execution.phase = 'stop_requested';
        setTimeout(() => {
          task.status = 'failed';
          execution.phase = 'terminal';
          resolveTerminal(task);
          sink?.onTerminal(execution);
        }, 70);
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error('synthetic bounded stop wait expired before terminal close');
      },
    };
    task.reloadExecution = execution;
    hub.registerExecution(lease, execution);
    hub.markAdmissionCommitted(lease, execution);
    hub.beginReloadHandoff(lease);

    await new Promise((resolve) => setTimeout(resolve, 130));

    assert.equal(stopCalls, 1, 'deadline cleanup must request one stop');
    assert.equal(task.status, 'failed');
    assert.equal(execution.phase, 'released');
    assert.equal(released, true);
    assert.deepEqual(inspectReloadShellOwnerForTests(hub, identity).executions, []);
    assert.match(logs.join('\n'), /could not settle.*bounded stop wait expired/u);

    const replacement = hub.beginActivation(identity, 'startup', 'b'.repeat(32));
    const replacementLease = hub.commitActivation(
      replacement,
      adapter('b'.repeat(32), []),
    );
    hub.releaseActivation(replacementLease);
  });

  void it('rejects a competing same-identity activation and incompatible global protocol loudly', () => {
    const hub = createReloadShellOwnerHubForTests();
    const identity = makeReloadShellIdentity('conflict-test', realpathSync('/tmp'));
    const claim = hub.beginActivation(identity, 'startup', '6'.repeat(32));
    const lease = hub.commitActivation(claim, adapter('6'.repeat(32), []));
    assert.throws(
      () => hub.beginActivation(identity, 'startup', '7'.repeat(32)),
      (error: unknown) =>
        error instanceof ReloadSurvivalError &&
        error.code === 'pi_bg_reload_owner_activation_conflict',
    );
    hub.releaseActivation(lease);

    const previous = Reflect.get(globalThis, RELOAD_SHELL_OWNER_SYMBOL);
    try {
      Reflect.set(globalThis, RELOAD_SHELL_OWNER_SYMBOL, { protocol: 'future-owner.v2' });
      assert.throws(
        () => getProcessReloadShellOwnerV1(),
        (error: unknown) =>
          error instanceof ReloadSurvivalError &&
          error.code === 'pi_bg_reload_owner_protocol_incompatible',
      );
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalThis, RELOAD_SHELL_OWNER_SYMBOL);
      else Reflect.set(globalThis, RELOAD_SHELL_OWNER_SYMBOL, previous);
    }
  });

  void it('writes stdout/stderr bytes verbatim without interpreting telemetry-shaped output', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bg-owner-raw-'));
    const task = fakeTask('owner-raw');
    task.cwd = directory;
    task.outputAbsPath = join(directory, 'raw.output');
    task.metadataAbsPath = join(directory, 'raw.json');
    const hub = createReloadShellOwnerHubForTests();
    const identity = makeReloadShellIdentity('raw-output-test', realpathSync(directory));
    const claim = hub.beginActivation(identity, 'startup', 'c'.repeat(32));
    const events: string[] = [];
    const lease = hub.commitActivation(claim, adapter('c'.repeat(32), events));
    const child = Object.assign(new EventEmitter(), {
      pid: 101,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill() {
        throw new Error('ordinary output must not stop the child');
      },
    });
    const execution = createReloadableShellExecutionV1({
      task,
      identity,
      lease,
      launchNonce: 'd'.repeat(32),
      invocation: { shell: '/bin/sh', args: ['-c', task.command], windowsVerbatimArguments: false },
      spawn: () => child,
      platform: 'linux',
      maxOutputBytes: 4096,
      killGraceMs: 20,
      stopWaitMs: 100,
    });
    hub.registerExecution(lease, execution);
    try {
      await execution.commitInitialMetadata();
      hub.markAdmissionCommitted(lease, execution);
      const chunks: Array<{ stream: EventEmitter; data: Buffer | string }> = [
        { stream: child.stdout, data: '{"type":"background-task-telemetry",' },
        {
          stream: child.stdout,
          data: '"contextUsage":{"tokens":42,"contextWindow":1000},"tokenUsage":{"input":42},"toolUsage":{"total":1,"byName":{"bash":1}},"model":"test/model"}\n',
        },
        { stream: child.stderr, data: '{"type":"background-task-context-usage","tokens":7,"contextWindow":100}\n' },
        { stream: child.stderr, data: '<background-task-context-usage><tokens>8</tokens>' },
        { stream: child.stderr, data: '<context-window>100</context-window></background-task-context-usage>\n' },
        {
          stream: child.stdout,
          data: '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"plain JSON"}]}}\n',
        },
        { stream: child.stdout, data: '{"type":"background-task-activity","kind":"tool_start","tool":"bash"}\n' },
        { stream: child.stderr, data: Buffer.from([0xff, 0x00, 0xfe]) },
      ];
      const expected = Buffer.concat(
        chunks.map(({ data }) => Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')),
      );
      for (const { stream, data } of chunks) stream.emit('data', data);
      child.emit('close', 0, null);
      await execution.terminal;

      assert.equal(task.status, 'completed');
      assert.equal(task.bytesWritten, expected.length);
      assert.deepEqual(readFileSync(task.outputAbsPath), expected);
      assert.equal(task.reloadSurvival?.schemaVersion, 'pi-background-shell.reload-shell.v1');
      assert.deepEqual(events, ['bound:1', 'changed:owner-raw', 'terminal:owner-raw']);
      const metadata = JSON.parse(readFileSync(task.metadataAbsPath, 'utf8')) as Record<string, unknown>;
      assert.equal(metadata['status'], 'completed');
      for (const field of [
        'isAgent', 'contextUsage', 'tokenUsage', 'toolUsage', 'model',
        'contextUsageBuffer', 'agentStdoutBuffer',
      ]) {
        assert.equal(Object.hasOwn(task, field), false, `output must not create task.${field}`);
        assert.equal(Object.hasOwn(metadata, field), false, `output must not create metadata.${field}`);
      }
    } finally {
      child.emit('close', 0, null);
      await execution.terminal;
      hub.releaseExecution(lease, execution);
      hub.releaseActivation(lease);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  void it('never adopts copied metadata or an unrelated live pid into a fresh owner', () => {
    const hub = createReloadShellOwnerHubForTests();
    const identity = makeReloadShellIdentity('copy-test', realpathSync('/tmp'));
    const copied = JSON.parse(JSON.stringify(fakeTask('copied-json'))) as Record<string, unknown>;
    assert.equal(copied['pid'], undefined);
    const claim = hub.beginActivation(identity, 'startup', '8'.repeat(32));
    assert.deepEqual(claim.executions, []);
    const lease = hub.commitActivation(claim, adapter('8'.repeat(32), []));
    assert.deepEqual(inspectReloadShellOwnerForTests(hub, identity).executions, []);
    hub.releaseActivation(lease);
  });
});
