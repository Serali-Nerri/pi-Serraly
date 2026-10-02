import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime,
  SessionManager, SettingsManager,
  type ExtensionRunner, type ExtensionUIContext,
} from '@earendil-works/pi-coding-agent';
import { matchesKey, type KeyId } from '@earendil-works/pi-tui';
import { isolatePiEnvironment } from '../helpers/normalize.js';
import { BackgroundTaskRegistry } from '../../src/core/registry.js';
import type { BgTask } from '../../src/core/common.js';
import backgroundTasksExtension from '../../src/extension.js';

const tools = ['bg_kill', 'bg_logs', 'bg_run', 'bg_status'];
const commands = ['bg', 'bg-clear', 'bg-tasks', 'jobs', 'kill', 'logs', 'tasks'];

async function harness(shortcut?: string, ownShiftDown = false, compiled = false) {
  const root = await mkdtemp(join(tmpdir(), 'pi-bg-dock-sdk-'));
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const restore = isolatePiEnvironment(agentDir, { PI_BG_DOCK_SHORTCUT: shortcut });
  const eventBus = createEventBus();
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, eventBus,
    additionalExtensionPaths: compiled ? [resolve(import.meta.dirname, '../..', 'dist/extensions/background-tasks.js')] : [],
    extensionFactories: [
      ...(compiled ? [] : [backgroundTasksExtension]),
      ...(ownShiftDown ? [(pi: Parameters<typeof backgroundTasksExtension>[0]) => {
        pi.registerShortcut('shift+down', {
          description: 'Test-only independent shortcut owner',
          handler: () => { eventBus.emit('test:shift-down', {}); },
        });
      }] : []),
    ],
    noExtensions: true, noSkills: true, noPromptTemplates: true,
    noContextFiles: true, noThemes: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null });
  const { session } = await createAgentSession({
    cwd, agentDir, resourceLoader: loader, modelRuntime, settingsManager,
    sessionManager: SessionManager.inMemory(cwd), noTools: 'builtin',
  });
  await session.bindExtensions({ mode: 'tui', onError: (error) => assert.fail(error.error) });
  const tasks: BgTask[] = [];
  const startTask = BackgroundTaskRegistry.prototype.startTask;
  BackgroundTaskRegistry.prototype.startTask = async function (...args) {
    const task = await startTask.apply(this, args);
    tasks.push(task);
    return task;
  };
  const close = async () => {
    try {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      // Shutdown kills children before all notification-metadata continuations finish.
      // Drain the actual serialized writes, not a fixed sleep, before deleting fixtures.
      for (const task of tasks) {
        let chain: Promise<void> | undefined;
        do {
          chain = task.metadataWriteChain;
          await chain;
        } while (task.metadataWriteChain !== chain);
      }
    } finally {
      BackgroundTaskRegistry.prototype.startTask = startTask;
      session.dispose(); restore(); await rm(root, { recursive: true, force: true });
    }
  };
  return { session, eventBus, close };
}

async function dispatch(runner: ExtensionRunner, data: string): Promise<KeyId | undefined> {
  for (const [key, shortcut] of runner.getShortcuts({})) {
    if (!matchesKey(data, key)) continue;
    await shortcut.handler(runner.createContext());
    return key;
  }
  return undefined;
}

function statusUi(base: ExtensionUIContext, calls: { value: number }, statuses: string[]): ExtensionUIContext {
  return {
    ...base,
    setStatus: (_key, text) => { if (text !== undefined) statuses.push(text); },
    custom: (async () => { calls.value += 1; return undefined; }) as ExtensionUIContext['custom'],
  };
}

