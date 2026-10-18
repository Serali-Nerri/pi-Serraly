import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { assertSupportedToolRestriction, BUILTIN_TOOL_NAMES } from "./agent-types.js";

/**
 * Complements exact SDK excludes only for the existing third-party ext/* deny
 * and ext/all syntax. A late tool may remain discoverable, but cannot execute through any
 * route. This is not an extension sandbox or a dynamic MCP authorization DSL.
 */
export function createExtensionDenyGuard(options: {
  excludedEntries: readonly string[];
  aliasesByPath: ReadonlyMap<string, readonly string[]>;
}): InlineExtension | undefined {
  const excludedAliases = new Set<string>();
  for (const entry of options.excludedEntries) {
    assertSupportedToolRestriction(entry);
    if (entry.endsWith("/*") || entry.endsWith("/all")) {
      excludedAliases.add(entry.slice(0, entry.lastIndexOf("/")).toLowerCase());
    }
  }
  if (excludedAliases.size === 0) return undefined;

  const baseBuiltinPaths = new Set([...BUILTIN_TOOL_NAMES, "powershell"].map((name) => `builtin:${name}`));
  return {
    name: "subagent-extension-deny",
    hidden: true,
    factory(pi) {
      pi.on("tool_call", (event) => {
        // Never retain a startup registry snapshot: third parties can register
        // or replace tools after bind, on reconnect, or during continuation.
        const source = pi.getAllTools().find((tool) => tool.name === event.toolName)?.sourceInfo?.path;
        if (source && baseBuiltinPaths.has(source)) return;
        const aliases = source ? options.aliasesByPath.get(source) : undefined;
        if (!aliases) {
          return { block: true, reason: `Tool "${event.toolName}" denied: missing selected extension source identity` };
        }
        if (aliases.some((alias) => excludedAliases.has(alias.toLowerCase()))) {
          return { block: true, reason: `Tool "${event.toolName}" denied by excluded extension` };
        }
      });
    },
  };
}
