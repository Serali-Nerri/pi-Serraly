/**
 * restart-last-agents.ts — Find and replay Agent tool calls from session history.
 *
 * Reads the current session's entry list, locates the most recent assistant
 * message containing Agent tool calls, and replays them via the coordinator.
 * Running agents are skipped.
 */

import type { ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { UICtx } from "../ui/agent-widget.js";
import { getCoordinator, getManager, getPiInstance, getStore, getWidget } from "../shell.js";
import { parseThinkingLevel, resolveModel } from "../utils.js";
import { resolveTypeOrDiscover, getAgentConfig } from "./agent-types.js";
import { computeSpawnTarget, surfaceSpawnTargetWarnings } from "../spawn/spawn-target.js";

/** Extracted parameters from a historical Agent tool call. */
export interface AgentCallParams {
  prompt: string;
  description?: string;
  agent?: string;
  worktree_path?: string;
  model?: string;
  thinking?: string;
  run_in_background?: boolean;
  max_turns?: number;
}

/** Result of a restart attempt. */
export interface RestartResult {
  restarted: string[];
  skipped: string[];
}

/**
 * Find Agent tool calls from the most recent assistant message in session entries.
 *
 * Returns the arguments of every `Agent` tool call found in the latest assistant
 * message that contains at least one. Returns an empty array if none exist.
 */
export function findLastAgentCallsFromEntries(entries: SessionEntry[]): AgentCallParams[] {
  // Walk backwards to find the most recent assistant message with Agent tool calls.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;

    const msg = entry.message;
    if (msg.role !== "assistant") continue;
    if (!Array.isArray(msg.content)) continue;

    const agentCalls: AgentCallParams[] = [];
    for (const block of msg.content) {
      if (
        block &&
        typeof block === "object" &&
        block.type === "toolCall" &&
        block.name === "Agent" &&
        typeof block.arguments?.prompt === "string"
      ) {
        agentCalls.push({ ...block.arguments, prompt: block.arguments.prompt });
      }
    }

    if (agentCalls.length > 0) return agentCalls;
  }
  return [];
}

function agentCallDescription(call: AgentCallParams): string {
  if (call.description) return call.description;
  const firstLine = call.prompt.split("\n")[0];
  return firstLine.length > 80 ? firstLine.slice(0, 80) : firstLine || call.prompt.slice(0, 80);
}

/** User-facing label for a skipped call: "type: description (reason)". */
function skippedCallLabel(call: AgentCallParams, reason: string): string {
  return `${call.agent || "general-purpose"}: ${agentCallDescription(call)} (${reason})`;
}

/**
 * Resolve and spawn a single agent from historical parameters.
 *
 * Returns a status string for the caller to collect: "restarted: ..." or "skipped: ...".
 */
async function resolveAndSpawn(
  call: AgentCallParams,
  ctx: ExtensionCommandContext,
  running: Set<string>,
  coordinator: Awaited<ReturnType<typeof getCoordinator>>,
  pi: Awaited<ReturnType<typeof getPiInstance>>,
): Promise<{ restarted: string } | { skipped: string }> {
  const type = call.agent || "general-purpose";
  const description = agentCallDescription(call);
  const key = `${type}::${description}`;

  if (running.has(key)) {
    return { skipped: skippedCallLabel(call, "already running") };
  }

  // Same target validation and trust decision as a live Agent tool call.
  // An omitted path inherits the parent's trust; invalid targets skip, while
  // untrusted targets can spawn with project resources and agent types ignored.
  const target = await computeSpawnTarget(ctx, call.worktree_path);
  surfaceSpawnTargetWarnings(ctx.ui, target);
  if (!target.ok) {
    return { skipped: skippedCallLabel(call, target.error) };
  }

  // Agent profile discovery is independent of extension inheritance.
  const targetAgentsDir =
    target.projectTrusted && target.resolvedPath ? `${target.resolvedPath}/.pi/agents` : undefined;
  const resolution = await resolveTypeOrDiscover(type, targetAgentsDir);
  if (resolution.kind === "not-found" || resolution.kind === "ambiguous") {
    return { skipped: skippedCallLabel(call, "unknown type") };
  }

  const resolvedType = resolution.key;
  const agentConfig = getAgentConfig(resolvedType);
  const maxTurns = call.max_turns ?? agentConfig?.maxTurns ?? getStore().agent.defaultMaxTurns;
  const effectiveModelStr = getStore().modelFor(resolvedType, undefined, agentConfig);
  const model = resolveModel(effectiveModelStr, ctx.modelRegistry, ctx.model);
  const modelKey = model ? `${model.provider}/${model.id}` : undefined;
  // Explicit > frontmatter only: per-model and defaultThinking are owned by
  // the spawn runner, whose chain keeps per-model above defaultThinking.
  const thinkingLevel = parseThinkingLevel(call.thinking) ?? agentConfig?.thinkingLevel;

  await coordinator!.spawn(pi!, ctx, {
    type: resolvedType,
    prompt: call.prompt,
    description,
    model,
    modelKey,
    maxTurns,
    thinkingLevel,
    graceTurns: getStore().agent.graceTurns,
    worktreePath: target.resolvedPath,
    worktreeLabel: target.worktreeLabel,
    projectTrusted: target.projectTrusted,
    invocation: { modelName: model?.id, thinkingLevel, maxTurns },
    runInBackground: true,
  });
  return { restarted: `${resolvedType}: ${description}` };
}

/**
 * Restart agents from the most recent Agent tool calls in session history.
 *
 * Skips agents whose type + description match a currently running agent.
 * Returns what was restarted and what was skipped.
 */
export async function handleRestartLastAgents(ctx: ExtensionCommandContext): Promise<RestartResult> {
  const entries = ctx.sessionManager.getEntries();
  const calls = findLastAgentCallsFromEntries(entries);

  if (calls.length === 0) {
    return { restarted: [], skipped: [] };
  }

  const manager = getManager();
  const coordinator = getCoordinator();
  const pi = getPiInstance();

  if (!manager || !coordinator || !pi) {
    return { restarted: [], skipped: [] };
  }

  const running = new Set(
    manager
      .listAgents()
      .filter((a) => a.lifecycle.status === "running" || a.lifecycle.status === "queued")
      .map((a) => `${a.display.type}::${a.display.description}`),
  );

  // Ensure widget is set up so spawned agents appear in the UI.
  const widget = getWidget();
  if (widget) {
    widget.setUICtx(ctx.ui as unknown as UICtx);
    widget.ensureTimer();
  }

  const restarted: string[] = [];
  const skipped: string[] = [];

  for (const call of calls) {
    try {
      const result = await resolveAndSpawn(call, ctx, running, coordinator, pi);
      if ("restarted" in result) restarted.push(result.restarted);
      else skipped.push(result.skipped);
    } catch (err) {
      skipped.push(skippedCallLabel(call, `spawn failed: ${String(err).slice(0, 80)}`));
    }
  }

  return { restarted, skipped };
}
