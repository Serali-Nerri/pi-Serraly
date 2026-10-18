import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
  type AgentSession, type ExtensionAPI, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getAgentConfig, getConfig, registerAgents, resolveSessionToolSelection as select } from "../../src/agents/agent-types.js";

describe("session registry admission", () => {
  const sessions: AgentSession[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const session of sessions.splice(0)) {
      await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function sessionFor(options: Parameters<typeof select>[0], defaultTools?: string[]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "child-admission-"));
    dirs.push(root);
    const agentDir = path.join(root, "agent");
    await fs.mkdir(agentDir);
    const settingsManager = SettingsManager.inMemory({ defaultTools }, { projectTrusted: false });
    let api: ExtensionAPI;
    const factory: ExtensionFactory = (pi) => {
      api = pi;
      for (const name of ["Agent", "StopAgent", "MessageAgent", "AgentStatus"]) {
        pi.registerTool({ name, label: name, description: name, parameters: Type.Object({}),
          execute: async () => ({ content: [{ type: "text", text: name }], details: undefined }),
        });
      }
    };
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir, settingsManager, noExtensions: true,
      noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
      extensionFactories: [factory],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: root, agentDir, settingsManager, resourceLoader: loader,
      sessionManager: SessionManager.inMemory(root), ...select(options),
    });
    sessions.push(session);
    await session.bindExtensions({});
    return { session, api: api! };
  }

  it.each([{ tools: true as const }, { tools: undefined }])("inherit $tools omits the registry gate", ({ tools }) => {
    expect(select({ tools })).not.toHaveProperty("tools");
  });

  it("inherited sessions admit tools registered after startup even with empty defaultTools", async () => {
    const { session, api } = await sessionFor({ tools: undefined }, []);
    api.registerTool({ name: "mcp__late__search", label: "late", description: "late", exposure: "deferred",
      parameters: Type.Object({}), execute: async () => ({ content: [], details: undefined }),
    });
    expect(session.getAllTools().map((tool) => tool.name)).toContain("mcp__late__search");
    expect(session.getActiveToolNames()).not.toContain("mcp__late__search");
  });

  it.each([{ tools: false as const }, { tools: [] }])("$tools prohibits every current and late tool", async ({ tools }) => {
    const { session, api } = await sessionFor({ tools });
    api.registerTool({ name: "mcp__late__search", label: "late", description: "late", exposure: "codemode",
      parameters: Type.Object({}), execute: async () => ({ content: [], details: undefined }),
    });
    expect(session.getAllTools()).toEqual([]);
    if (tools === false) expect(select({ tools })).toMatchObject({ noTools: "all" });
  });

  it("Explore gates its authored registeredTools, never UI/defaultTools fallbacks", async () => {
    registerAgents(new Map());
    const authored = getAgentConfig("Explore")?.registeredTools;
    const { session } = await sessionFor({ tools: undefined, registeredTools: authored }, ["write"]);
    expect(session.getAllTools().map((tool) => tool.name).sort()).toEqual(["bash", "find", "grep", "read"]);
    expect(select({ tools: undefined, registeredTools: [], extToolMap: new Map([["third-party", ["unsafe"]]]) })).toMatchObject({ tools: [] });
    expect(getConfig("general-purpose", true, false, []).registeredTools).toEqual([]);
    expect(select({ tools: undefined })).not.toHaveProperty("tools");
  });

  it("exact allowlist blocks unlisted deferred registrations and preserves late exact MCP names", async () => {
    const { session, api } = await sessionFor({ tools: ["read", "mcp__late__search"] });
    for (const name of ["mcp__late__search", "mcp__late__write"]) {
      api.registerTool({ name, label: name, description: name, exposure: "deferred",
        parameters: Type.Object({}), execute: async () => ({ content: [], details: undefined }),
      });
    }
    expect(session.getAllTools().map((tool) => tool.name).sort()).toEqual(["mcp__late__search", "read"]);
  });

  it("all four control tools are permanently excluded even when whitelisted", async () => {
    const { session } = await sessionFor({ tools: ["read", "Agent", "StopAgent", "MessageAgent", "AgentStatus"] });
    expect(session.getAllTools().map((tool) => tool.name)).toEqual(["read"]);
  });

  it("exact denies block late tools while keeping inherited other registrations", async () => {
    const { session, api } = await sessionFor({ tools: true, excludeTools: ["mcp__late__write"] });
    for (const name of ["mcp__late__search", "mcp__late__write"]) {
      api.registerTool({ name, label: name, description: name, exposure: "codemode",
        parameters: Type.Object({}), execute: async () => ({ content: [], details: undefined }),
      });
    }
    const names = session.getAllTools().map((tool) => tool.name);
    expect(names).toContain("mcp__late__search");
    expect(names).not.toContain("mcp__late__write");
    expect(names).not.toContain("StopAgent");
  });

  it.each(["*", "all"])("static ext/%s expands and an explicit allowlist wins ordinary denies", (alias) => {
    expect(select({ tools: ["read", `tavily/${alias}`], excludeTools: ["read"], extToolMap: new Map([["tavily", ["web_search", "web_extract"]]]) }))
      .toMatchObject({ tools: ["read", "web_search", "web_extract"] });
  });

  it.each(["mcp/*", "mcp/all", "mcp__github__*", "mcp__github/*", "builtin:mcp/*", "builtin:mcp/all"])("dynamic MCP wildcard %s fails closed", (entry) => {
    expect(() => select({ tools: [entry] })).toThrow(/MCP.*wildcard.*exact/i);
    expect(() => select({ tools: true, excludeTools: [entry] })).toThrow(/MCP.*wildcard.*exact/i);
  });
});
