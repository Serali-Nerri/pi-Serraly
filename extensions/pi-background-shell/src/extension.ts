import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ThemeColor,
} from '@earendil-works/pi-coding-agent';
import { formatSize } from '@earendil-works/pi-coding-agent';
import { Text, type KeyId } from '@earendil-works/pi-tui';
import { Type, type Static } from 'typebox';
import { renderBgToolCard } from './ui/tool-cards.js';
import {
  DEFAULT_LOG_BYTES,
  MAX_LOG_BYTES,
  MAX_TIMEOUT_SECONDS,
  deriveTaskNameFromCommand,
  formatSnapshotList,
  normalizeMaxBytes,
  normalizeTaskName,
  normalizeTimeoutSeconds,
  parseBgCommandArgs,
  taskDisplayName,
  truncateChars,
  type BgKillDetails,
  type BgLogsDetails,
  type BgRunDetails,
  type BgStatusDetails,
  type BgTask,
  type BgTaskSnapshot,
  type ReloadShellActivationClaimV1,
  type ReloadShellActivationLeaseV1,
  type ReloadShellIdentityV1,
  type StartTaskOptions,
  ReloadSurvivalError,
} from './core/common.js';
import { BackgroundTaskRegistry, type BackgroundTaskContext } from './core/registry.js';
import {
  getProcessReloadShellOwnerV1,
  makeReloadShellIdentity,
} from './core/reload-shell-owner.js';
import { initializeShellPolicy, shellPolicyDescription } from './core/shell-policy.js';
import {
  installBackgroundTaskExtensionApi,
  type BackgroundTaskExtensionService,
} from './core/extension-api.js';
import type { BackgroundTaskForUi, TaskManagerResult } from './ui/background-tasks-manager.js';
import { dockShortcutFooterHint, parseBackgroundTasksConfig } from './core/config.js';
import { LazyModule, SynchronousActivationCloseFence } from './core/lazy-module.js';

/**
 * Project-local Pi background task manager.
 *
 * Scope:
 * - Explicit background shell jobs only: /bg and bg_run spawn commands directly.
 * - No Ctrl+B support for backgrounding an already-running built-in bash tool.
 * - Opted ordinary shell jobs can hand their same live process ownership to a
 *   fresh extension activation on real same-process reload only.
 * - No PID/file adoption, process-restart survival, or crash recovery.
 */

const STATUS_INTERVAL_MS = 1000;
const COMMAND_PREVIEW_CHARS = 90;
export const BG_RUN_DESCRIPTION =
  'Start a named long-running shell command in the background; returns immediately with task ID, PID, and output path. Default terminal notification steers a busy agent at the next safe boundary or wakes an idle agent; do not poll or sleep merely to wait. Output is stored in .pi/tasks, with model-visible log reads capped at 50 KiB. Commands run with local permissions, not in a sandbox.';

/** Namespace tool_search lists as a searchable source for the deferred shell tools. */
const BG_TOOL_NAMESPACE = {
  name: 'background-shell',
  description:
    'Manage named background shell processes: start, inspect status, read bounded logs, stop',
};

const LIGHT_BLUE_BG = '\x1b[48;2;183;223;255m';
const LIGHT_BLUE_FG = '\x1b[38;2;11;70;110m';
const ANSI_RESET = '\x1b[0m';
function lightBlue(value: string): string {
  return `${LIGHT_BLUE_BG}${LIGHT_BLUE_FG}${value}${ANSI_RESET}`;
}

function textContent(text: string) {
  return [{ type: 'text' as const, text }];
}

interface BgToolArgumentRecord {
  readonly command?: unknown;
  readonly name?: unknown;
  readonly description?: unknown;
  readonly timeoutSeconds?: unknown;
  readonly notifyOnCompletion?: unknown;
  readonly triggerOnCompletion?: unknown;
  readonly surviveReload?: unknown;
}

function optionalTrimmed(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const BgRunParams = Type.Object(
  {
    name: Type.String({
      description:
        'Short human-readable task name shown in the bg footer dock. Required; use 2-6 words, not the raw command.',
    }),
    command: Type.String({
      description: 'Required shell command; runs in the session working directory.',
    }),
    description: Type.Optional(
      Type.String({ description: 'Longer human-readable task context. Default: none.' }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: MAX_TIMEOUT_SECONDS,
        description:
          'Timeout in seconds, rounded down to whole seconds; task fails and is killed when exceeded. Default: no timeout.',
      }),
    ),
    notifyOnCompletion: Type.Optional(
      Type.Boolean({
        description:
          'Deliver a terminal notification. Default: true. When false, triggerOnCompletion has no effect.',
      }),
    ),
    triggerOnCompletion: Type.Optional(
      Type.Boolean({
        description:
          'Steer a busy agent or wake an idle agent on terminal notification. Default: true; inactive when notifyOnCompletion is false.',
      }),
    ),
    surviveReload: Type.Optional(
      Type.Boolean({
        description:
          'Retain this exact shell execution across a real same-process Pi reload. Default: false. Does not survive exit, restart, or session replacement.',
      }),
    ),
  },
  { additionalProperties: false },
);

