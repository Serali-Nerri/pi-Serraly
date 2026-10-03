import { beforeEach, describe, expect, it } from "vitest";

import { getConfig, registerAgents } from "../../src/agents/agent-types.js";
import type { AgentConfig } from "../../src/agents/types.js";

describe("child extension profiles", () => {
  beforeEach(() => registerAgents(new Map()));

  it("general-purpose selects native capabilities rather than inheriting third parties", () => {
    expect(getConfig("general-purpose").extensions).toEqual([
      "builtin:codemode", "builtin:tool-search", "builtin:mcp",
    ]);
  });

  it("Explore never inherits extensions, even with the global opt-in", () => {
    expect(getConfig("Explore", true, true).extensions).toBe(false);
  });

  it("custom profiles stay extension-free unless explicitly opted in", () => {
    registerAgents(new Map([["custom", { name: "custom", description: "custom", systemPrompt: "" }]]));
    expect(getConfig("custom").extensions).toBe(false);
    expect(getConfig("custom", true, true).extensions).toBe(true);
  });

  it.each<{ extensions: true | string[] | false }>([
    { extensions: false }, { extensions: [] }, { extensions: true }, { extensions: ["pi-tools"] },
  ])("authored general-purpose selection $extensions wins", ({ extensions }) => {
    const config: AgentConfig = {
      name: "general-purpose", description: "custom", systemPrompt: "", extensions,
    };
    registerAgents(new Map([["general-purpose", config]]));
    expect(getConfig("general-purpose").extensions).toEqual(extensions);
  });
});
