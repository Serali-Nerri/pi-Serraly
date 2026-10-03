/**
 * Core execution engine: creates sessions, runs agents, collects results.
 *
 * Tool visibility policy is owned by agent-types.ts (resolveVisibleTools).
 */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  loadProjectContextFiles,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  getAgentConfig,
  getConfig,
  resolveSessionToolSelection,
  resolveVisibleTools,
} from "./agent-types.js";
import { extractText } from "../prompt/context.js";
import { readDefaultTools } from "../pi-settings.js";
import { resolveThinkingLevel } from "../models/thinking-resolution.js";
import type { AgentUsage } from "./usage.js";
import { findModelInRegistry, GIT_EXEC_TIMEOUT_MS } from "../utils.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import { buildAgentPrompt, type PromptExtras } from "../prompt/prompts.js";
import { preloadSkills, loadSkillMeta } from "../prompt/skill-loader.js";
import { type EnvInfo, type RunCallbacks, type RunTunables, SHORT_ID_LENGTH } from "../types.js";
import type { SubagentType, SystemPromptMode } from "./types.js";
import { getStore } from "../shell.js";
import { runInSubagentContext } from "./spawn-context.js";
import { buildExtToolMap, resolveChildExtensions } from "./extension-selection.js";
import { createExtensionDenyGuard } from "./tool-policy.js";
import { closeAgentSession } from "./session-cleanup.js";
import { DEFAULT_GRACE_TURNS, customPromptPath } from "../config/config-io.js";
import { patchRetryClassifier } from "./stream-retry.js";
import { applyOutputLimit, resolveOutputLimit } from "./max-tokens-field.js";

/** Normalize max turns. undefined or 0 = unlimited, otherwise minimum 1. */
function normalizeMaxTurns(n: number | undefined): number | undefined {
  if (n == null || n === 0) return undefined;
  return Math.max(1, n);
}

interface RunOptions extends RunTunables, RunCallbacks {
  /** ExtensionAPI instance — used for pi.exec() for git detection. */
  pi: ExtensionAPI;
  /** Manager-assigned id; suffixes session name to disambiguate parallel spawns (e.g. `Explore#a1b2c3d4`). */
  agentId?: string;
  cwd?: string;
  /**
   * Trust state for the target project. False = ignore the target's project
   * resources. Absent inherits the parent only for the same cwd.
   */
  projectTrusted?: boolean;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
}

export interface RunResult {
  responseText: string;
  session: AgentSession;
  /** True if the agent was hard-aborted (max_turns + grace exceeded). */
  aborted: boolean;
  /** True if the agent hit the soft turn limit and wrapped up within grace turns. */
  turnLimited: boolean;
  /**
   * Provider error message when the run ended in a model error: the final
   * assistant message has stopReason "error". Absent for normal, aborted,
   * and turn-limited runs, and for transient errors superseded by a later turn.
   */
  modelError?: string;
}

/**
 * Options for prompting a session, whether first run or continuation.
 * Carries the callbacks the manager wires for record tracking and live-view
 * updates; the session itself is reused by continuations.
 */
export interface SessionPromptOptions extends RunCallbacks {
  maxTurns?: number;
  graceTurns?: number;
  /** Abort signal forwarded to session.abort() while the prompt runs. */
  signal?: AbortSignal;
}

function collectResponseText(session: AgentSession, onTextDelta?: (delta: string, fullText: string) => void) {
  let text = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_start") {
      text = "";
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      text += event.assistantMessageEvent.delta;
      onTextDelta?.(event.assistantMessageEvent.delta, text);
    }
  });
  return { getText: () => text, unsubscribe };
}

function getLastAssistantText(session: AgentSession, fromIndex: number): string {
  for (let i = session.messages.length - 1; i >= fromIndex; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    const text = extractText(msg.content).trim();
    if (text) return text;
  }
  return "";
}

/**
 * The provider error message when the run ended in a model error: the final
 * assistant message has stopReason "error". Returns undefined when the final
 * assistant message ended normally (or was aborted), so a transient error
 * followed by a successful turn never fails the run.
 */
function getFinalModelError(session: AgentSession): string | undefined {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    if (msg.stopReason !== "error") return undefined;
    return msg.errorMessage && msg.errorMessage.trim() ? msg.errorMessage : undefined;
  }
  return undefined;
}

