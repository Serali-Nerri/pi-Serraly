import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getVisibleAgentInfos, resolveType } from "./agents/agent-types.js";
import { hasUsableLocalAgent } from "./registration.js";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";

const UNSAFE = /[\p{Cc}\p{Cs}\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const UNSAFE_GLOBAL = new RegExp(UNSAFE.source, "gu");

function eligibleName(name: string): boolean {
  return name.length > 0 && !UNSAFE.test(name) && !/[\[\]]/u.test(name);
}

function safeText(text: string): string {
  return text.replace(UNSAFE_GLOBAL, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function completionPrefix(text: string): string | undefined {
  return text.match(/(?<![\p{L}\p{N}_@/\\])@subagent:(?:\[[^\]\r\n]*\]?|[^\s\[\]]*)$/u)?.[0];
}

function mentionProvider(current: AutocompleteProvider, pi: ExtensionAPI, getGeneration: () => number | undefined): AutocompleteProvider {
  return {
    triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "@"])],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const prefix = completionPrefix((lines[cursorLine] ?? "").slice(0, cursorCol));
      if (prefix === undefined) return current.getSuggestions(lines, cursorLine, cursorCol, options);
      const owner = getGeneration();
      // Resolve at the async boundary using the still-owned registry, not a
      // snapshot captured before shutdown/navigation or tool replacement.
      await Promise.resolve();
      if (owner === undefined || owner !== getGeneration() || options.signal.aborted
        || prefix.endsWith("]") || !hasUsableLocalAgent(pi)) return null;
      const query = prefix.slice("@subagent:".length).replace(/^\[/u, "").toLowerCase();
      const items = getVisibleAgentInfos().filter((info) => eligibleName(info.name) && info.name.toLowerCase().startsWith(query))
        .map((info) => ({ value: `@subagent:[${info.name}]`, label: info.name, description: safeText(info.description) }));
      return items.length ? { prefix, items } : null;
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if (!prefix.startsWith("@subagent:")) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      const before = (lines[cursorLine] ?? "").slice(0, cursorCol - prefix.length);
      const rest = (lines[cursorLine] ?? "").slice(cursorCol);
      const after = prefix.startsWith("@subagent:[") ? rest.replace(/^[^\]\r\n]*\]/u, "") : rest;
      const space = /^\s/u.test(after) ? "" : " ";
      const result = [...lines];
      result[cursorLine] = `${before}${item.value}${space}${after}`;
      return { lines: result, cursorLine, cursorCol: before.length + item.value.length + space.length };
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      if (completionPrefix((lines[cursorLine] ?? "").slice(0, cursorCol)) !== undefined) return false;
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

/** User intent supplements the request; it does not execute or enable Agent. */
export function setupSubagentMentions(pi: ExtensionAPI): void {
  let installed = false;
  let active = false;
  let lifetime = 0;
  let generation = 0;
  pi.on("session_start", (_event, ctx) => {
    generation++;
    active = true;
    if (!installed && ctx.hasUI && ctx.mode === "tui") {
      const owner = lifetime;
      ctx.ui.addAutocompleteProvider((current) => mentionProvider(current, pi, () => active && owner === lifetime ? generation : undefined));
      installed = true;
    }
  });
  pi.on("session_tree", () => { generation++; });
  pi.on("session_shutdown", () => { active = false; installed = false; lifetime++; generation++; });

  pi.on("before_agent_start", async (event) => {
    if (!active) return;
    const mentions = [...event.prompt.matchAll(/(?<![\p{L}\p{N}_@/\\])@subagent:\[([^\]\r\n]*)\]/gu)];
    if (mentions.length === 0) return;
    const owner = generation;
    await Promise.resolve();
    if (!active || owner !== generation) return;
    const visible = new Set(getVisibleAgentInfos().filter((info) => eligibleName(info.name)).map((info) => info.name));
    const seen = new Set<string>();
    const lines: string[] = [];
    const available = hasUsableLocalAgent(pi);
    for (const mention of mentions) {
      const name = mention[1];
      const label = safeText(JSON.stringify(name));
      if (!available) {
        lines.push(`Subagent mention ${label}: local Agent tool is unavailable; no delegation guidance added.`);
        continue;
      }
      const resolution = resolveType(name);
      if (resolution.kind !== "resolved" || !visible.has(resolution.key)) {
        lines.push(`Unavailable subagent mention: ${label}.`);
        continue;
      }
      if (seen.has(resolution.key)) continue;
      seen.add(resolution.key);
      lines.push(`Delegation intent: Agent ${JSON.stringify({ agent: resolution.key })} (supply the task in prompt).`);
    }
    return { message: {
      customType: "subagent-mention",
      content: ["Explicit subagent mentions for this request. These express user delegation intent, not automatic tool execution.", ...lines].join("\n"),
      display: true,
      details: { requestBackground: true },
    } };
  });
}