void describe('shell-only registration and dock SDK integration', { concurrency: false }, () => {
  for (const compiled of [false, true]) {
    void it(`opens the centered responsive overlay with the shared height budget (${compiled ? 'compiled' : 'source'})`, async () => {
      const h = await harness('off', false, compiled);
      const captured: Array<Parameters<ExtensionUIContext['custom']>[1]> = [];
      h.session.extensionRunner.setUIContext({
        ...h.session.extensionRunner.getUIContext(),
        custom: (async (
          _factory: Parameters<ExtensionUIContext['custom']>[0],
          options: Parameters<ExtensionUIContext['custom']>[1],
        ) => {
          captured.push(options);
          return undefined;
        }) as ExtensionUIContext['custom'],
      }, 'tui');
      try {
        const command = h.session.extensionRunner.getRegisteredCommands().find((c) => c.invocationName === 'tasks');
        assert.ok(command);
        await command.handler('', h.session.extensionRunner.createCommandContext());
        assert.deepEqual(captured, [{
          overlay: true,
          overlayOptions: {
            anchor: 'center',
            width: '90%',
            minWidth: 40,
            maxHeight: '80%',
            margin: 1,
          },
        }]);
      } finally { await h.close(); }
    });

    void it(`loads exactly four tools/seven commands (${compiled ? 'compiled' : 'source'}) and rebuilds shortcuts on reload`, async () => {
      const h = await harness(undefined, false, compiled);
      try {
        const inventory = () => {
          assert.deepEqual(h.session.getActiveToolNames(), []);
          assert.deepEqual(
            h.session.getAllTools().filter((tool) => tools.includes(tool.name)).map((tool) => `${tool.name}:${tool.exposure}`).sort(),
            tools.map((name) => `${name}:deferred`),
          );
          assert.deepEqual(h.session.extensionRunner.getRegisteredCommands().map((c) => c.invocationName).sort(), commands);
          assert.equal(h.session.extensionRunner.hasHandlers('before_agent_start'), false);
        };
        inventory();
        assert.deepEqual([...h.session.extensionRunner.getShortcuts({}).keys()].sort(), ['ctrl+alt+c', 'shift+down']);
        process.env['PI_BG_DOCK_SHORTCUT'] = 'off';
        await h.session.reload();
        inventory();
        assert.deepEqual([...h.session.extensionRunner.getShortcuts({}).keys()], ['ctrl+alt+c']);
        process.env['PI_BG_DOCK_SHORTCUT'] = 'ctrl+alt+b';
        await h.session.reload();
        inventory();
        assert.deepEqual([...h.session.extensionRunner.getShortcuts({}).keys()].sort(), ['ctrl+alt+b', 'ctrl+alt+c']);
      } finally { await h.close(); }
    });
  }

  void it('avoids an independent Shift+Down conflict and dispatches encoded keys to their owners', async () => {
    const h = await harness('ctrl+alt+b', true);
    const events: unknown[] = [];
    const off = h.eventBus.on('test:shift-down', (event) => events.push(event));
    const calls = { value: 0 };
    h.session.extensionRunner.setUIContext(statusUi(h.session.extensionRunner.getUIContext(), calls, []), 'tui');
    try {
      assert.equal(h.session.extensionRunner.getShortcutDiagnostics().some((d) => /shortcut conflict/i.test(d.message)), false);
      assert.equal(await dispatch(h.session.extensionRunner, '\u001b[1;2B'), 'shift+down');
      assert.equal(events.length, 1);
      assert.equal(calls.value, 0);
      assert.equal(await dispatch(h.session.extensionRunner, '\u001b\u0002'), 'ctrl+alt+b');
      assert.equal(calls.value, 1);
    } finally { off(); await h.close(); }
  });

  void it('keeps /tasks and /bg-tasks usable when the dock shortcut is off', async () => {
    const h = await harness('off', true);
    const calls = { value: 0 };
    h.session.extensionRunner.setUIContext(statusUi(h.session.extensionRunner.getUIContext(), calls, []), 'tui');
    try {
      assert.deepEqual([...h.session.extensionRunner.getShortcuts({}).keys()].sort(), ['ctrl+alt+c', 'shift+down']);
      assert.equal(await dispatch(h.session.extensionRunner, '\u001b\u0002'), undefined);
      for (const name of ['tasks', 'bg-tasks']) {
        const command = h.session.extensionRunner.getRegisteredCommands().find((c) => c.invocationName === name);
        assert.ok(command);
        await command.handler('', h.session.extensionRunner.createCommandContext());
      }
      assert.equal(calls.value, 2);
    } finally { await h.close(); }
  });

  void it('derives footer hints from default, alternate, and off shortcut configuration', async () => {
    for (const [shortcut, expected] of [[undefined, 'Shift↓'], ['ctrl+alt+b', 'CtrlAltB'], ['off', '/tasks']] as const) {
      const h = await harness(shortcut);
      const statuses: string[] = [];
      h.session.extensionRunner.setUIContext(statusUi(h.session.extensionRunner.getUIContext(), { value: 0 }, statuses), 'tui');
      try {
        const run = h.session.getToolDefinition('bg_run');
        assert.ok(run);
        await run.execute('footer-run', {
          name: 'Shell footer', command: `node -e ${JSON.stringify('setTimeout(() => {}, 10000)')}`,
          notifyOnCompletion: false, triggerOnCompletion: false,
        }, undefined, undefined, h.session.extensionRunner.createToolContext('footer-run', undefined));
        assert.ok(statuses.some((status) => status.includes(expected)), statuses.join(' | '));
      } finally { await h.close(); }
    }
  });
});
