import { getStatusNote, formatStopReason } from "../status-note.js";
/**
 * tool-execution.ts — Agent tool execution handlers.
 *
 * Contains the execute callbacks registered for the Agent tool.
 * Spawn coordination, nudge scheduling, and live-view tracking have moved
 * to spawn-coordinator.ts. buildAgentDetails stays here as a pure helper.
 */

import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";

import type { AgentRecord, ThinkingLevel } from "../types.js";
import { SHORT_ID_LENGTH } from "../types.js";
import type { AgentConfig } from "./types.js";
import { formatAgentStatusList } from "./agent-status.js";
import { resolveType, getAgentConfig, resolveTypeOrDiscover, type TypeResolution } from "./agent-types.js";
import { getSessionContextPercent } from "./usage.js";
import { computeSpawnTarget, surfaceSpawnTargetWarnings } from "../spawn/spawn-target.js";

import { parseModelKey, resolveModel, parseThinkingChoice } from "../utils.js";
import { resolveThinkingLevel } from "../models/thinking-resolution.js";
import { getPiModelThinkingLevel } from "../pi-settings.js";
import { getPiInstance, getStore, getCoordinator, getManager } from "../shell.js";

// --- Tool result helpers ---

function successResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text", text }], details };
}

/**
 * The thinking a spawn of this call would run with, predicted at call time:
 * frontmatter > pi per-model > defaultThinking, resolving a configured `parent`
 * value at its own position against the parent session's current level.
 * Undefined when nothing is configured — the session is the source of truth
 * once it exists. The per-model term carries the spawn target's trust decision
 * into the settings read: computeSpawnTarget's validation plus trust decision,
 * run silently (execution owns the user-facing warnings). An untrusted target's
 * own project layer is then ignored, so its settings file cannot set the
 * spawn's thinking through the injected value (which wins as the explicit
 * param), while the user's global layer still applies — the scope the child's
 * session is created with.
 */
async function predictSpawnThinking(
  ctx: ExtensionContext,
  rawWorktree: unknown,
  agentConfig: AgentConfig | undefined,
  effectiveModel: string | undefined,
): Promise<ThinkingLevel | undefined> {
  // Non-string values count as omitted — computeSpawnTarget owns that
  // convention (raw arguments are unchecked), so the raw value passes through.
  const target = await computeSpawnTarget(ctx, rawWorktree);
  const modelKey = effectiveModel || (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "");
  const parsed = parseModelKey(modelKey);
  const perModel =
    target.ok && parsed
      ? getPiModelThinkingLevel(target.resolvedPath ?? ctx.cwd, parsed.provider, parsed.modelId, {
          projectTrusted: target.projectTrusted,
        })
      : undefined;
  return resolveThinkingLevel({
    frontmatter: agentConfig?.thinkingLevel,
    perModel,
    defaultThinking: getStore().agent.defaultThinking,
    parentLevel: ctx.thinkingLevel,
  });
}

/**
 * Validate worktree_path and gate cross-repo trust, surfacing warnings via
 * ctx.ui through the shared notify policy. Errors are LLM-facing and
 * self-correctable. The raw value is unchecked — computeSpawnTarget owns the
 * counts-as-omitted convention for non-blank strings.
 */
async function resolveWorktree(
  ctx: ExtensionContext,
  rawWorktreePath: unknown,
): Promise<
  { ok: true; resolvedPath?: string; worktreeLabel?: string; projectTrusted: boolean } | { ok: false; error: string }
> {
  const target = await computeSpawnTarget(ctx, rawWorktreePath);
  surfaceSpawnTargetWarnings(ctx.ui, target);
  if (!target.ok) {
    return { ok: false, error: target.error };
  }
  return {
    ok: true,
    resolvedPath: target.resolvedPath,
    worktreeLabel: target.worktreeLabel,
    projectTrusted: target.projectTrusted,
  };
}

/**
 * Build a details record from an AgentRecord. Always includes type and
 * description; includeStatus adds status/outputFile/stopReason, includeStats
 * adds turn/token/cost/context/compaction/model fields.
 */