function forwardAbortSignal(session: AgentSession, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  // abort() returns a promise and this fires from an event listener, so a
  // rejection escapes the run rather than failing it. Node re-throws a
  // listener's returned rejected promise as an uncaught exception, and the
  // parent is already going down when this runs.
  const onAbort = () => {
    void session.abort().catch(() => {});
  };
  if (signal.aborted) onAbort();
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/**
 * Extract a LifetimeUsage from a runtime assistant message_end event.
 * pi-ai attaches `usage: { input, output, cacheWrite, cost: { total } }` to
 * assistant messages at runtime, but this shape isn't reflected in the
 * AgentSessionEvent public types.
 */
function usageFromAssistantMessage(msg: Record<string, unknown>): AgentUsage | undefined {
  const usage = msg.usage as Record<string, unknown> | undefined;
  if (!usage) return undefined;
  return {
    input: (usage.input as number) ?? 0,
    output: (usage.output as number) ?? 0,
    cacheWrite: (usage.cacheWrite as number) ?? 0,
    cacheRead: (usage.cacheRead as number) ?? 0,
    cost: ((usage.cost as Record<string, unknown>)?.total as number) ?? 0,
  };
}

export function subscribeToSessionEvents(
  session: AgentSession,
  options: Pick<RunCallbacks, "onToolActivity" | "onAssistantUsage" | "onCompaction">,
): () => void {
  if (!options.onToolActivity && !options.onAssistantUsage && !options.onCompaction) {
    return () => {};
  }
  return session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "tool_execution_start") {
      options.onToolActivity?.({ type: "start", toolName: event.toolName, toolCallId: event.toolCallId });
    }
    if (event.type === "tool_execution_end") {
      options.onToolActivity?.({ type: "end", toolName: event.toolName, toolCallId: event.toolCallId });
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const msg = event.message as unknown as Record<string, unknown>;
      const usage = usageFromAssistantMessage(msg);
      if (usage) {
        options.onAssistantUsage?.(usage);
      }
    }
    if (event.type === "compaction_end" && !event.aborted && event.result) {
      options.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore });
    }
  });
}