const BgStatusParams = Type.Object({
  taskId: Type.Optional(
    Type.String({
      description:
        'Optional task ID or unambiguous prefix. If omitted, all running/recent tasks are returned.',
    }),
  ),
});

const BgLogsParams = Type.Object({
  taskId: Type.String({ description: 'Task ID or unambiguous prefix' }),
  maxBytes: Type.Optional(
    Type.Number({
      description: `Maximum bytes to return, capped at ${formatSize(MAX_LOG_BYTES)}. Default: ${formatSize(DEFAULT_LOG_BYTES)}.`,
    }),
  ),
  tail: Type.Optional(
    Type.Boolean({
      description: 'Read the tail of the log when true, head when false. Default: true.',
    }),
  ),
});

const BgKillParams = Type.Object({
  taskId: Type.String({ description: 'Task ID or unambiguous prefix to stop' }),
});

type BgRunParamsValue = Static<typeof BgRunParams>;

function prepareBgRunArguments(args: unknown): BgRunParamsValue {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('bg_run arguments must be an object');
  }
  for (const key of Reflect.ownKeys(args)) {
    if (typeof key !== 'string' || !Object.hasOwn(BgRunParams.properties, key)) {
      throw new Error(`bg_run unsupported argument: ${String(key).slice(0, 96)}`);
    }
  }
  const input = args as BgToolArgumentRecord;
  if (typeof input.command !== 'string') throw new Error('bg_run requires command string');
  if (Object.hasOwn(input, 'description') && typeof input.description !== 'string') {
    throw new Error('bg_run description must be a string when present');
  }
  for (const key of ['notifyOnCompletion', 'triggerOnCompletion', 'surviveReload'] as const) {
    if (Object.hasOwn(input, key) && typeof input[key] !== 'boolean') {
      if (key === 'surviveReload') {
        throw new ReloadSurvivalError(
          'pi_bg_survive_reload_invalid',
          'bg_run surviveReload must be boolean when present',
        );
      }
      throw new Error(`bg_run ${key} must be boolean when present`);
    }
  }
  if (Object.hasOwn(input, 'timeoutSeconds') && input.timeoutSeconds === undefined) {
    throw new Error('bg_run timeoutSeconds must be a number when present');
  }
  normalizeTimeoutSeconds(input.timeoutSeconds);
  // Preserve the name fallback before Pi validates the required string field.
  const prepared: BgRunParamsValue = {
    command: input.command,
    name:
      normalizeTaskName(input.name) ??
      normalizeTaskName(input.description) ??
      deriveTaskNameFromCommand(input.command),
  };
  if (typeof input.description === 'string') prepared.description = input.description;
  if (typeof input.timeoutSeconds === 'number') prepared.timeoutSeconds = input.timeoutSeconds;
  if (typeof input.notifyOnCompletion === 'boolean')
    prepared.notifyOnCompletion = input.notifyOnCompletion;
  if (typeof input.triggerOnCompletion === 'boolean')
    prepared.triggerOnCompletion = input.triggerOnCompletion;
  if (typeof input.surviveReload === 'boolean') prepared.surviveReload = input.surviveReload;
  return prepared;
}

// Pi 0.99.1 guards captured context getters with this error after replacement.
// It has no error code; do not confuse unrelated UI failures with closure.
function isStaleExtensionContext(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith('This extension ctx is stale after session replacement or reload.')
  );
}

/** Map the host render context onto the shared card state. */
function cardStateFor(context?: { isPartial?: boolean; isError?: boolean }): 'running' | 'success' | 'error' {
  if (context?.isError) return 'error';
  return context?.isPartial === false ? 'success' : 'running';
}