export function buildAgentDetails(
  record: AgentRecord,
  opts?: { includeStats?: boolean; includeStatus?: boolean },
): Record<string, unknown> {
  const details: Record<string, unknown> = {
    type: record.display.type,
    description: record.display.description,
  };

  if (record.display.worktreePath) {
    details.worktreePath = record.display.worktreePath;
  }

  if (opts?.includeStatus) {
    details.status = record.lifecycle.status;
    details.outputFile = record.display.outputFile;
    const stopReason = formatStopReason(record.lifecycle);
    if (stopReason) details.stopReason = stopReason;
  }

  if (opts?.includeStats) {
    const elapsedMs = record.lifecycle.completedAt ? record.lifecycle.completedAt - record.lifecycle.startedAt : 0;

    details.turnCount = record.stats.turnCount;
    details.maxTurns = record.stats.maxTurns;
    details.toolUses = record.stats.toolUses;
    details.input = record.stats.lifetimeUsage.input;
    details.output = record.stats.lifetimeUsage.output;
    details.contextPercent = getSessionContextPercent(record.execution.session);
    details.durationMs = elapsedMs;
    details.compactions = record.stats.compactionCount;
    details.modelName = record.execution.session?.model?.name ?? record.display.invocation?.modelName;
    details.modelId = record.execution.session?.model?.id ?? record.display.invocation?.modelName;
    details.thinkingLevel = record.execution.session?.thinkingLevel ?? record.display.invocation?.thinkingLevel;
    details.cost = record.stats.lifetimeUsage.cost;
  }

  return details;
}

/**
 * Result text plus status note, for display. For error status, appends the
 * recorded error message so the nudge explains the failure.
 *
 * Shared by the foreground tool result and the subagent-result nudge so both
 * callers stay in sync on the nullish default and separator handling — they
 * have diverged before. getStatusNote owns the leading separator.
 */
export function formatResultContent(record: AgentRecord): string {
  // Only the nudge path formats error-status records as text: the foreground
  // handler intercepts error status earlier and throws instead.
  const errorNote = record.lifecycle.status === "error" && record.error ? `\n\nError: ${record.error}` : "";
  return (record.result ?? "") + errorNote + getStatusNote(record.lifecycle);
}

// --- Tool execute handlers ---

/** Listener and execution share the canonical, trust-gated profile identity. */
async function resolveSpawnAgentType(
  type: string,
  target: { projectTrusted: boolean; resolvedPath?: string },
): Promise<string> {
  const targetAgentsDir = target.projectTrusted && target.resolvedPath ? `${target.resolvedPath}/.pi/agents` : undefined;
  const resolution = await resolveTypeOrDiscover(type, targetAgentsDir);
  if (resolution.kind === "ambiguous") {
    // Two or more registered types differ only by case — never a silent pick.
    throw new Error(
      `Ambiguous agent type: ${type}. Candidates: ${resolution.candidates.join(", ")}. Use the exact registered name.`,
    );
  }
  if (resolution.kind === "not-found") {
    throw new Error(`Unknown agent type: ${type}`);
  }
  return resolution.key;
}