async function execGit(pi: ExtensionAPI, args: string[], cwd: string): Promise<string | null> {
  try {
    const result = await pi.exec("git", args, { cwd, timeout: GIT_EXEC_TIMEOUT_MS });
    return result.code === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/** Inline replacement for upstream's detectEnv — uses pi.exec for git detection. */
async function detectEnv(pi: ExtensionAPI, cwd: string): Promise<EnvInfo> {
  const gitRoot = await execGit(pi, ["rev-parse", "--is-inside-work-tree"], cwd);
  const isGitRepo = gitRoot === "true";
  const branch = isGitRepo ? await execGit(pi, ["branch", "--show-current"], cwd) : null;

  return {
    isGitRepo,
    branch,
    platform: process.platform,
  };
}

// ── runAgent phases ────────────────────────────────────────────────

/**
 * Effective system prompt mode for an agent: the global mode overridden by
 * the agent's include_system_prompt frontmatter field.
 *
 * - false → replace (never inherit or custom)
 * - true → inherit, except when the global mode is custom (custom wins)
 * - undefined → global mode
 */
export function resolveEffectiveSystemPromptMode(
  globalMode: SystemPromptMode,
  includeSystemPrompt: boolean | undefined,
): SystemPromptMode {
  if (includeSystemPrompt === false) return "replace";
  if (includeSystemPrompt === true && globalMode !== "custom") return "inherit";
  return globalMode;
}

function resolveSystemPromptSources(
  ctx: ExtensionContext,
  cwd: string,
  notify: (msg: string) => void,
  agentConfig: ReturnType<typeof getAgentConfig>,
  agentDir: string,
  rebuildInherited: boolean,
): {
  mode: SystemPromptMode;
  extras: Pick<PromptExtras, "parentSystemPrompt" | "customSystemPrompt" | "contextFiles">;
} {
  const store = getStore();
  // Per-agent frontmatter overrides win; unset fields follow the global config.
  const mode = resolveEffectiveSystemPromptMode(store.agent.systemPromptMode, agentConfig?.includeSystemPrompt);
  const includeContextFiles = agentConfig?.includeContextFiles ?? store.agent.includeContextFiles;
  const extras: Pick<PromptExtras, "parentSystemPrompt" | "customSystemPrompt" | "contextFiles"> = {};

  if (mode === "inherit" && !rebuildInherited) {
    try {
      extras.parentSystemPrompt = ctx.getSystemPrompt();
    } catch (err) {
      notify(`Failed to get parent system prompt: ${err}. Falling back to replace mode.`);
    }
  }

  if (mode === "custom") {
    const promptPath = customPromptPath(agentDir);
    try {
      const content = fs.readFileSync(promptPath, "utf-8").trim();
      if (content) {
        extras.customSystemPrompt = content;
      } else {
        notify(`Custom prompt file is empty: ${promptPath}. Falling back to replace mode.`);
      }
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") {
        notify(`Custom prompt file not found: ${promptPath}. Falling back to replace mode.`);
      } else {
        notify(`Failed to read custom prompt file: ${err instanceof Error ? err.message : String(err)}. Falling back to replace mode.`);
      }
    }
  }

  if (includeContextFiles && !(mode === "inherit" && rebuildInherited)) {
    try {
      extras.contextFiles = loadProjectContextFiles({ cwd, agentDir });
    } catch {
      // Non-fatal: context files are supplementary
    }
  }

  return { mode, extras };
}

function buildPrompt(
  type: SubagentType,
  agentConfig: ReturnType<typeof getAgentConfig>,
  config: ReturnType<typeof getConfig>,
  cwd: string,
  env: EnvInfo,
  systemPromptMode: SystemPromptMode = "replace",
  resolverExtras: Pick<PromptExtras, "parentSystemPrompt" | "customSystemPrompt" | "contextFiles"> = {},
  agentDir: string = getAgentDir(),
  projectTrusted: boolean = true,
): string {
  const extras: PromptExtras = { ...resolverExtras };
  if (Array.isArray(agentConfig?.preloadSkills)) {
    extras.skillBlocks = preloadSkills(agentConfig.preloadSkills, cwd, agentDir, projectTrusted);
  }
  if (Array.isArray(config.skills)) {
    extras.skillMetas = loadSkillMeta(config.skills, cwd, agentDir, projectTrusted);
  }
  if (agentConfig) {
    return buildAgentPrompt(agentConfig, cwd, env, extras, systemPromptMode);
  }
  const fallback = DEFAULT_AGENTS.get("general-purpose");
  if (!fallback) throw new Error(`No fallback config available for unknown type "${type}"`);
  return buildAgentPrompt({ ...fallback, name: type }, cwd, env, extras, systemPromptMode);
}

async function createResourceLoader(
  config: ReturnType<typeof getConfig>,
  agentConfig: ReturnType<typeof getAgentConfig>,
  cwd: string,
  systemPrompt: string,
  settingsManager: SettingsManager,
  notify?: (msg: string) => void,
  rebuildInherited = false,
) {
  const noSkills = config.skills === false || Array.isArray(config.skills) || Array.isArray(agentConfig?.preloadSkills);
  const agentDir = getAgentDir();
  const selection = await resolveChildExtensions({
    cwd, agentDir, settingsManager, extensions: config.extensions,
    excludeExtensions: agentConfig?.excludeExtensions, notify,
  });
  const denyGuard = Array.isArray(agentConfig?.tools) ? undefined : createExtensionDenyGuard({
    excludedEntries: agentConfig?.excludeTools ?? [],
    aliasesByPath: selection.aliasesByPath,
  });
  const loaderOpts: ConstructorParameters<typeof DefaultResourceLoader>[0] = {
    cwd,
    agentDir,
    settingsManager,
    // Resource discovery selected paths without executing any factories.
    // Never let reload implicitly execute the rest of the configured package.
    noExtensions: true,
    additionalExtensionPaths: selection.additionalExtensionPaths,
    extensionFactories: denyGuard ? [...selection.extensionFactories, denyGuard] : selection.extensionFactories,
    noSkills,
    noPromptTemplates: true,
    noThemes: true,
    // Different cwd/trust scopes use Pi's target-native prompt assembly.
    // Never parse/copy project scaffolding from the opaque parent prompt.
    noContextFiles: rebuildInherited
      ? !(agentConfig?.includeContextFiles ?? getStore().agent.includeContextFiles) : true,
    systemPromptOverride: rebuildInherited ? undefined : () => systemPrompt,
    appendSystemPromptOverride: rebuildInherited ? (base) => [...base, systemPrompt] : () => [],
  };
  const loader = new DefaultResourceLoader(loaderOpts);
  return {
    loader,
    reloadAndMap: async () => {
      await loader.reload();
      const extResult = loader.getExtensions();
      return { extResult, extToolMap: buildExtToolMap(extResult.extensions, selection.aliasesByPath) };
    },
  };
}

function hasOpenAIResponsesOutputLimit(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    Object.prototype.hasOwnProperty.call(payload, "max_output_tokens")
  );
}