export default async function backgroundTasksExtension(pi: ExtensionAPI): Promise<void> {
  const config = parseBackgroundTasksConfig();
  const dockEntryHint = dockShortcutFooterHint(config.dockShortcut);
  const shellPolicy = initializeShellPolicy();
  const reloadShellOwner = getProcessReloadShellOwnerV1();
  const seenTaskIds = new Set<string>();
  let currentCtx: ExtensionContext | undefined;
  let currentRegistryCtx: BackgroundTaskContext | undefined;
  let activationLease: ReloadShellActivationLeaseV1 | undefined;
  let activationIdentity: ReloadShellIdentityV1 | undefined;
  let pendingActivationClaim: ReloadShellActivationClaimV1 | undefined;
  let dockOpen = false;
  let closeTaskManager: (() => void) | undefined;
  let statusInterval: NodeJS.Timeout | undefined;
  let disposed = false;
  let shutdownCleanupStarted = false;
  let reloadHandoffFailed = false;
  let uiUpdateErrorReported = false;
  let shutdownReason = 'shutdown';
  const activationCloseFence = new SynchronousActivationCloseFence();
  const taskManagerLoader = new LazyModule(
    'background-task-manager',
    () => import('./ui/background-tasks-manager.js'),
  );

  const registryContext = (ctx: ExtensionContext): BackgroundTaskContext => ({
    cwd: ctx.cwd,
    sessionId: ctx.sessionManager.getSessionId(),
  });

  const registry = new BackgroundTaskRegistry({
    onChange: () => {
      updateUiSafely();
    },
    sendCompletionNotification: (message, options) => {
      pi.sendMessage(message, options);
    },
    publishTerminal: (task) => {
      eventService.publishTerminal(task);
    },
    shellPolicy,
    reloadShellOwner,
  });
  const eventService: BackgroundTaskExtensionService = installBackgroundTaskExtensionApi({
    events: pi.events,
    registry,
    getContext: () => currentRegistryCtx,
    isShuttingDown: () => registry.isShuttingDown(),
  });

  const beginSessionShutdown = (reason: string): void => {
    let handoffError: unknown;
    if (!disposed) {
      disposed = true;
      registry.closeTaskAdmissions();
      if (pendingActivationClaim !== undefined) {
        const claim = pendingActivationClaim;
        pendingActivationClaim = undefined;
        registry.abortReloadActivation(claim);
        try {
          reloadShellOwner.abortActivation(
            claim,
            new ReloadSurvivalError(
              'pi_bg_reload_owner_stale_claim',
              'activation shut down while its reload claim was staging',
            ),
          );
        } catch (error) {
          handoffError = error;
        }
      } else if (reason === 'reload' && activationLease !== undefined) {
        const lease = activationLease;
        try {
          registry.prepareReloadHandoff(lease);
          activationLease = undefined;
          activationIdentity = undefined;
        } catch (error) {
          reloadHandoffFailed = true;
          handoffError = error;
        }
      }
      registry.setShuttingDown(true);
      eventService.close();
    }
    // Teardown remains active on repeated calls so even a handle assigned by a
    // racing continuation is still disposed rather than hidden by idempotence.
    currentCtx = undefined;
    currentRegistryCtx = undefined;
    if (statusInterval !== undefined) {
      clearInterval(statusInterval);
      statusInterval = undefined;
    }
    if (handoffError !== undefined) throw handoffError;
  };

  // Fence admission/publication and the lazy UI lane synchronously before Pi
  // awaits cleanup. Eligible reload handoff retains its live execution owner.
  activationCloseFence.add(() => {
    beginSessionShutdown(shutdownReason);
  });
  activationCloseFence.add(() => {
    taskManagerLoader.close('session shutdown');
    const close = closeTaskManager;
    closeTaskManager = undefined;
    close?.();
  });
  pi.on('session_shutdown', (event) => {
    shutdownReason = event.reason;
    activationCloseFence.close();
  });

  // This is the first session_start callback. Claim synchronously before the
  // first await, stage/import durably, then expose the fresh host adapter.
  pi.on('session_start', async (event, ctx) => {
    if (disposed) return;
    const nextRegistryCtx = registryContext(ctx);
    const identity = makeReloadShellIdentity(
      nextRegistryCtx.sessionId ?? '',
      realpathSync(ctx.cwd),
    );
    if (activationLease !== undefined && registry.hasCurrentReloadLease()) {
      if (
        activationIdentity?.hostPid !== identity.hostPid ||
        activationIdentity.sessionId !== identity.sessionId ||
        activationIdentity.cwdRealpath !== identity.cwdRealpath
      ) {
        throw new ReloadSurvivalError(
          'pi_bg_reload_owner_activation_conflict',
          'a repeated session_start changed the bound reload owner identity without shutdown',
        );
      }
      currentCtx = ctx;
      currentRegistryCtx = nextRegistryCtx;
      return;
    }
    const activationNonce = randomBytes(16).toString('hex');
    const claim = reloadShellOwner.beginActivation(identity, event.reason, activationNonce);
    pendingActivationClaim = claim;
    try {
      const adapter = await registry.stageReloadActivation(claim);
      if (pendingActivationClaim !== claim) {
        // The synchronous shutdown barrier already aborted this claim and
        // detached staged records while the durable import awaited.
        registry.abortReloadActivation(claim);
        return;
      }
      if (disposed) {
        registry.abortReloadActivation(claim);
        pendingActivationClaim = undefined;
        reloadShellOwner.abortActivation(
          claim,
          new ReloadSurvivalError(
            'pi_bg_reload_owner_stale_claim',
            'activation was disposed before reload claim commit',
          ),
        );
        return;
      }
      const lease = reloadShellOwner.commitActivation(claim, adapter);
      pendingActivationClaim = undefined;
      activationLease = lease;
      activationIdentity = identity;
      currentCtx = ctx;
      currentRegistryCtx = nextRegistryCtx;
    } catch (error) {
      registry.abortReloadActivation(claim);
      if (pendingActivationClaim === claim) pendingActivationClaim = undefined;
      try {
        reloadShellOwner.abortActivation(claim, error);
      } catch (abortError) {
        if (
          typeof abortError !== 'object' ||
          abortError === null ||
          Reflect.get(abortError, 'code') !== 'pi_bg_reload_owner_stale_claim'
        ) {
          throw new AggregateError([error, abortError], 'Reload activation claim and abort failed');
        }
      }
      throw error;
    }
  });

  function unseenFinishedTasks(): BgTask[] {
    return registry
      .allTasks()
      .filter((task) => task.status !== 'running' && !seenTaskIds.has(task.id));
  }

  function clearFinishedNotices(ctx = currentCtx): number {
    const unseen = unseenFinishedTasks();
    for (const task of unseen) seenTaskIds.add(task.id);
    updateUi(ctx);
    return unseen.length;
  }

  function notifyClearFinishedNotices(ctx: ExtensionContext): void {
    currentCtx = ctx;
    const cleared = clearFinishedNotices(ctx);
    if (!ctx.hasUI) return;
    ctx.ui.notify(
      cleared > 0
        ? `Cleared ${String(cleared)} finished background task notice${cleared === 1 ? '' : 's'}.`
        : 'No finished background task notices to clear.',
      cleared > 0 ? 'info' : 'warning',
    );
  }

  function updateUi(ctx = currentCtx): void {
    if (registry.isShuttingDown() || !ctx) return;
    try {
      if (!ctx.hasUI || ctx.mode !== 'tui') return;
      const allTasks = registry.allTasks();
      const running = allTasks.filter((task) => task.status === 'running');
      const unseenFailed = allTasks.filter(
        (task) => task.status === 'failed' && !seenTaskIds.has(task.id),
      );
      const unseenStopped = allTasks.filter(
        (task) => task.status === 'killed' && !seenTaskIds.has(task.id),
      );
      const unseenDone = allTasks.filter(
        (task) => task.status === 'completed' && !seenTaskIds.has(task.id),
      );
      const unseenFinishedCount = unseenFailed.length + unseenStopped.length + unseenDone.length;
      ctx.ui.setWidget('background-tasks', undefined);
      if (running.length === 0 && unseenFinishedCount === 0) {
        ctx.ui.setStatus('background-tasks', undefined);
        return;
      }

      const parts: string[] = [];
      if (running.length > 0) parts.push(`${String(running.length)} running`);
      if (unseenFailed.length > 0) parts.push(`${String(unseenFailed.length)} failed`);
      if (unseenStopped.length > 0) parts.push(`${String(unseenStopped.length)} stopped`);
      if (unseenDone.length > 0) parts.push(`${String(unseenDone.length)} done`);
      const entryHint = dockOpen
        ? 'focused'
        : `${dockEntryHint}${unseenFinishedCount > 0 ? ' · /bg-clear' : ''}`;
      const segments = [...parts, entryHint];
      const label = ` bg ${segments.join(' · ')} `;
      ctx.ui.setStatus('background-tasks', lightBlue(label));
    } catch (error) {
      if (!isStaleExtensionContext(error)) throw error;
      if (currentCtx === ctx) currentCtx = undefined;
      if (statusInterval !== undefined) {
        clearInterval(statusInterval);
        statusInterval = undefined;
      }
    }
  }

  // Presentation failures must not escape into child admission/finalization or
  // an uncaught interval callback. Report once per failure burst, not silently.
  function updateUiSafely(ctx = currentCtx): void {
    try {
      updateUi(ctx);
      uiUpdateErrorReported = false;
    } catch (error) {
      if (!uiUpdateErrorReported) {
        uiUpdateErrorReported = true;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[background-tasks] UI update failed: ${truncateChars(message, 500)}`);
      }
    }
  }

  async function startTask(
    ctx: ExtensionContext,
    command: string,
    options: StartTaskOptions = {},
  ): Promise<BgTask> {
    currentCtx = ctx;
    const nextRegistryCtx = registryContext(ctx);
    currentRegistryCtx = nextRegistryCtx;
    return registry.startTask(nextRegistryCtx, command, options);
  }

  async function openTaskManager(
    ctx: ExtensionCommandContext | ExtensionContext,
    initialTaskId?: string,
  ): Promise<void> {
    if (disposed || dockOpen) return;
    currentCtx = ctx;
    let ownsDock = false;
    try {
      if (!ctx.hasUI || ctx.mode !== 'tui') {
        ctx.ui.notify(
          'Background task manager requires TUI mode. Use /jobs, /logs, or bg_status/bg_logs for task facts and output paths.',
          'error',
        );
        return;
      }
      const { BackgroundTasksManager, TASK_MANAGER_OVERLAY_OPTIONS } =
        await taskManagerLoader.run((runtime) => runtime);
      if (disposed || dockOpen) return;
      taskManagerLoader.assertOpen();
      ownsDock = true;
      dockOpen = true;
      updateUi(ctx);
      await ctx.ui.custom<TaskManagerResult>(
        (tui, theme, _keybindings, done) => {
          taskManagerLoader.assertOpen();
          const managerOptions = {
            getTasks: () => registry.allTasks(),
            stopTask: async (task: BackgroundTaskForUi) => {
              await registry.stopTask(registry.resolveTask(task.id), 'user');
              updateUi(ctx);
            },
            stopAllRunning: async () => {
              const result = await registry.stopAllRunning('user');
              updateUi(ctx);
              return result;
            },
            rerunTask: async (task: BackgroundTaskForUi) => {
              const rerunOptions: StartTaskOptions = {
                name: taskDisplayName(task),
                surviveReload: task.surviveReload,
                notifyOnCompletion: true,
                triggerOnCompletion: false,
              };
              if (task.description !== undefined) rerunOptions.description = task.description;
              if (task.timeoutSeconds !== undefined)
                rerunOptions.timeoutSeconds = task.timeoutSeconds;
              const rerun = await startTask(ctx, task.command, rerunOptions);
              updateUi(ctx);
              return rerun;
            },
            showOutputPath: (task: BackgroundTaskForUi) => {
              ctx.ui.notify(
                `Output path for ${taskDisplayName(task)} (${task.id}):\n${task.outputPath}`,
                'info',
              );
            },
            markSeen: (taskId: string) => {
              seenTaskIds.add(taskId);
              updateUi(ctx);
            },
            markFinishedSeen: (taskIds: string[]) => {
              for (const taskId of taskIds) seenTaskIds.add(taskId);
              updateUi(ctx);
            },
            isSeen: (taskId: string) => seenTaskIds.has(taskId),
          };
          const manager = new BackgroundTasksManager(tui, theme, done, {
            ...managerOptions,
            ...(initialTaskId ? { initialTaskId } : {}),
          });
          closeTaskManager = () => {
            manager.dispose();
            done('closed');
          };
          return manager;
        },
        {
          overlay: true,
          overlayOptions: TASK_MANAGER_OVERLAY_OPTIONS,
        },
      );
    } catch (error) {
      const closedLoad =
        disposed &&
        typeof error === 'object' &&
        error !== null &&
        Reflect.get(error, 'code') === 'lazy_module_closed';
      if (!isStaleExtensionContext(error) && !closedLoad) throw error;
    } finally {
      if (ownsDock) {
        closeTaskManager = undefined;
        dockOpen = false;
        updateUi(ctx);
      }
    }
  }

  pi.registerMessageRenderer<BgTaskSnapshot>(
    'background-task-notification',
    (message, _options, theme) => {
      const task = message.details;
      const status = task?.status ?? 'completed';
      const color: ThemeColor =
        status === 'completed'
          ? 'success'
          : status === 'failed'
            ? 'error'
            : status === 'killed'
              ? 'warning'
              : 'accent';
      const id = task?.id ?? 'background task';
      const name = task ? taskDisplayName(task) : 'Background task';
      const output = task?.outputPath ? `\n${theme.fg('dim', `Output: ${task.outputPath}`)}` : '';
      const error = task?.error ? `\n${theme.fg('error', task.error)}` : '';
      return new Text(
        `${theme.fg(color, `[bg ${status}]`)} ${theme.fg('accent', name)} ${theme.fg('dim', `(${id})`)}${output}${error}`,
        0,
        0,
      );
    },
  );

  pi.on('session_start', async (_event, ctx) => {
    // Pi replacement binds a fresh extension instance. Never revive this old
    // activation if a late lifecycle dispatch reaches it after shutdown.
    if (disposed) return;
    registry.setShuttingDown(false);
    currentCtx = ctx;
    const nextRegistryCtx = currentRegistryCtx ?? registryContext(ctx);
    currentRegistryCtx = nextRegistryCtx;
    await registry.ensureRuntimeDir(nextRegistryCtx);
    if (disposed) return;
    updateUi(ctx);
    if (disposed) return;
    if (statusInterval !== undefined) clearInterval(statusInterval);
    if (disposed) return;
    const nextStatusInterval = setInterval(() => {
      updateUiSafely();
    }, STATUS_INTERVAL_MS);
    if (disposed) {
      clearInterval(nextStatusInterval);
      return;
    }
    statusInterval = nextStatusInterval;
  });

  pi.on('session_shutdown', async (event, ctx) => {
    beginSessionShutdown(event.reason);
    if (shutdownCleanupStarted) return;
    shutdownCleanupStarted = true;
    try {
      // Admission closure aborts cooperative preflight and the drain retains
      // ownership until subprocess/file cleanup settles. Any admitted
      // child is inserted synchronously before spawn and is visible below.
      await registry.waitForTaskAdmissions();
      const running = registry.allTasks().filter((task) => task.status === 'running');
      if (running.length === 0) return;

      const failures: string[] = [];
      await Promise.all(
        running.map(async (task) => {
          try {
            await registry.stopTask(
              task,
              'shutdown',
              `Killed during Pi session shutdown (${event.reason})`,
            );
          } catch (error) {
            const message = `${task.id}: ${error instanceof Error ? error.message : String(error)}`;
            failures.push(message);
            console.error(`[background-tasks] shutdown cleanup failed for ${message}`);
          }
        }),
      );
      if (failures.length > 0 && ctx.hasUI) {
        ctx.ui.notify(`Background task cleanup failed:\n${failures.join('\n')}`, 'error');
      }
    } finally {
      eventService.close();
      if ((event.reason !== 'reload' || reloadHandoffFailed) && activationLease !== undefined) {
        try {
          await registry.waitForReloadHostSettlement();
        } catch (error) {
          console.error(
            '[background-tasks] reload owner host settlement failed during shutdown:',
            error,
          );
        }
        registry.releaseReloadActivation(activationLease);
        activationLease = undefined;
        activationIdentity = undefined;
      }
    }
  });

  pi.registerCommand('bg', {
    description:
      'Start a tracked shell command: /bg [--survive-reload] [--name "Task name"] <command>',
    handler: async (args, ctx) => {
      try {
        const parsed = parseBgCommandArgs(args);
        const taskOptions: StartTaskOptions = {
          surviveReload: parsed.surviveReload,
          notifyOnCompletion: true,
          triggerOnCompletion: false,
        };
        if (parsed.name !== undefined) taskOptions.name = parsed.name;
        const task = await startTask(ctx, parsed.command, taskOptions);
        ctx.ui.notify(
          `Started ${taskDisplayName(task)} (${task.id}), PID: ${String(task.pid ?? 'unknown')}\nOutput: ${task.outputPath}\nTerminal notification: enabled. Automatic steering / wake-up: disabled.`,
          'info',
        );
      } catch (error) {
        ctx.ui.notify(
          `Background task failed to start: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      }
    },
  });

  pi.registerCommand('tasks', {
    description: 'Open the background task manager UI',
    handler: async (args, ctx) => {
      const taskId = optionalTrimmed(args);
      await openTaskManager(ctx, taskId);
    },
  });

  pi.registerCommand('bg-tasks', {
    description: 'Open the background task manager UI',
    handler: async (args, ctx) => {
      const taskId = optionalTrimmed(args);
      await openTaskManager(ctx, taskId);
    },
  });

  pi.registerCommand('bg-clear', {
    description: 'Clear finished background task footer notices',
    handler: (_args, ctx) => {
      notifyClearFinishedNotices(ctx);
      return Promise.resolve();
    },
  });

  if (config.dockShortcut === 'shift+down') {
    pi.registerShortcut('shift+down' satisfies KeyId, {
      description: 'Open focused background task footer dock',
      handler: async (ctx) => {
        await openTaskManager(ctx);
      },
    });
  }

  if (config.dockShortcut === 'ctrl+alt+b') {
    pi.registerShortcut('ctrl+alt+b' satisfies KeyId, {
      description: 'Open focused background task footer dock',
      handler: async (ctx) => {
        await openTaskManager(ctx);
      },
    });
  }

  pi.registerShortcut('ctrl+alt+c' satisfies KeyId, {
    description:
      'Clear finished background task footer notices (terminal-dependent fallback for /bg-clear)',
    handler: (ctx) => {
      notifyClearFinishedNotices(ctx);
    },
  });

  pi.registerCommand('jobs', {
    description: 'List running and recent background tasks',
    handler: (_args, ctx) => {
      currentCtx = ctx;
      ctx.ui.notify(
        formatSnapshotList(registry.allTasks().map((task) => registry.snapshot(task))),
        'info',
      );
      updateUi(ctx);
      return Promise.resolve();
    },
  });

  pi.registerCommand('logs', {
    description: 'Show bounded output from a background task: /logs <id> [maxBytes]',
    getArgumentCompletions: (prefix) => {
      const matches = registry
        .allTasks()
        .filter((task) => task.id.startsWith(prefix.trim()))
        .slice(0, 20)
        .map((task) => ({
          value: task.id,
          label: `${task.id} ${taskDisplayName(task)}`,
          description: `${task.status} — ${truncateChars(task.command, 60)}`,
        }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      try {
        currentCtx = ctx;
        const [id, bytes] = args.trim().split(/\s+/, 2);
        const task = registry.resolveTask(id ?? '');
        const maxBytes = normalizeMaxBytes(Number(bytes), DEFAULT_LOG_BYTES);
        const logs = await registry.getTaskLogs(task, maxBytes, true);
        ctx.ui.notify(logs.text, 'info');
      } catch (error) {
        ctx.ui.notify(
          `Background logs error: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      }
    },
  });

  pi.registerCommand('kill', {
    description: 'Stop a running background task: /kill <id>',
    getArgumentCompletions: (prefix) => {
      const matches = registry
        .allTasks()
        .filter((task) => task.status === 'running' && task.id.startsWith(prefix.trim()))
        .slice(0, 20)
        .map((task) => ({
          value: task.id,
          label: `${task.id} ${taskDisplayName(task)}`,
          description: truncateChars(task.command, 70),
        }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      try {
        currentCtx = ctx;
        const task = registry.resolveTask(args.trim());
        await registry.stopTask(task, 'user');
        ctx.ui.notify(
          `Killed ${taskDisplayName(task)} (${task.id}). Output: ${task.outputPath}`,
          'info',
        );
        updateUi(ctx);
      } catch (error) {
        ctx.ui.notify(
          `Background kill error: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      }
    },
  });

  pi.registerTool<typeof BgRunParams, BgRunDetails>({
    name: 'bg_run',
    label: 'Background Run',
    description: BG_RUN_DESCRIPTION + shellPolicyDescription(shellPolicy),
    exposure: 'deferred',
    namespace: BG_TOOL_NAMESPACE,
    parameters: BgRunParams,
    prepareArguments: prepareBgRunArguments,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      params = prepareBgRunArguments(params);
      const taskOptions: StartTaskOptions = {
        name: params.name,
        surviveReload: params.surviveReload ?? false,
        notifyOnCompletion: params.notifyOnCompletion ?? true,
        triggerOnCompletion: params.triggerOnCompletion ?? true,
      };
      if (params.description !== undefined) taskOptions.description = params.description;
      if (params.timeoutSeconds !== undefined) taskOptions.timeoutSeconds = params.timeoutSeconds;
      const task = await startTask(ctx, params.command, taskOptions);
      return {
        content: textContent(
          `Started background task ${taskDisplayName(task)} (${task.id})\nStatus: ${task.status}\nPID: ${String(task.pid ?? 'unknown')}\nOutput: ${task.outputPath}\nTerminal notification: ${task.notifyOnCompletion ? 'enabled' : 'disabled'}.\nAutomatic steering / wake-up: ${task.notifyOnCompletion && task.triggerOnCompletion ? 'enabled' : 'disabled'}.`,
        ),
        details: { task: registry.snapshot(task) },
      };
    },
    renderCall(args, theme, context) {
      return renderBgToolCard(theme, {
        header: {
          title: 'bg_run',
          summary: truncateChars(taskDisplayName(args), COMMAND_PREVIEW_CHARS),
          state: cardStateFor(context),
        },
      });
    },
    renderResult(result, _options, theme) {
      const { task } = result.details;
      return renderBgToolCard(theme, {
        status: { state: 'success', message: `started ${taskDisplayName(task)} (${task.id})` },
        bodyLines: [theme.fg('dim', `Output: ${task.outputPath}`)],
      });
    },
  });

  pi.registerTool<typeof BgStatusParams, BgStatusDetails>({
    name: 'bg_status',
    label: 'Background Status',
    description:
      'Inspect one background task or list all running/recent background tasks. This is a point-in-time inspection tool, not a waiting primitive.',
    exposure: 'deferred',
    namespace: BG_TOOL_NAMESPACE,
    parameters: BgStatusParams,
    execute(_toolCallId, params) {
      const selected = params.taskId ? [registry.resolveTask(params.taskId)] : registry.allTasks();
      const snapshots = selected.map((task) => registry.snapshot(task));
      return Promise.resolve({
        content: textContent(formatSnapshotList(snapshots)),
        details: { tasks: snapshots },
      });
    },
    renderCall(args, theme, context) {
      return renderBgToolCard(theme, {
        header: { title: 'bg_status', summary: args.taskId, state: cardStateFor(context) },
      });
    },
    renderResult(result, _options, theme, context) {
      const text =
        result.content?.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('\n') ?? '';
      if (context?.isError) {
        return renderBgToolCard(theme, {
          status: { state: 'error', message: text },
        });
      }
      const tasks = result.details.tasks;
      return renderBgToolCard(theme, {
        status: { state: 'success', message: `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}` },
        bodyLines: text.split('\n'),
      });
    },
  });

  pi.registerTool<typeof BgLogsParams, BgLogsDetails>({
    name: 'bg_logs',
    label: 'Background Logs',
    description: `Read bounded output from a background task for deliberate inspection; this is not a waiting primitive. Output is capped at ${formatSize(MAX_LOG_BYTES)} for model safety and points to the full output file when truncated.`,
    exposure: 'deferred',
    namespace: BG_TOOL_NAMESPACE,
    parameters: BgLogsParams,
    async execute(_toolCallId, params) {
      const task = registry.resolveTask(params.taskId);
      const logs = await registry.getTaskLogs(
        task,
        normalizeMaxBytes(params.maxBytes),
        params.tail ?? true,
      );
      return {
        content: textContent(logs.text),
        details: logs.details,
      };
    },
    renderCall(args, theme, context) {
      return renderBgToolCard(theme, {
        header: { title: 'bg_logs', summary: args.taskId, state: cardStateFor(context) },
      });
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details;
      const bodyLines = [theme.fg('dim', `Full output: ${details.path}`)];
      if (expanded) {
        const output = result.content
          .map((content) => (content.type === 'text' ? content.text : '[image content]'))
          .join('\n');
        bodyLines.push(theme.fg('toolOutput', output.split('\n').slice(0, 30).join('\n')));
      }
      return renderBgToolCard(theme, {
        status: {
          state: details.truncated ? 'cancelled' : 'success',
          message: `${details.tail ? 'tail' : 'head'} · ${formatSize(details.bytesRead)}${details.truncated ? ' · truncated' : ''}`,
        },
        bodyLines,
      });
    },
  });

  pi.registerTool<typeof BgKillParams, BgKillDetails>({
    name: 'bg_kill',
    label: 'Background Kill',
    description:
      'Stop a running background task by ID. Fails loudly if the task is unknown or already finished.',
    exposure: 'deferred',
    namespace: BG_TOOL_NAMESPACE,
    parameters: BgKillParams,
    async execute(_toolCallId, params) {
      const task = registry.resolveTask(params.taskId);
      await registry.stopTask(task, 'user');
      const message = `Killed background task ${taskDisplayName(task)} (${task.id}). Output: ${task.outputPath}`;
      return {
        content: textContent(message),
        details: { task: registry.snapshot(task), message },
      };
    },
    renderCall(args, theme, context) {
      return renderBgToolCard(theme, {
        header: { title: 'bg_kill', summary: args.taskId, state: cardStateFor(context) },
      });
    },
    renderResult(result, _options, theme) {
      const { task } = result.details;
      return renderBgToolCard(theme, {
        status: { state: 'cancelled', message: `killed ${taskDisplayName(task)} (${task.id})` },
        bodyLines: [theme.fg('dim', `Output: ${task.outputPath}`)],
      });
    },
  });
}