export async function executeAgentTool(
  _toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  _onUpdate: ((update: any) => void) | undefined,
  ctx: ExtensionContext,
): Promise<any> {
  // Validate worktree_path early — needed for on-demand agent discovery.
  // Raw and unchecked: computeSpawnTarget treats non-strings as omitted.
  const resolved = await resolveWorktree(ctx, params.worktree_path);
  if (!resolved.ok) throw new Error(resolved.error);
  const validatedWorktreePath = resolved.resolvedPath;
  const worktreeLabel = resolved.worktreeLabel;
  const projectTrusted = resolved.projectTrusted;

  const resolvedType = await resolveSpawnAgentType((params.agent as string) || "general-purpose", resolved);

  const prompt = params.prompt as string;
  const description =
    (params.description as string | undefined) || prompt.split("\n")[0].slice(0, 80) || prompt.slice(0, 80);
  const runInBackground = params.run_in_background as boolean | undefined;
  const maxTurns =
    (params.max_turns as number | undefined) ??
    getAgentConfig(resolvedType)?.maxTurns ??
    getStore().agent.defaultMaxTurns;

  const modelStr = params.model ??
    getStore().modelFor(resolvedType, undefined, getAgentConfig(resolvedType));
  const model = resolveModel(modelStr, ctx.modelRegistry, ctx.model);
  const modelKey = model ? `${model.provider}/${model.id}` : undefined;

  // Determine modelName for invocation (always capture for display)
  const modelName = model?.id;

  // Resolve thinking: explicit param > agent config (frontmatter) > undefined.
  // Per-model and defaultThinking are deliberately NOT resolved here — the
  // spawn runner owns them (its trust-gated settings read keeps per-model
  // above defaultThinking; folding them into this explicit param would shadow
  // per-model). When the listener ran, it already injected the full chain.
  // A `parent` value resolves here because the explicit param and the stored
  // invocation must never carry it; the parent's level needs no trust gate.
  const thinkingLevel = resolveThinkingLevel({
    explicit: parseThinkingChoice(params.thinking as string | undefined),
    frontmatter: getAgentConfig(resolvedType)?.thinkingLevel,
    parentLevel: ctx.thinkingLevel,
  });

  const coordinator = getCoordinator()!;
  // Background spawns (explicit or forceBackground) never bind to the parent
  // run's interrupt signal — only foreground spawns can be interrupted.
  const isBackground = runInBackground || getStore().agent.forceBackground;

  const result = await coordinator.spawn(getPiInstance(), ctx, {
    type: resolvedType,
    prompt,
    description,
    model,
    modelKey,
    maxTurns,
    thinkingLevel,
    graceTurns: getStore().agent.graceTurns,
    worktreePath: validatedWorktreePath,
    worktreeLabel,
    projectTrusted,
    invocation: { modelName, thinkingLevel, maxTurns },
    runInBackground: isBackground,
    signal: isBackground ? undefined : signal,
  });

  const { agentId, record } = result;

  // Store toolCallId in record for call renderer to find agent
  if (_toolCallId) {
    record.display.toolCallId = _toolCallId;
  }

  if (isBackground) {
    const suffix = `Success! You delegated to an agent. A notification will arrive when done - USER: do not poll, don't check status and don't duplicate the delegated work!\n\nAgent ID: ${agentId}`;
    const label = record.lifecycle.status === "queued" ? "Agent queued" : "Agent running";
    const details = buildAgentDetails(record);
    details.agentId = agentId;
    details.status = record.lifecycle.status;
    return successResult(`[${label}] ${suffix}`, details);
  }

  // Foreground: record.execution.promise is already awaited by coordinator.spawn()
  const details = buildAgentDetails(record, { includeStats: true });

  if (record.lifecycle.status === "error") {
    throw new Error(`Agent failed: ${record.error || "unknown error"}`);
  }

  return successResult(formatResultContent(record), details);
}

// --- Running agents list helper (used by executeStopAgentTool) ---

/**
 * Build a compact list of running (or queued) agents.
 * Format: "short_id (type), short_id (type)" — one line, easy for LLM to parse.
 */
function formatRunningAgents(): string {
  const agents = getManager()!
    .listAgents()
    .filter((a) => a.lifecycle.status === "running" || a.lifecycle.status === "queued");

  if (agents.length === 0) return "none";

  return agents.map((a) => `${a.id.slice(0, SHORT_ID_LENGTH)} (${a.display.type})`).join(", ");
}

/** Resolve only at the tool boundary; manager/session identity stays exact. */
function resolveAgentRecord(rawId: unknown, availableAgents: () => string): AgentRecord {
  const id = typeof rawId === "string" ? rawId.trim() : "";
  if (!id) throw new Error("agent_id is required");

  const manager = getManager()!;
  const exact = manager.getRecord(id);
  if (exact) return exact;
  const matches = manager.listAgents().filter((record) => record.id.startsWith(id));
  if (matches.length === 0) {
    throw new Error(`Agent ${id} not found. ${availableAgents()}`);
  }
  if (matches.length > 1) {
    const candidates = matches.map((record) => `${record.id} (${record.display.type})`).join(", ");
    throw new Error(`Ambiguous agent id ${id}. Matching agents: ${candidates}. Use a longer id.`);
  }
  return matches[0];
}

