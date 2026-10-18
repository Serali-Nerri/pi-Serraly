/**
 * pi-settings.ts — Read pi's settings.json, decoupling consumers from pi's
 * file format and path.
 */

import * as fs from "node:fs";
import { SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "./types.js";
import * as path from "node:path";

export interface PiSettings {
  hideThinkingBlock?: boolean;
}

/** Parse pi's settings.json; undefined if missing or unparseable. */
export function readPiSettings(agentDir?: string): PiSettings | undefined {
  try {
    const content = fs.readFileSync(path.join(agentDir ?? getAgentDir(), "settings.json"), "utf-8");
    return JSON.parse(content) as PiSettings;
  } catch {
    return undefined;
  }
}

/** True if hideThinkingBlock is set; false if absent or unreadable. */
export function getHideThinkingBlock(): boolean {
  const settings = readPiSettings();
  return settings?.hideThinkingBlock ?? false;
}

/**
 * Which pi settings layer a read may use: the agent dir to read and the trust
 * decision of the target. False for an untrusted project: its own layer is
 * ignored while the global one still applies — the same scope the untrusted
 * target's child session is created with. Omitted means trusted.
 */
export interface PiSettingsScope {
  agentDir?: string;
  projectTrusted?: boolean;
}

/** A SettingsManager at the scope's agent dir and trust decision, the same shape the spawn runtime creates. */
function settingsFor(cwd: string, scope: PiSettingsScope): SettingsManager {
  return SettingsManager.create(cwd, scope.agentDir ?? getAgentDir(), { projectTrusted: scope.projectTrusted });
}

/**
 * pi's `defaultThinkingLevel` setting for `cwd` (project over global) — the
 * level a subagent session falls back to when frontmatter thinking and
 * `defaultThinking` are both unset. Reads pi's settings the same way the
 * spawn runtime does (SettingsManager over the agent dir + project dir).
 */
export function getPiDefaultThinkingLevel(cwd: string, scope: PiSettingsScope = {}): ThinkingLevel | undefined {
  return settingsFor(cwd, scope).getDefaultThinkingLevel();
}

/**
 * pi's per-model thinking level for one model (project layer over global),
 * keyed the way pi keys `modelThinkingLevels`: `provider/modelId`. Undefined
 * when the model has no entry. The scope carries the spawn target's trust
 * decision, so an untrusted project cannot set the level through this read.
 */
export function getPiModelThinkingLevel(
  cwd: string,
  provider: string,
  modelId: string,
  scope: PiSettingsScope = {},
): ThinkingLevel | undefined {
  return settingsFor(cwd, scope).getModelThinkingLevel(provider, modelId);
}

/**
 * pi's whole per-model thinking map (project over global), keyed
 * `provider/modelId`. For surfaces that look up many models (menus): one
 * settings read instead of one per row. Returns a copy.
 */
export function getPiModelThinkingLevels(cwd: string, scope: PiSettingsScope = {}): Record<string, ThinkingLevel> {
  return settingsFor(cwd, scope).getAllModelThinkingLevels();
}

/**
 * Pi's resolved defaultTools selection. The public accessor owns modifiers
 * and layer precedence; preserve [] versus unconfigured and return a copy.
 */
export function readDefaultTools(settingsManager: SettingsManager): string[] | undefined {
  const tools = settingsManager.getDefaultTools();
  return Array.isArray(tools) ? [...tools] : undefined;
}
