import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ModelRuntime,
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type EventBus,
  type ExtensionAPI,
  type ExtensionUIContext,
} from '@earendil-works/pi-coding-agent';
import { parseJsonText, type BgTaskSnapshot, type TaskStatus } from '../../src/core/common.js';
import { BackgroundTaskRegistry, STOP_WAIT_MS } from '../../src/core/registry.js';
import {
  BG_EXTENSION_CAPABILITIES,
  BG_REQUEST_CHANNEL,
  BG_REQUEST_SCHEMA,
  BG_RESPONSE_CHANNEL,
  BG_RESPONSE_SCHEMA,
  BG_TERMINAL_CHANNEL,
  BG_TERMINAL_SCHEMA,
  type BackgroundTaskExtensionResponse,
  type BackgroundTaskExtensionTerminal,
} from '../../src/core/extension-api.js';
import backgroundTasksExtension, { BG_RUN_DESCRIPTION } from '../../src/extension.js';
import { installFakeCli } from '../helpers/fake-cli.js';
import { isolatePiEnvironment } from '../helpers/normalize.js';

const extensionPath = resolve(import.meta.dirname, '../..', 'extensions/background-tasks.ts');
const roots: string[] = [];
const restorers: Array<() => void> = [];

interface SdkHarnessOptions {
  eventBus?: EventBus | undefined;
}

async function harness(options: SdkHarnessOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-bg-sdk-'));
  roots.push(root);
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  restorers.push(isolatePiEnvironment(agentDir));
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [extensionPath],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    noThemes: true,
    ...(options.eventBus === undefined ? {} : { eventBus: options.eventBus }),
  });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: null,
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    modelRuntime,
    noTools: 'builtin',
  });
  await session.bindExtensions({ mode: 'tui', onError: (error) => assert.fail(error.error) });
  return { session, cwd, modelRuntime };
}

type JsonObject = Record<PropertyKey, unknown>;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface TestToolContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface TestToolDetails extends JsonObject {
  task?: unknown;
  tasks?: unknown;
}

interface TestToolResult {
  content: TestToolContent[];
  details: TestToolDetails;
}

interface CustomNotificationEntry {
  type: 'custom_message';
  customType: string;
  content: string;
  details: JsonObject;
}

interface PreparedBgRunArgs extends JsonObject {
  name: string;
  command: string;
}