// --- StopAgent execute handler ---

export async function executeStopAgentTool(
  _toolCallId: string,
  params: Record<string, unknown>,
  _signal: AbortSignal | undefined,
  _onUpdate: ((update: any) => void) | undefined,
  _ctx: ExtensionContext,
): Promise<any> {
  const record = resolveAgentRecord(params.agent_id, () => `Running agents: ${formatRunningAgents()}`);
  const agentId = record.id;

  if (record.lifecycle.status !== "running" && record.lifecycle.status !== "queued") {
    return successResult(
      `Agent ${agentId} is already ${record.lifecycle.status}. Running agents: ${formatRunningAgents()}`,
    );
  }

  if (getManager()!.abort(agentId, "agent")) {
    return successResult(`Stopped agent ${agentId.slice(0, SHORT_ID_LENGTH)}`);
  }

  throw new Error(`Failed to stop agent ${agentId}`);
}

// --- MessageAgent execute handler ---

export async function executeMessageAgentTool(
  _toolCallId: string,
  params: Record<string, unknown>,
  _signal: AbortSignal | undefined,
  _onUpdate: ((update: any) => void) | undefined,
  _ctx: ExtensionContext,
): Promise<any> {
  const record = resolveAgentRecord(params.agent_id, () => {
    const list = formatAgentStatusList(getManager()!.listAgents(), getStore().agent.agentStatusLimit);
    return `Available agents: ${list || "none"}`;
  });
  const message = typeof params.message === "string" ? params.message.trim() : "";
  if (!message) throw new Error("message is required");

  const shortId = record.id.slice(0, SHORT_ID_LENGTH);
  const running = record.lifecycle.status === "running";
  if (!running && !record.execution.session) {
    return successResult(`Message not sent to agent ${shortId}: no session (status: ${record.lifecycle.status}).`);
  }
  // steer owns setup buffering, settled-session continuation and concurrency
  // admission. Do not create another record or bypass its refusal conditions.
  if (!(await getManager()!.steer(record.id, message))) {
    throw new Error(`Failed to message agent ${record.id}: cannot steer or continue (status: ${record.lifecycle.status}).`);
  }
  return successResult(`Sent (${running ? "steered" : "continued"}) to agent ${shortId}.`);
}

// --- Tool_call listener — inject model into Agent tool calls ---

export async function toolCallListener(event: ToolCallEvent, ctx: ExtensionContext): Promise<void> {
  if (event.toolName !== "Agent") return;

  const input = event.input;
  const target = await computeSpawnTarget(ctx, input.worktree_path);
  if (!target.ok) return; // Execution owns target errors and warnings; no spawn title to predict.
  const subagentType = await resolveSpawnAgentType((input.agent as string | undefined) || "general-purpose", target);
  const agentConfig = getAgentConfig(subagentType);

  const modelStr = input.model ?? getStore().modelFor(subagentType, undefined, agentConfig);
  const model = resolveModel(modelStr, ctx.modelRegistry, ctx.model);
  const effectiveModel = model ? `${model.provider}/${model.id}` : "";

  if (model) {
    // Keep inheritance distinct from an explicit registry selection.
    if (modelStr) input.model = effectiveModel;
    // Validate before advertising the selected model in renderCall.
    input._modelOverride = model.id;
  }

  // Inject the spawn-effective thinking when the call carries none. The
  // injected value becomes the explicit param at execution, so it must mirror
  // the runtime chain — an injection that diverged would change behavior, not
  // just display.
  if (input.thinking === undefined) {
    input.thinking = await predictSpawnThinking(ctx, input.worktree_path, agentConfig, effectiveModel);
  }
}
