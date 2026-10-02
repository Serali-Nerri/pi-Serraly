import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime,
  SessionManager, SettingsManager, type AgentSession,
} from '@earendil-works/pi-coding-agent';
import { isolatePiEnvironment } from '../helpers/normalize.js';

/** A real, counted SDK binding and awaited extension shutdown; no model call. */
export async function loadRuntime(entry: string) {
  const root = await mkdtemp(join(tmpdir(), 'pi-bg-packed-host-'));
  const cwd = join(root, 'project'), agentDir = join(root, 'agent');
  await mkdir(cwd); await mkdir(agentDir);
  const restore = isolatePiEnvironment(agentDir, {
    PI_BG_POSIX_SHELL: 'sh', PI_BG_POSIX_SHELL_PATH: undefined,
    PI_BG_SHELL: 'cmd', PI_BG_SHELL_PATH: undefined, PI_BG_DOCK_SHORTCUT: 'off',
    PI_BG_MAX_OUTPUT_BYTES: undefined,
  });
  const settingsManager = SettingsManager.inMemory(), eventBus = createEventBus();
  const errors: Array<{ event: string; error: string }> = [];
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, eventBus, additionalExtensionPaths: [entry],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
  });
  let session: AgentSession | undefined;
  const close = async (): Promise<void> => {
    try {
      if (session !== undefined) {
        await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
        session.dispose();
        session = undefined;
      }
      assert.deepEqual(errors, [], 'no swallowed extension lifecycle errors');
    } finally { restore(); await rm(root, { recursive: true, force: true }); }
  };
  try {
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null });
    const created = await createAgentSession({
      cwd, agentDir, resourceLoader: loader, settingsManager, modelRuntime,
      sessionManager: SessionManager.inMemory(cwd), noTools: 'builtin',
    });
    session = created.session;
    await session.bindExtensions({ mode: 'json', onError: (error) => errors.push(error) });
    const tools = loader.getExtensions().extensions.flatMap((extension) => [...extension.tools.values()].map((tool) => tool.definition));
    return { session, tools, loader, eventBus, cwd, agentDir, close };
  } catch (error) { await close(); throw error; }
}

export function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}
export function stringField(value: unknown, key: string): string {
  const field = record(value)[key];
  assert.equal(typeof field, 'string');
  if (typeof field !== 'string') throw new Error(`${key} must be string`);
  return field;
}
/** Wait on the terminal event, never status/log polling. */
export function nextTerminal(bus: ReturnType<typeof createEventBus>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { unsubscribe(); reject(new Error('terminal event deadline')); }, 15_000);
    const unsubscribe = bus.on('pi-background-shell:terminal:v2', (event) => {
      clearTimeout(timeout); unsubscribe(); resolve(record(event)['task']);
    });
  });
}