interface UiNotification {
  message: string;
  type?: 'info' | 'warning' | 'error';
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === 'running' || value === 'completed' || value === 'failed' || value === 'killed';
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject(text: string, message: string): JsonObject {
  const parsed = parseJsonText(text);
  assert.ok(isJsonObject(parsed), message);
  return parsed;
}

function requiredJsonObject(value: unknown, message: string): JsonObject {
  assert.ok(isJsonObject(value), message);
  return value;
}

function isBgTaskSnapshot(value: unknown): value is BgTaskSnapshot {
  return (
    isJsonObject(value) &&
    typeof value['id'] === 'string' &&
    typeof value['command'] === 'string' &&
    isTaskStatus(value['status']) &&
    typeof value['outputPath'] === 'string' &&
    typeof value['cwd'] === 'string' &&
    typeof value['startTime'] === 'number' &&
    typeof value['bytesWritten'] === 'number' &&
    typeof value['notified'] === 'boolean' &&
    typeof value['notifyOnCompletion'] === 'boolean' &&
    typeof value['triggerOnCompletion'] === 'boolean'
  );
}

function isTestToolContent(value: unknown): value is TestToolContent {
  return isJsonObject(value) && typeof value['type'] === 'string';
}

function isTestToolResult(value: unknown): value is TestToolResult {
  return (
    isJsonObject(value) &&
    Array.isArray(value['content']) &&
    value['content'].every(isTestToolContent) &&
    isJsonObject(value['details'])
  );
}

function isCustomNotificationEntry(value: unknown): value is CustomNotificationEntry {
  return (
    isJsonObject(value) &&
    value['type'] === 'custom_message' &&
    value['customType'] === 'background-task-notification' &&
    typeof value['content'] === 'string' &&
    isJsonObject(value['details'])
  );
}

function isPreparedBgRunArgs(value: unknown): value is PreparedBgRunArgs {
  return (
    isJsonObject(value) &&
    typeof value['name'] === 'string' &&
    typeof value['command'] === 'string'
  );
}

function requiredTask(value: unknown, message: string): BgTaskSnapshot {
  assert.ok(isBgTaskSnapshot(value), message);
  return value;
}

function taskFromResult(result: TestToolResult): BgTaskSnapshot {
  return requiredTask(result.details.task, 'tool result should include a background task snapshot');
}

function tasksFromResult(result: TestToolResult): BgTaskSnapshot[] {
  const tasks = result.details.tasks;
  assert.ok(Array.isArray(tasks), 'tool result should include a task list');
  return tasks.map((task) =>
    requiredTask(task, 'task list entry should be a background task snapshot'),
  );
}

function firstTask(result: TestToolResult): BgTaskSnapshot {
  const task = tasksFromResult(result)[0];
  assert.ok(task, 'tool result should include at least one background task snapshot');
  return task;
}

function resultText(result: TestToolResult): string {
  const content = result.content[0];
  assert.ok(content, 'tool result should include a content item');
  if (typeof content.text !== 'string') {
    throw new Error('tool result first content item should include text');
  }
  return content.text;
}

function requiredPrepared(value: unknown): PreparedBgRunArgs {
  assert.ok(
    isPreparedBgRunArgs(value),
    'prepared bg_run arguments should satisfy the bg_run schema',
  );
  return value;
}

async function exec(session: AgentSession, name: string, params: unknown): Promise<TestToolResult> {
  const tool = session.getToolDefinition(name);
  assert.ok(tool, `missing tool ${name}`);
  const result: unknown = await tool.execute(
    `call-${name}`,
    params,
    undefined,
    undefined,
    session.extensionRunner.createToolContext(`call-${name}`, undefined),
  );
  assert.ok(isTestToolResult(result), `${name} should return a tool result object`);
  return result;
}

async function wait(session: AgentSession, id: string, iterations = 100): Promise<BgTaskSnapshot> {
  for (let i = 0; i < iterations; i++) {
    const s = await exec(session, 'bg_status', { taskId: id });
    const t = firstTask(s);
    if (t.status !== 'running') return t;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timeout');
}

function customNotifications(session: AgentSession): CustomNotificationEntry[] {
  const entries: readonly unknown[] = session.sessionManager.getEntries();
  return entries.filter(isCustomNotificationEntry);
}

async function readJsonEventually(path: string): Promise<JsonObject> {
  let last = '';
  for (let i = 0; i < 20; i++) {
    last = await readFile(path, 'utf8').catch(() => '');
    if (last.trim()) return parseJsonObject(last, 'metadata JSON should be an object');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return parseJsonObject(last, 'metadata JSON should be an object');
}

async function readJsonWithStatus(path: string, status: string): Promise<JsonObject> {
  let metadata = await readJsonEventually(path);
  for (let attempt = 0; attempt < 40; attempt++) {
    metadata = await readJsonEventually(path);
    if (metadata['status'] === status) return metadata;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return metadata;
}

function requireEventResponse(value: unknown): BackgroundTaskExtensionResponse {
  assert.ok(isJsonObject(value), 'EventBus response must be an object');
  assert.equal(value['schema_version'], BG_RESPONSE_SCHEMA);
  assert.equal(typeof value['request_id'], 'string');
  assert.equal(typeof value['operation'], 'string');
  assert.equal(typeof value['ok'], 'boolean');
  const hasResult = Object.prototype.hasOwnProperty.call(value, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(value, 'error');
  assert.notEqual(
    hasResult,
    hasError,
    'EventBus response must contain exactly one of result/error',
  );
  return value as BackgroundTaskExtensionResponse;
}

function requireOkResult(response: BackgroundTaskExtensionResponse): unknown {
  assert.equal(response.ok, true, response.ok ? 'ok' : response.error);
  return response.ok ? response.result : undefined;
}

function requireTerminal(value: unknown): BackgroundTaskExtensionTerminal {
  assert.ok(isJsonObject(value), 'EventBus terminal must be an object');
  assert.deepEqual(Object.keys(value).sort(), ['schema_version', 'task']);
  assert.equal(value['schema_version'], BG_TERMINAL_SCHEMA);
  return { schema_version: BG_TERMINAL_SCHEMA, task: requiredTask(value['task'], 'terminal task') };
}

// Kill replies await stopTask, including TERM-to-KILL grace and process-tree
// proof. POSIX covers that full budget; Windows also allows for helper startup.
const EVENT_RESPONSE_TIMEOUT_MS = process.platform === 'win32' ? 10_000 : STOP_WAIT_MS + 500;

function waitForEventResponse(
  eventBus: EventBus,
  requestId: string,
): Promise<BackgroundTaskExtensionResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for EventBus response ${requestId}`));
    }, EVENT_RESPONSE_TIMEOUT_MS);
    const unsubscribe = eventBus.on(BG_RESPONSE_CHANNEL, (data) => {
      const response = requireEventResponse(data);
      if (response.request_id !== requestId) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(response);
    });
  });
}

async function emitEventRequest(
  eventBus: EventBus,
  requestId: string,
  operation: string,
  payload: Record<string, unknown>,
): Promise<BackgroundTaskExtensionResponse> {
  const pending = waitForEventResponse(eventBus, requestId);
  eventBus.emit(BG_REQUEST_CHANNEL, {
    schema_version: BG_REQUEST_SCHEMA,
    request_id: requestId,
    operation,
    payload,
  });
  return pending;
}

// Terminal publication follows tree-stop completion and the correlated response.
const TERMINAL_SNAPSHOT_POLL_MS = 25;
const TERMINAL_SNAPSHOT_ATTEMPTS = EVENT_RESPONSE_TIMEOUT_MS / TERMINAL_SNAPSHOT_POLL_MS;

async function waitForTerminalSnapshot(
  terminals: readonly BgTaskSnapshot[],
  taskId: string,
): Promise<BgTaskSnapshot> {
  for (let attempt = 0; attempt < TERMINAL_SNAPSHOT_ATTEMPTS; attempt++) {
    const terminal = terminals.find((task) => task.id === taskId);
    if (terminal) return terminal;
    await new Promise((resolve) => setTimeout(resolve, TERMINAL_SNAPSHOT_POLL_MS));
  }
  throw new Error(`timed out waiting for terminal ${taskId}`);
}

async function cleanupRoot(root: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!(error instanceof Error) || !/ENOTEMPTY/.test(error.message) || attempt === 4)
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

afterEach(async () => {
  for (const r of roots.splice(0)) await cleanupRoot(r);
  for (const restore of restorers.splice(0).reverse()) restore();
});

function makeStatusUi(
  baseUi: ExtensionUIContext,
  statuses: Array<string | undefined>,
  notifications: UiNotification[],
): ExtensionUIContext {
  return {
    ...baseUi,
    notify: (message, type) => {
      const notification: UiNotification = { message };
      if (type !== undefined) notification.type = type;
      notifications.push(notification);
    },
    setStatus: (_key, text) => {
      statuses.push(text);
    },
  };
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}

void describe('sdk', () => {
  void it('registers commands, tools, shortcuts, renderers, and runs with output and metadata files', async () => {
    const { session, cwd } = await harness();
    try {
      // These four are deferred: registered, but never declared until a loader loads them.
      for (const tool of ['bg_run', 'bg_status', 'bg_logs', 'bg_kill']) {
        assert.ok(session.getToolDefinition(tool), tool);
        assert.equal(
          session.getAllTools().find((definition) => definition.name === tool)?.exposure,
          'deferred',
          tool,
        );
      }
      const bgRunTool = session.getToolDefinition('bg_run');
      assert.ok(bgRunTool, 'bg_run tool should be registered');
      const bgRunParams: unknown = bgRunTool.parameters;
      assert.ok(isJsonObject(bgRunParams), 'bg_run schema should be an object');
      const required = bgRunParams['required'];
      assert.deepEqual(required, ['name', 'command']);
      const properties = requiredJsonObject(bgRunParams['properties'], 'bg_run properties');
      assert.deepEqual(Object.keys(properties).sort(), [
        'command', 'description', 'name', 'notifyOnCompletion', 'surviveReload',
        'timeoutSeconds', 'triggerOnCompletion',
      ]);
      assert.equal(bgRunParams['additionalProperties'], false);
      assert.deepEqual(session.getActiveToolNames(), [], 'deferred tools must not be declared');
      for (const name of ['bg_kill', 'bg_logs', 'bg_run', 'bg_status']) {
        const tool = session.getToolDefinition(name);
        assert.ok(tool);
        assert.equal(Reflect.get(tool, 'promptSnippet'), undefined);
        assert.equal(Reflect.get(tool, 'promptGuidelines'), undefined);
        assert.doesNotMatch(JSON.stringify(tool.parameters), /promptSnippet|promptGuidelines/);
      }
      assert.equal(session.extensionRunner.hasHandlers('before_agent_start'), false);
      const cmds = session.extensionRunner.getRegisteredCommands().map((c) => c.invocationName);
      for (const cmd of [
        'bg',
        'jobs',
        'logs',
        'kill',
        'tasks',
        'bg-tasks',
        'bg-clear',
      ])
        assert.ok(cmds.includes(cmd), cmd);
      assert.equal(cmds.length, 7);
      assert.equal(cmds.includes('bg-update'), false);
      assert.ok(session.extensionRunner.getMessageRenderer('background-task-notification'));
      const shortcuts = session.extensionRunner.getShortcuts({});
      assert.ok(shortcuts.has('shift+down'));
      assert.ok(shortcuts.has('ctrl+alt+c'));

      const r = await exec(session, 'bg_run', {
        name: 'SDK Echo',
        command: 'echo sdk-ok',
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      const t = await wait(session, taskFromResult(r).id);
      assert.equal(t.status, 'completed');
      assert.equal(t.name, 'SDK Echo');
      assert.equal(Object.hasOwn(t, 'isAgent'), false);
      assert.ok(existsSync(join(cwd, t.outputPath)));
      const metadataPath = join(cwd, t.outputPath.replace(/\.output$/, '.json'));
      assert.ok(existsSync(metadataPath));
      const metadata = await readJsonWithStatus(metadataPath, 'completed');
      assert.equal(metadata['status'], 'completed');
      assert.equal(metadata['name'], 'SDK Echo');
      assert.equal(Object.hasOwn(metadata, 'isAgent'), false);
      const logs = await exec(session, 'bg_logs', { taskId: t.id, maxBytes: 100 });
      assert.match(resultText(logs), /sdk-ok/);
      await assert.rejects(() => exec(session, 'bg_kill', { taskId: t.id }), /not running/);
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  void it('exposes description-only event-driven declarations and truthful launch receipts', async () => {
    const { session } = await harness();
    try {
      const ctx = session.extensionRunner.createContext();
      const systemPrompt = ctx.getSystemPrompt();
      assert.doesNotMatch(systemPrompt, /pi_background_shell_policy|activation shell policy|Shell executable:/);
      assert.doesNotMatch(systemPrompt, /Do not call sleep, bg_status, or bg_logs merely to wait/);
      assert.equal(session.extensionRunner.hasHandlers('before_agent_start'), false);

      const bgRun = session.getToolDefinition('bg_run');
      const bgStatus = session.getToolDefinition('bg_status');
      const bgLogs = session.getToolDefinition('bg_logs');
      assert.ok(bgRun && bgStatus && bgLogs, 'background tools should be registered');
      assert.ok(bgRun.description.startsWith(BG_RUN_DESCRIPTION));
      assert.match(bgRun.description, /do not poll or sleep merely to wait/);
      assert.match(bgRun.description, /Shell executable: .*; args: /);
      assert.match(bgStatus.description, /not a waiting primitive/);
      assert.match(bgLogs.description, /not a waiting primitive/);

      // shellQuote emits POSIX single quotes, which cmd.exe does not understand.
      const longCommand = `node -e ${JSON.stringify('setTimeout(() => {}, 10000)')}`;
      const cases = [
        {
          name: 'Default Delivery',
          notifyOnCompletion: undefined,
          triggerOnCompletion: undefined,
          expectedNotify: true,
          expectedTrigger: true,
          expected: [
            'Terminal notification: enabled.',
            'Automatic steering / wake-up: enabled.',
          ],
        },
        {
          name: 'Notification Only',
          notifyOnCompletion: true,
          triggerOnCompletion: false,
          expectedNotify: true,
          expectedTrigger: false,
          expected: [
            'Terminal notification: enabled.',
            'Automatic steering / wake-up: disabled.',
          ],
        },
        {
          name: 'Disabled Requested Wake',
          notifyOnCompletion: false,
          triggerOnCompletion: true,
          expectedNotify: false,
          expectedTrigger: true,
          expected: [
            'Terminal notification: disabled.',
            'Automatic steering / wake-up: disabled.',
          ],
        },
        {
          name: 'Manual Delivery',
          notifyOnCompletion: false,
          triggerOnCompletion: false,
          expectedNotify: false,
          expectedTrigger: false,
          expected: [
            'Terminal notification: disabled.',
            'Automatic steering / wake-up: disabled.',
          ],
        },
      ] as const;

      for (const testCase of cases) {
        const params = {
          name: testCase.name,
          command: longCommand,
          ...(testCase.notifyOnCompletion === undefined
            ? {}
            : { notifyOnCompletion: testCase.notifyOnCompletion }),
          ...(testCase.triggerOnCompletion === undefined
            ? {}
            : { triggerOnCompletion: testCase.triggerOnCompletion }),
        };
        const result = await exec(session, 'bg_run', params);
        const task = taskFromResult(result);
        assert.equal(task.notifyOnCompletion, testCase.expectedNotify);
        assert.equal(task.triggerOnCompletion, testCase.expectedTrigger);
        for (const expected of testCase.expected) {
          assert.ok(
            resultText(result).includes(expected),
            `${testCase.name} receipt should include ${JSON.stringify(expected)}`,
          );
        }
        assert.equal(
          Reflect.get(result, 'terminate'),
          undefined,
          'bg_run must remain non-terminating for workflows that continue useful work',
        );
      }
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  void it('serves real extension EventBus requests and terminal events through the shared registry', async () => {
    const eventBus = createEventBus();
    const terminals: BgTaskSnapshot[] = [];
    const eventOrder: string[] = [];
    const unsubscribeResponseOrder = eventBus.on(BG_RESPONSE_CHANNEL, (data) => {
      const response = requireEventResponse(data);
      if (response.request_id === 'sdk-run' || response.request_id === 'sdk-kill') {
        eventOrder.push(`response:${response.request_id}`);
      }
    });
    const unsubscribeTerminal = eventBus.on(BG_TERMINAL_CHANNEL, (data) => {
      const task = requireTerminal(data).task;
      terminals.push(task);
      eventOrder.push(`terminal:${task.id}:${task.status}`);
    });
    const { session, cwd } = await harness({ eventBus });
    try {
      await session.extensionRunner.emit({ type: 'session_start', reason: 'startup' });
      const caps = await emitEventRequest(eventBus, 'sdk-cap', 'capabilities', {});
      assert.deepEqual(requireOkResult(caps), BG_EXTENSION_CAPABILITIES);
      assert.equal(BG_REQUEST_CHANNEL, 'pi-background-shell:request:v2');
      assert.equal(BG_RESPONSE_CHANNEL, 'pi-background-shell:response:v2');
      assert.equal(BG_TERMINAL_CHANNEL, 'pi-background-shell:terminal:v2');
      assert.equal(BG_REQUEST_SCHEMA, 'pi-background-shell.extension-request.v2');
      assert.equal(BG_RESPONSE_SCHEMA, 'pi-background-shell.extension-response.v2');
      assert.equal(BG_TERMINAL_SCHEMA, 'pi-background-shell.extension-terminal.v2');
      assert.equal(Reflect.get(BG_EXTENSION_CAPABILITIES, 'api_version'), 2);
      assert.equal(JSON.stringify(BG_EXTENSION_CAPABILITIES).includes('run_is_agent'), false);

      const run = await emitEventRequest(eventBus, 'sdk-run', 'run', {
        name: 'EventBus Echo',
        command: 'echo api-ok',
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      const task = requiredTask(requireOkResult(run), 'run result task');
      assert.equal(task.name, 'EventBus Echo');
      assert.ok(
        task.status === 'running' || task.status === 'completed',
        `immediate run response status should be a valid launch snapshot, got ${task.status}`,
      );
      assert.ok(existsSync(join(cwd, task.outputPath)));
      const terminal = await waitForTerminalSnapshot(terminals, task.id);
      assert.equal(terminal.status, 'completed');
      assert.equal(terminals.filter((entry) => entry.id === task.id).length, 1);
      assert.ok(
        eventOrder.findIndex((entry) => entry === `terminal:${task.id}:completed`) >
          eventOrder.indexOf('response:sdk-run'),
        'completed terminal must follow the correlated run response',
      );

      const logs = await emitEventRequest(eventBus, 'sdk-logs', 'logs', {
        taskId: task.id,
        maxBytes: 100,
        tail: true,
      });
      const logsResult = requiredJsonObject(requireOkResult(logs), 'logs result must be an object');
      assert.match(String(logsResult['text']), /api-ok/u);
      assert.equal(requiredTask(logsResult['task'], 'logs task').id, task.id);
      assert.equal(logsResult['tail'], true);

      const status = await emitEventRequest(eventBus, 'sdk-status', 'status', { taskId: task.id });
      const statusResult = requiredJsonObject(
        requireOkResult(status),
        'status result must be an object',
      );
      const statusTasks = statusResult['tasks'];
      assert.ok(Array.isArray(statusTasks), 'status tasks should be an array');
      assert.equal(requiredTask(statusTasks[0], 'status task').status, 'completed');

      const sleep = await emitEventRequest(eventBus, 'sdk-sleep', 'run', {
        name: 'EventBus Sleep',
        // `exec` is a POSIX shell builtin and shellQuote emits POSIX quoting;
        // neither is valid under cmd.exe. Node's own quoting handles both.
        command: `node -e ${JSON.stringify('process.on("SIGTERM", () => {}); process.stdout.write("term-handler-ready\\n"); setInterval(() => {}, 1000)')}`,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      const sleepTask = requiredTask(requireOkResult(sleep), 'sleep run task');
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const readiness = await emitEventRequest(eventBus, `sdk-sleep-ready-${String(attempt)}`, 'logs', {
          taskId: sleepTask.id,
          maxBytes: 100,
          tail: true,
        });
        const output = requiredJsonObject(requireOkResult(readiness), 'readiness logs must be an object');
        if (String(output['text']).includes('term-handler-ready')) {
          ready = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(ready, 'child installs its TERM handler before the kill request');
      const kill = await emitEventRequest(eventBus, 'sdk-kill', 'kill', { taskId: sleepTask.id });
      const killResult = requiredJsonObject(requireOkResult(kill), 'kill result must be an object');
      assert.equal(requiredTask(killResult['task'], 'kill task').status, 'killed');
      const sleepTerminal = await waitForTerminalSnapshot(terminals, sleepTask.id);
      assert.equal(sleepTerminal.status, 'killed');
      assert.equal(terminals.filter((entry) => entry.id === sleepTask.id).length, 1);
      assert.ok(
        eventOrder.findIndex((entry) => entry === `terminal:${sleepTask.id}:killed`) >
          eventOrder.indexOf('response:sdk-kill'),
        'killed terminal must follow the kill response',
      );

      const malformed = await emitEventRequest(eventBus, 'sdk-malformed', 'run', {
        name: 'Bad EventBus Run',
        command: 'echo nope',
        timeoutSeconds: null,
        notifyOnCompletion: true,
        triggerOnCompletion: true,
      });
      assert.equal(malformed.ok, false);
      assert.match(malformed.ok ? '' : malformed.error, /positive integer/u);

      for (const obsolete of [{ isAgent: false }, { isAgent: true }, { surviveReload: true }]) {
        const rejected = await emitEventRequest(eventBus, `sdk-old-${JSON.stringify(obsolete)}`, 'run', {
          name: 'Unsupported EventBus parameter', command: 'echo nope',
          notifyOnCompletion: false, triggerOnCompletion: false, ...obsolete,
        });
        assert.equal(rejected.ok, false, 'EventBus must strictly reject old/unsupported fields');
      }

      const unknown = await emitEventRequest(eventBus, 'sdk-unknown', 'mystery', {});
      assert.equal(unknown.ok, false);
      assert.equal(unknown.operation, 'mystery');

      const firstDuplicate = await emitEventRequest(eventBus, 'sdk-dup', 'capabilities', {});
      assert.equal(firstDuplicate.ok, true);
      const duplicate = await emitEventRequest(eventBus, 'sdk-dup', 'capabilities', {});
      assert.equal(duplicate.ok, false);
      assert.match(duplicate.ok ? '' : duplicate.error, /duplicate request_id/u);
    } finally {
      unsubscribeTerminal();
      unsubscribeResponseOrder();
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  void it('uses AgentSession.reload() to invalidate old runners and bind fresh EventBus activations', async () => {
    const eventBus = createEventBus();
    const responses: BackgroundTaskExtensionResponse[] = [];
    const terminals: BgTaskSnapshot[] = [];
    const unsubscribeResponses = eventBus.on(BG_RESPONSE_CHANNEL, (data) => {
      responses.push(requireEventResponse(data));
    });
    const unsubscribeTerminals = eventBus.on(BG_TERMINAL_CHANNEL, (data) => {
      terminals.push(requireTerminal(data).task);
    });
    const { session } = await harness({ eventBus });
    let bound = false;
    try {
      await session.bindExtensions({ onError: () => undefined });
      bound = true;
      for (let cycle = 1; cycle <= 2; cycle++) {
        const oldRunner = session.extensionRunner;
        const oldContext = oldRunner.createContext();
        const runningRequestId = `real-reload-${String(cycle)}-running`;
        const running = await emitEventRequest(eventBus, runningRequestId, 'run', {
          name: `Real Reload Running ${String(cycle)}`,
          command: `node -e ${JSON.stringify('setTimeout(() => {}, 10000)')}`,
          notifyOnCompletion: false,
          triggerOnCompletion: false,
        });
        const runningTask = requiredTask(requireOkResult(running), 'real reload running task');
        assert.equal(runningTask.status, 'running');

        await session.reload();
        assert.notEqual(session.extensionRunner, oldRunner, 'reload must install a fresh runner');
        assert.throws(() => oldContext.cwd, /stale after session replacement or reload/u);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(
          terminals.filter((task) => task.id === runningTask.id).length,
          0,
          'reload-killed tasks must not publish on the disposed activation',
        );

        const quickRequestId = `real-reload-${String(cycle)}-quick`;
        const quick = await emitEventRequest(eventBus, quickRequestId, 'run', {
          name: `Real Reload Quick ${String(cycle)}`,
          command: 'echo reload-ok',
          notifyOnCompletion: false,
          triggerOnCompletion: false,
        });
        const quickTask = requiredTask(requireOkResult(quick), 'real reload quick task');
        await waitForTerminalSnapshot(terminals, quickTask.id);
        assert.equal(
          responses.filter((response) => response.request_id === quickRequestId).length,
          1,
          'only the freshly bound activation may answer after reload',
        );
        assert.equal(
          terminals.filter((task) => task.id === quickTask.id).length,
          1,
          'the fresh activation must publish exactly one ordinary terminal',
        );
      }
    } finally {
      unsubscribeTerminals();
      unsubscribeResponses();
      if (bound) {
        await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      }
      session.dispose();
    }
  });

  void it('keeps an overlapping late session_start continuation from recreating status resources', async () => {
    type LifecycleHandler = (event: Record<string, unknown>, ctx: JsonObject) => unknown;
    const root = await mkdtemp(join(tmpdir(), 'pi-bg-late-session-start-'));
    roots.push(root);
    const cwd = join(root, 'project');
    await mkdir(cwd, { recursive: true });
    const handlers = new Map<string, LifecycleHandler[]>();
    const pi: ExtensionAPI = Object.assign(Object.create(null), {
      events: createEventBus(),
      on(name: string, handler: LifecycleHandler) {
        const registered = handlers.get(name) ?? [];
        registered.push(handler);
        handlers.set(name, registered);
        return () => undefined;
      },
      registerTool() {},
      registerCommand() {},
      registerShortcut() {},
      registerMessageRenderer() {},
      sendMessage() {},
      getThinkingLevel() {
        return 'off';
      },
      getActiveTools() {
        return [];
      },
      setActiveTools() {},
    });
    const ctx: JsonObject = {
      cwd,
      sessionManager: { getSessionId: () => 'late-session-start' },
      hasUI: false,
      mode: 'print',
      ui: { setStatus() {}, setWidget() {}, notify() {} },
    };
    const dispatch = async (name: string, event: Record<string, unknown>): Promise<void> => {
      for (const handler of [...(handlers.get(name) ?? [])]) await handler(event, ctx);
    };
    await backgroundTasksExtension(pi);

    const originalEnsureRuntimeDir = BackgroundTaskRegistry.prototype.ensureRuntimeDir;
    const enteredEnsure = deferred<void>();
    const releaseEnsure = deferred<void>();
    const activeIntervals = new Set<ReturnType<typeof setInterval>>();
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      const handle = realSetInterval(...args);
      activeIntervals.add(handle);
      return handle;
    }) as typeof setInterval;
    globalThis.clearInterval = ((handle?: ReturnType<typeof setInterval>) => {
      if (handle !== undefined) activeIntervals.delete(handle);
      return realClearInterval(handle);
    }) as typeof clearInterval;
    BackgroundTaskRegistry.prototype.ensureRuntimeDir = async function (context) {
      enteredEnsure.resolve(undefined);
      await releaseEnsure.promise;
      return originalEnsureRuntimeDir.call(this, context);
    };

    try {
      const start = dispatch('session_start', { type: 'session_start', reason: 'startup' });
      await enteredEnsure.promise;
      await dispatch('session_shutdown', { type: 'session_shutdown', reason: 'reload' });
      assert.equal(activeIntervals.size, 0, 'shutdown must clear all pre-existing intervals');

      releaseEnsure.resolve(undefined);
      await start;
      assert.equal(
        activeIntervals.size,
        0,
        'the old session_start continuation must not create a post-shutdown interval',
      );
    } finally {
      releaseEnsure.resolve(undefined);
      for (const handle of activeIntervals) realClearInterval(handle);
      activeIntervals.clear();
      BackgroundTaskRegistry.prototype.ensureRuntimeDir = originalEnsureRuntimeDir;
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    }
  });

  void it('supports status/log prefix resolution, all-task listing, head/tail truncation, and ambiguous/unknown ID errors', async () => {
    const { session } = await harness();
    try {
      const first = await exec(session, 'bg_run', {
        name: 'SDK First',
        // The head/tail assertions below are byte-exact, so the command must
        // emit exactly six bytes with no trailing newline. `printf` is
        // POSIX-only and `echo` appends a newline, so use node directly.
        command: `node -e ${JSON.stringify('process.stdout.write("abcdef")')}`,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      const second = await exec(session, 'bg_run', {
        name: 'SDK Second',
        command: `node -e ${JSON.stringify('process.stdout.write("123456")')}`,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      const firstDone = await wait(session, taskFromResult(first).id);
      await wait(session, taskFromResult(second).id);
      const all = await exec(session, 'bg_status', {});
      assert.ok(tasksFromResult(all).length >= 2);
      const byPrefix = await exec(session, 'bg_status', { taskId: firstDone.id.slice(0, 5) });
      assert.equal(firstTask(byPrefix).id, firstDone.id);
      await assert.rejects(
        () => exec(session, 'bg_status', { taskId: 'b' }),
        /Ambiguous task ID prefix/,
      );
      await assert.rejects(
        () => exec(session, 'bg_status', { taskId: 'bdeadbeef' }),
        /Unknown background task ID/,
      );
      const head = await exec(session, 'bg_logs', {
        taskId: firstDone.id,
        maxBytes: 3,
        tail: false,
      });
      assert.match(resultText(head), /^abc/);
      assert.match(resultText(head), /Showing head/);
      const tail = await exec(session, 'bg_logs', {
        taskId: firstDone.id,
        maxBytes: 3,
        tail: true,
      });
      assert.match(resultText(tail), /def/);
      assert.match(resultText(tail), /Showing tail/);
      await assert.rejects(
        () => exec(session, 'bg_logs', { taskId: 'bdeadbeef' }),
        /Unknown background task ID/,
      );
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  void it('kills running tasks and rejects unknown or completed kills loudly', async () => {
    const { session } = await harness();
    try {
      const r = await exec(session, 'bg_run', {
        name: 'SDK Sleep',
        command: `node -e ${JSON.stringify('setTimeout(() => {}, 10000)')}`,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      const task = taskFromResult(r);
      const k = await exec(session, 'bg_kill', { taskId: task.id.slice(0, 6) });
      assert.match(resultText(k), /Killed/);
      const t = await wait(session, task.id);
      assert.equal(t.status, 'killed');
      await assert.rejects(() => exec(session, 'bg_kill', { taskId: t.id }), /not running/);
      await assert.rejects(
        () => exec(session, 'bg_kill', { taskId: 'bdeadbeef' }),
        /Unknown background task ID/,
      );
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  void it('fails timed-out tasks loudly', async () => {
    const { session } = await harness();
    const timeoutSeconds = 1;
    try {
      const r = await exec(session, 'bg_run', {
        name: 'SDK Timeout',
        command: `node -e ${JSON.stringify('setTimeout(() => {}, 5000)')}`,
        timeoutSeconds,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      const terminalWaitIterations = Math.ceil((timeoutSeconds * 1000 + STOP_WAIT_MS + 500) / 50);
      const t = await wait(session, taskFromResult(r).id, terminalWaitIterations);
      assert.equal(t.status, 'failed');
      assert.match(t.error ?? '', /Timed out after 1s/);
      const logs = await exec(session, 'bg_logs', { taskId: t.id, maxBytes: 1000 });
      assert.match(resultText(logs), /background task timeout/);
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  void it('records completion notifications exactly once when enabled and suppresses them when disabled', async () => {
    const { session } = await harness();
    try {
      const notified = await exec(session, 'bg_run', {
        name: 'Notify SDK',
        // The payload deliberately contains <, > and & to exercise escaping of
        // task output. Those are cmd.exe redirection and separator
        // metacharacters, so the literal must not appear in the command line;
        // it is rebuilt from character codes inside the child instead.
        command: `node -e ${JSON.stringify(
          'process.stdout.write(String.fromCharCode(60)+"ok"+String.fromCharCode(62,38)+"done")',
        )}`,
        notifyOnCompletion: true,
        triggerOnCompletion: false,
      });
      const hidden = await exec(session, 'bg_run', {
        name: 'No Notify SDK',
        command: 'echo quiet',
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      await wait(session, taskFromResult(notified).id);
      const hiddenTask = taskFromResult(hidden);
      await wait(session, hiddenTask.id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const notes = customNotifications(session);
      assert.equal(notes.length, 1);
      const note = notes[0];
      assert.ok(note, 'completion notification should be recorded');
      assert.match(note.content, /<task-name>Notify SDK<\/task-name>/);
      assert.match(note.content, /<status>completed<\/status>/);
      assert.match(note.content, /&quot;|Notify SDK/);
      assert.equal(note.details['notified'], true);
      const status = await exec(session, 'bg_status', { taskId: hiddenTask.id });
      assert.equal(firstTask(status).notified, false);
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  void it('keeps finished footer notices until explicit /bg-clear', async () => {
    const { session } = await harness();
    const statuses: Array<string | undefined> = [];
    const notifications: UiNotification[] = [];
    session.extensionRunner.setUIContext(
      makeStatusUi(session.extensionRunner.getUIContext(), statuses, notifications),
      'tui',
    );
    try {
      const done = await exec(session, 'bg_run', {
        name: 'Footer Done',
        command: 'echo done',
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      await wait(session, taskFromResult(done).id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.match(statuses.at(-1) ?? '', /bg 1 done · Shift↓ · \/bg-clear/);

      const shortcuts = session.extensionRunner.getShortcuts({});
      assert.ok(shortcuts.has('ctrl+alt+c'));
      const clearCommand = session.extensionRunner
        .getRegisteredCommands()
        .find((cmd) => cmd.invocationName === 'bg-clear');
      assert.ok(clearCommand);
      await clearCommand.handler('', session.extensionRunner.createCommandContext());
      assert.equal(statuses.at(-1), undefined);
      assert.match(notifications.at(-1)?.message ?? '', /Cleared 1 finished/);
      const preservedLogs = await exec(session, 'bg_logs', { taskId: taskFromResult(done).id });
      assert.match(resultText(preservedLogs), /done/, '/bg-clear must not delete logs');

      const running = await exec(session, 'bg_run', {
        name: 'Footer Running',
        command: `node -e ${JSON.stringify('setTimeout(() => {}, 10000)')}`,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      const secondDone = await exec(session, 'bg_run', {
        name: 'Footer Done Two',
        command: 'echo two',
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      await wait(session, taskFromResult(secondDone).id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.match(statuses.at(-1) ?? '', /1 running · 1 done · Shift↓ · \/bg-clear/);
      await clearCommand.handler('', session.extensionRunner.createCommandContext());
      assert.match(statuses.at(-1) ?? '', /bg 1 running · Shift↓/);
      assert.doesNotMatch(statuses.at(-1) ?? '', /done|\/bg-clear/);
      await exec(session, 'bg_kill', { taskId: taskFromResult(running).id });
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  void it('isolates throwing footer updates from child ownership and interval callbacks', {
    skip: process.platform === 'win32' ? 'POSIX real-process cleanup fixture' : false,
  }, async (t) => {
    const { session } = await harness();
    const statuses: Array<string | undefined> = [];
    const diagnostics: string[] = [];
    let failuresRemaining = 2;
    const ui = makeStatusUi(session.extensionRunner.getUIContext(), statuses, []);
    session.extensionRunner.setUIContext({
      ...ui,
      setStatus: (key, text) => {
        if (text?.includes('1 running') && failuresRemaining > 0) {
          failuresRemaining--;
          throw new Error('synthetic non-stale footer failure');
        }
        ui.setStatus(key, text);
      },
    }, 'tui');
    t.mock.method(console, 'error', (...args: unknown[]) => {
      diagnostics.push(args.map(String).join(' '));
    });
    try {
      const launched = await exec(session, 'bg_run', {
        name: 'UI fault isolation',
        command: 'node -e "setTimeout(() => {}, 5000)"',
        notifyOnCompletion: false,
      });
      const task = taskFromResult(launched);
      assert.equal(task.status, 'running', 'presentation failure must not fail admission');
      await new Promise((resolve) => setTimeout(resolve, 1150));
      assert.equal(failuresRemaining, 0, 'both admission and periodic UI paths were exercised');
      assert.equal(firstTask(await exec(session, 'bg_status', { taskId: task.id })).status, 'running');
      assert.ok(diagnostics.some((message) => message.includes('synthetic non-stale footer failure')));
      assert.equal(taskFromResult(await exec(session, 'bg_kill', { taskId: task.id })).status, 'killed');
      const pid = task.pid;
      assert.ok(pid);
      assert.throws(
        () => process.kill(pid, 0),
        (error: unknown) => isJsonObject(error) && error['code'] === 'ESRCH',
        'the admitted process must remain stoppable after UI failures',
      );
    } finally {
      // Also clean up the old broken implementation if this regression is run red.
      const tasks = tasksFromResult(await exec(session, 'bg_status', {}));
      for (const task of tasks) {
        if (task.pid !== undefined) {
          try { process.kill(-task.pid, 'SIGKILL'); }
          catch (error) {
            if (!isJsonObject(error) || error['code'] !== 'ESRCH') throw error;
          }
        }
      }
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  void it('reports failed/stopped/done footer combinations and focused dock status', async () => {
    const { session } = await harness();
    const statuses: Array<string | undefined> = [];
    const notifications: UiNotification[] = [];
    session.extensionRunner.setUIContext(
      makeStatusUi(session.extensionRunner.getUIContext(), statuses, notifications),
      'tui',
    );
    try {
      const failed = await exec(session, 'bg_run', {
        name: 'Footer Failed',
        command: 'node -e "process.exit(2)"',
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      await wait(session, taskFromResult(failed).id);
      const stopped = await exec(session, 'bg_run', {
        name: 'Footer Stopped',
        command: `node -e ${JSON.stringify('setTimeout(() => {}, 10000)')}`,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      const stoppedTask = taskFromResult(stopped);
      await exec(session, 'bg_kill', { taskId: stoppedTask.id });
      await wait(session, stoppedTask.id);
      const done = await exec(session, 'bg_run', {
        name: 'Footer Done Matrix',
        command: 'echo done',
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      await wait(session, taskFromResult(done).id);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.match(statuses.at(-1) ?? '', /1 failed · 1 stopped · 1 done · Shift↓ · \/bg-clear/);

      const running = await exec(session, 'bg_run', {
        name: 'Footer Focused',
        command: `node -e ${JSON.stringify('setTimeout(() => {}, 10000)')}`,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.match(
        statuses.at(-1) ?? '',
        /1 running · 1 failed · 1 stopped · 1 done · Shift↓ · \/bg-clear/,
      );
      const shortcuts = session.extensionRunner.getShortcuts({});
      const shiftDown = shortcuts.get('shift+down');
      assert.ok(shiftDown, 'Shift+Down shortcut should be registered');
      await shiftDown.handler(session.extensionRunner.createContext());
      assert.ok(
        statuses.some(
          (status) =>
            status?.includes('bg 1 running · 1 failed · 1 stopped · 1 done · focused') ?? false,
        ),
      );
      await exec(session, 'bg_kill', { taskId: taskFromResult(running).id });
      assert.equal(notifications.length, 0);
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  void it('prepares shell task names and rejects obsolete or extra bg_run arguments rather than stripping them', async () => {
    const { session } = await harness();
    try {
      const tool = session.getToolDefinition('bg_run');
      assert.ok(tool?.prepareArguments);
      const args = { name: 'Shell QA', command: 'echo qa', description: 'Named task' };
      const prepared = requiredPrepared(tool.prepareArguments(args));
      assert.equal(prepared.name, args.name);
      assert.equal(prepared.command, args.command);
      assert.equal(Object.hasOwn(prepared, 'isAgent'), false);
      // Name remains required in the public schema; preserve the existing host-side
      // name preparation before Pi validates that schema, without any old agent flag.
      const legacy = requiredPrepared(tool.prepareArguments({ command: 'echo qa', description: 'Legacy QA' }));
      assert.equal(legacy.name, 'Legacy QA');
      assert.ok(requiredPrepared(tool.prepareArguments({ command: 'echo qa' })).name);
      assert.throws(() => tool.prepareArguments?.(null), /arguments must be an object/);
      for (const extra of [{ isAgent: false }, { isAgent: true }, { prompt: 'old prompt' }, { unexpected: 1 }]) {
        const invalid = { ...args, ...extra };
        assert.throws(() => tool.prepareArguments?.(invalid), /unsupported|unknown|unexpected/i);
        await assert.rejects(() => exec(session, 'bg_run', invalid), /unsupported|unknown|unexpected/i);
        assert.deepEqual(Object.keys(invalid), [...Object.keys(args), ...Object.keys(extra)]);
      }
      await assert.rejects(() => exec(session, 'bg_run', { name: 'Empty', command: '' }), /command.*empty|empty.*command/i);
      for (const timeoutSeconds of [0, -1, NaN, Infinity, '1']) {
        assert.throws(() => tool.prepareArguments?.({ ...args, timeoutSeconds }), /timeout/i);
      }
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  void it('treats a fake child pi as an ordinary command and preserves JSON/control-line stdout and stderr', async () => {
    const { session, cwd } = await harness();
    try {
      const stdout = [
        JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'raw child' }] } }),
        JSON.stringify({ type: 'background-task-telemetry', model: 'fake/model', tokenUsage: { totalTokens: 42 } }),
        JSON.stringify({ type: 'background-task-context-usage', tokens: 42 }),
        '\u001ePI_FUSION_CHILD_RESULT {"plain":"output"}',
      ].join('\n') + '\n';
      const stderr = '\u001ePI_FUSION_CHILD_SETTLEMENT {"plain":"stderr"}\n';
      const fake = await installFakeCli(cwd, { stdout, stderr });
      const command = `${fake.command} --mode json -p --agent --no-agent`;
      const launched = taskFromResult(await exec(session, 'bg_run', {
        name: 'Ordinary child pi', command,
        notifyOnCompletion: false, triggerOnCompletion: false,
      }));
      const done = await wait(session, launched.id);
      assert.equal(done.status, 'completed');
      assert.equal(done.command, command);
      assert.deepEqual(JSON.parse(await readFile(fake.argvPath, 'utf8')), ['--mode', 'json', '-p', '--agent', '--no-agent']);
      const output = await readFile(join(cwd, done.outputPath), 'utf8');
      for (const line of [...stdout.trimEnd().split('\n'), ...stderr.trimEnd().split('\n')]) {
        assert.ok(output.includes(line), `raw log must retain ${JSON.stringify(line)}`);
      }
      const metadata = await readJsonWithStatus(join(cwd, done.outputPath.replace(/\.output$/, '.json')), 'completed');
      for (const key of ['isAgent', 'model', 'contextUsage', 'tokenUsage', 'toolUsage']) {
        assert.equal(Object.hasOwn(done, key), false);
        assert.equal(Object.hasOwn(metadata, key), false);
      }
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  void it('fails spawn errors loudly and writes failure metadata', async () => {
    const previousShell = process.env['SHELL'];
    const previousComSpec = process.env['ComSpec'];
    if (process.platform === 'win32') {
      process.env['ComSpec'] = 'C:\\definitely\\missing\\pi-bg-shell.exe';
    } else {
      process.env['SHELL'] = '/definitely/missing/pi-bg-shell';
    }
    const { session, cwd } = await harness();
    try {
      const r = await exec(session, 'bg_run', {
        name: 'Bad Shell',
        command: 'echo nope',
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      const t = await wait(session, taskFromResult(r).id);
      assert.equal(t.status, 'failed');
      assert.match(t.error ?? '', /ENOENT|no such file/i);
      const metadataPath = join(cwd, t.outputPath.replace(/\.output$/, '.json'));
      const metadata = await readJsonWithStatus(metadataPath, 'failed');
      assert.equal(metadata['status'], 'failed');
    } finally {
      restoreEnvValue('SHELL', previousShell);
      restoreEnvValue('ComSpec', previousComSpec);
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });

  void it('cleans up multiple running tasks on shutdown', async () => {
    const { session } = await harness();
    const one = await exec(session, 'bg_run', {
      name: 'SDK Shutdown One',
      command: `node -e ${JSON.stringify('setTimeout(() => {}, 10000)')}`,
      notifyOnCompletion: false,
      triggerOnCompletion: false,
    });
    const two = await exec(session, 'bg_run', {
      name: 'SDK Shutdown Two',
      command: `node -e ${JSON.stringify('setTimeout(() => {}, 10000)')}`,
      notifyOnCompletion: false,
      triggerOnCompletion: false,
    });
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    const s1 = await exec(session, 'bg_status', { taskId: taskFromResult(one).id });
    const s2 = await exec(session, 'bg_status', { taskId: taskFromResult(two).id });
    assert.equal(firstTask(s1).status, 'killed');
    assert.equal(firstTask(s2).status, 'killed');
    assert.match(firstTask(s1).error ?? '', /shutdown/);
    session.dispose();
  });

});