async function initSession(
  ctx: ExtensionContext,
  options: RunOptions,
  agentConfig: ReturnType<typeof getAgentConfig>,
  cwd: string,
  loader: DefaultResourceLoader,
  extToolMap: Map<string, string[]>,
  settingsManager: SettingsManager,
  onAllocated: (session: AgentSession) => void,
  notify: (message: string) => void,
): Promise<AgentSession> {
  const model = options.model ?? findModelInRegistry(agentConfig?.model, ctx.modelRegistry, ctx.model);
  // Per-model comes from the same trust-gated instance the session is created
  // with, so the project-trust gate applies to the read identically. When
  // every source is unset nothing is passed and pi's own fallback applies
  // (defaultThinkingLevel setting → medium, clamped to the model).
  const perModelLevel = model ? settingsManager.getModelThinkingLevel(model.provider, model.id) : undefined;
  const thinkingLevel = resolveThinkingLevel({
    explicit: options.thinkingLevel,
    frontmatter: agentConfig?.thinkingLevel,
    perModel: perModelLevel,
    defaultThinking: getStore().agent.defaultThinking,
  });
  const agentDir = getAgentDir();
  const sessionOpts: Parameters<typeof createAgentSession>[0] = {
    cwd,
    agentDir,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    model,
    ...resolveSessionToolSelection({
      registeredTools: agentConfig?.registeredTools,
      tools: agentConfig?.tools,
      excludeTools: agentConfig?.excludeTools,
      extToolMap,
      notify,
    }),
    resourceLoader: loader,
  };
  if (thinkingLevel) sessionOpts.thinkingLevel = thinkingLevel;
  const result = await createAgentSession(sessionOpts);
  const session = result.session;
  onAllocated(session);
  patchRetryClassifier(session);

  // Inject the output-limit field into provider payloads; spawn-time value wins
  // over agent config. Location per request, per pi's per-API algorithm:
  // openai-completions follows the compat chain (explicit
  // model.compat.maxTokensField, else provider/URL detection, else
  // max_completion_tokens); the OpenAI Responses family uses max_output_tokens
  // clamped to pi's minimum of 16 (openai-responses only when the model
  // hasn't disabled compat.supportsMaxOutputTokens); anthropic uses
  // top-level max_tokens; bedrock nests the cap at inferenceConfig.maxTokens;
  // both google APIs nest it at config.maxOutputTokens; mistral uses
  // top-level maxTokens; pi-messages nests it at options.maxTokens.
  const maxTokens = options.maxTokens ?? agentConfig?.maxTokens;
  if (maxTokens != null && maxTokens > 0 && model) {
    const origOnPayload = session.agent.onPayload;
    session.agent.onPayload = async (payload, m) => {
      const applied = origOnPayload ? ((await origOnPayload(payload, m)) ?? payload) : payload;
      // Resolved per request so a mid-run setModel stays in sync with pi
      // instead of desyncing on a captured field. Undefined means pi sends
      // no output-limit field for this model; the hook must not inject one.
      // Post-build overwrite by design (as in the prior fix): pi's context
      // clamp and thinking-budget adjust already ran on the model default.
      const limit = resolveOutputLimit(m, maxTokens);
      // Pi omits this for ChatGPT sign-in, so preserve that auth-specific decision.
      if (!limit || (m.api === "openai-responses" && !hasOpenAIResponsesOutputLimit(applied))) return applied;
      return applyOutputLimit(applied, limit);
    };
  }

  return session;
}

