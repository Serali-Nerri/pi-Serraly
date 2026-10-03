/**
 * project-trust.ts — Resolve the trust state for a subagent target.
 *
 * Uses Pi's public trust primitives, never reading trust.json directly.
 * Saved target decisions take precedence. An undecided same-repo target
 * inherits the parent's trust; undecided cross-repo targets use only the
 * user-level defaultProjectTrust setting, regardless of current resources.
 *
 * The SDK building blocks are injected as deps so the branching logic stays
 * unit-testable; createSubagentTrustDeps wires the real functions at the
 * call site.
 */

import {
  ProjectTrustStore,
  SettingsManager,
  type DefaultProjectTrust,
  type ProjectTrustDecision,
} from "@earendil-works/pi-coding-agent";

/** The trust primitives the gate is built from. Injected for testability. */
export interface SubagentTrustDeps {
  /** pi's ProjectTrustStore.get: nearest-ancestor decision, null when undecided. */
  getTrustDecision: (cwd: string) => ProjectTrustDecision;
  /** pi's SettingsManager.getDefaultProjectTrust: global default. */
  getDefaultProjectTrust: () => DefaultProjectTrust;
}

/**
 * Wire Pi's public trust primitives. Project settings must not influence the
 * user-level fallback, even when parentCwd belongs to a trusted project.
 */
export function createSubagentTrustDeps(agentDir: string, parentCwd: string): SubagentTrustDeps {
  const trustStore = new ProjectTrustStore(agentDir);
  return {
    getTrustDecision: (cwd) => trustStore.get(cwd),
    getDefaultProjectTrust: () =>
      SettingsManager.create(parentCwd, agentDir, { projectTrusted: false }).getDefaultProjectTrust(),
  };
}

/**
 * Resolve whether a spawn into `targetPath` loads the target's project
 * resources. Saved decisions win over inference, including explicit denials
 * of same-repo targets. Undecided same-repo targets inherit the parent state.
 * An empty cross-repo directory is not an implicit grant for later discovery.
 */
export function resolveSubagentTrust(opts: {
  targetPath: string;
  /** False when the parent and target live in different git repos (or the parent is in none). */
  sameRepo: boolean;
  parentProjectTrusted: boolean;
  deps: SubagentTrustDeps;
}): boolean {
  const decision = opts.deps.getTrustDecision(opts.targetPath);
  if (decision !== null) return decision;
  if (opts.sameRepo) return opts.parentProjectTrusted;
  return opts.deps.getDefaultProjectTrust() === "always";
}

/** Warning surfaced when a spawn proceeds into an untrusted target. */
export function untrustedProjectWarning(targetPath: string): string {
  return `Target project at ${targetPath} is not trusted: its project resources (.pi/ settings, extensions, skills, prompts, themes, system prompt files, .agents/skills) will be ignored for this subagent`;
}