async function createAndConfigureSession(
  ctx: ExtensionContext,
  options: RunOptions,
  agentConfig: ReturnType<typeof getAgentConfig>,
  type: SubagentType,
  cwd: string,
  loader: DefaultResourceLoader,
  extToolMap: Map<string, string[]>,
  settingsManager: SettingsManager,
  notify: (msg: string) => void,
): Promise<AgentSession> {
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // An allocation owner may attach later; startup rejection is still handled.
  void ready.catch(() => {});
  let session: AgentSession | undefined;
  try {
    session = await initSession(ctx, options, agentConfig, cwd, loader, extToolMap, settingsManager, (allocated) => {
      session = allocated;
      options.onSessionAllocated?.(allocated, ready);
    }, notify);
    const baseName = agentConfig?.name ?? type;
    session.setSessionName(options.agentId ? `${baseName}#${options.agentId.slice(0, SHORT_ID_LENGTH)}` : baseName);
    await session.bindExtensions({
      onError: (err) => options.onToolActivity?.({ type: "end", toolName: `extension-error:${err.extensionPath}` }),
    });

    // Inherit mode must not turn a startup active-tools snapshot into a gate.
    // Authored restrictions already constrain registration/callability in SDK.
    if ((agentConfig?.tools !== undefined && agentConfig.tools !== true) || agentConfig?.registeredTools !== undefined) {
      const filtered = resolveVisibleTools({
        activeTools: session.getActiveToolNames(),
        tools: agentConfig?.tools,
        excludeTools: agentConfig?.excludeTools,
        extToolMap, notify,
      });
      if (filtered) session.setActiveToolsByName(filtered);
    }
    options.onSessionCreated?.(session);
    resolveReady();
    return session;
  } catch (error) {
    rejectReady(error);
    try { await closeAgentSession(session, "quit", ready); } catch (cleanupError) {
      if (cleanupError !== error) {
        throw new AggregateError([error, cleanupError], `Subagent initialization failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error });
      }
    }
    throw error;
  }
}
function wireTurnTracking(session: AgentSession, options: Pick<RunOptions, "maxTurns" | "graceTurns" | "onTurnEnd">) {
  let turnCount = 0;
  const maxTurns = normalizeMaxTurns(options.maxTurns);
  let softLimitReached = false;
  let aborted = false;
  const graceTurns = options.graceTurns ?? DEFAULT_GRACE_TURNS;

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type !== "turn_end") return;
    turnCount++;
    options.onTurnEnd?.(turnCount);
    if (maxTurns == null) return;
    if (!softLimitReached && turnCount >= maxTurns) {
      softLimitReached = true;
      // steer() returns a promise and fires from a subscribe callback: a
      // rejection would escape the run. It only costs the graceful wrap-up;
      // the hard abort below still fires.
      void session
        .steer("You have reached your turn limit. Wrap up immediately — provide your final answer now.")
        .catch(() => {});
    } else if (softLimitReached && turnCount >= maxTurns + graceTurns) {
      aborted = true;
      // `aborted` is already set, so a rejected abort() cannot change the
      // reported outcome — only swallow the rejection.
      void session.abort().catch(() => {});
    }
  });

  return { unsubscribe, getAborted: () => aborted, getTurnLimited: () => softLimitReached };
}

async function runTurnLoop(
  session: AgentSession,
  prompt: string,
  options: { signal?: AbortSignal } & RunCallbacks,
  unsubTurns: () => void,
) {
  const unsubEvents = subscribeToSessionEvents(session, options);
  const collector = collectResponseText(session, options.onTextDelta);
  const cleanupAbort = forwardAbortSignal(session, options.signal);
  // Messages already in the session before this prompt belong to earlier runs;
  // the fallback must not surface their text when this run fails (model error
  // or abort with no output) — that would resurrect a prior run's result.
  const messageStart = session.messages.length;
  try {
    if (!options.signal?.aborted) await session.prompt(prompt);
  } finally {
    unsubTurns();
    unsubEvents();
    collector.unsubscribe();
    cleanupAbort();
  }
  return collector.getText().trim() || getLastAssistantText(session, messageStart);
}

/**
 * Run a single prompt against a session: wire turn tracking, event
 * subscription, response collection, and abort forwarding, prompt, then
 * assemble the RunResult. Shared by the first run (runAgentImpl) and
 * continuations (continueAgentSession) so the two paths cannot drift.
 */
async function runSessionPrompt(
  session: AgentSession,
  prompt: string,
  options: SessionPromptOptions,
): Promise<RunResult> {
  if (options.signal?.aborted) {
    void session.abort().catch(() => {});
    return { responseText: "", session, aborted: true, turnLimited: false };
  }
  const { unsubscribe: unsubTurns, getAborted, getTurnLimited } = wireTurnTracking(session, options);
  const responseText = await runTurnLoop(session, prompt, options, unsubTurns);
  return {
    responseText,
    session,
    aborted: getAborted() || options.signal?.aborted === true,
    turnLimited: getTurnLimited(),
    modelError: getFinalModelError(session),
  };
}

/**
 * Prompt an existing session after its original run settled (the fork's
 * continueAgentSession() shape).
 *
 * Unlike runAgent, the session already exists: onSessionCreated is never
 * called, and there is no session setup (model resolution, resource loader,
 * tool filtering). The result keeps the runAgent shape (including
 * modelError) so the manager classifies the continuation exactly like the
 * first run.
 */
export async function continueAgentSession(
  session: AgentSession,
  prompt: string,
  options: SessionPromptOptions = {},
): Promise<RunResult> {
  return runSessionPrompt(session, prompt, options);
}

// ── main entry ─────────────────────────────────────────────────────

export async function runAgent(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
  return runInSubagentContext(() => runAgentImpl(ctx, type, prompt, options));
}

async function runAgentImpl(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
  const store = getStore();
  const effectiveCwd = options.cwd ?? ctx.cwd;
  const agentDir = getAgentDir();
  const parentTrusted = ctx.isProjectTrusted();
  const sameCwd = path.resolve(effectiveCwd) === path.resolve(ctx.cwd);
  const projectTrusted = options.projectTrusted ??
    (sameCwd ? parentTrusted : false);
  const rebuildInherited = !sameCwd || projectTrusted !== parentTrusted;

  // One SettingsManager for the whole spawn: its trust state gates both the
  // resource loader (project extensions/skills/prompts/themes/system prompt
  // files) and the session context (ctx.isProjectTrusted). Created before
  // getConfig so its defaultTools setting can feed the resolved config and
  // the session tool gate from the same instance.
  const settingsManager = SettingsManager.create(effectiveCwd, agentDir, {
    projectTrusted,
  });

  // Read once per spawn: getConfig and getToolNamesForType share this value,
  // so their fallbacks cannot diverge. undefined = setting unconfigured.
  const defaultTools = readDefaultTools(settingsManager);

  const config = getConfig(type, store.agent.loadSkillsImplicitly, store.agent.loadExtensionsImplicitly, defaultTools);
  const agentConfig = getAgentConfig(type);

  // Buffer warnings during setup to avoid inserting custom_message entries
  // between tool_use and tool_result in the session tree (causes Anthropic 400).
  // Flushed after runTurnLoop completes.
  const warnings: string[] = [];
  const bufferNotify = (msg: string) => {
    warnings.push(msg);
  };
  if (agentConfig?.excludeTools && Array.isArray(agentConfig.tools)) {
    bufferNotify(`agent "${type}": both tools and exclude_tools set — tools (whitelist) wins`);
  }
  if (agentConfig?.excludeExtensions && Array.isArray(agentConfig.extensions)) {
    bufferNotify(`agent "${type}": both extensions and exclude_extensions set — extensions (whitelist) wins`);
  }

  const env = await detectEnv(options.pi, effectiveCwd);

  const { mode, extras: promptExtras } = resolveSystemPromptSources(ctx, effectiveCwd, bufferNotify, agentConfig, agentDir, rebuildInherited);

  const systemPrompt = buildPrompt(type, agentConfig, config, effectiveCwd, env, mode, promptExtras, agentDir, projectTrusted);
  const { loader, reloadAndMap } = await createResourceLoader(
    config,
    agentConfig,
    effectiveCwd,
    systemPrompt,
    settingsManager,
    bufferNotify,
    mode === "inherit" && rebuildInherited,
  );
  const { extToolMap } = await reloadAndMap();
  const session = await createAndConfigureSession(
    ctx,
    options,
    agentConfig,
    type,
    effectiveCwd,
    loader,
    extToolMap,
    settingsManager,
    bufferNotify,
  );
  const result = await runSessionPrompt(session, prompt, {
    ...options,
    maxTurns: options.maxTurns ?? agentConfig?.maxTurns,
  });

  // Flush buffered warnings now that tool_result is in the session tree.
  for (const msg of warnings) {
    if (ctx.ui?.notify) ctx.ui.notify(`[pi-subagents-lite] ${msg}`, "warning");
    else console.warn(`[pi-subagents-lite] ${msg}`);
  }

  return result;
}
