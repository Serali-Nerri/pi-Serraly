import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionAPI, type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream, InMemoryCredentialStore,
  type AssistantMessage, type ToolCall,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createNativeExtensionEntry } from "../../src/agents/extension-selection.js";
import { resolveSessionToolSelection } from "../../src/agents/agent-types.js";

import { createExtensionDenyGuard as createGuard } from "../../src/agents/tool-policy.js";

describe("legacy extension wildcard deny at execution", () => {
  const sessions: AgentSession[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const session of sessions.splice(0)) {
      await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function open(excludedEntries: string[] = ["vendor/*"]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "child-deny-"));
    dirs.push(root);
    const agentDir = path.join(root, "agent");
    await fs.mkdir(agentDir);
    await fs.writeFile(path.join(root, "seed.txt"), "safe builtin read");
    let vendor!: ExtensionAPI;
    let other!: ExtensionAPI;
    let nativeMcp!: ExtensionAPI;
    let sideEffects = 0;
    let nextCall: { name: string; arguments: ToolCall["arguments"] } | undefined;
    let callId = 0;
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null,
      modelsStorePath: path.join(root, "models-cache.json"),
      allowModelNetwork: false, refreshOnCreate: false,
    });
    modelRuntime.registerProvider("policy-scripted", {
      api: "policy-scripted", apiKey: "fixture", baseUrl: "https://example.invalid",
      models: [{ id: "fixture", name: "Local scripted provider", reasoning: false, input: ["text"],
        contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple(model, _context, options) {
        const stream = createAssistantMessageEventStream();
        const call = nextCall;
        nextCall = undefined;
        const content: (ToolCall | { type: "text"; text: string })[] = call
          ? [{ type: "toolCall", id: `call-${++callId}`, ...call }] : [{ type: "text", text: "done" }];
        const message: AssistantMessage = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id,
          timestamp: Date.now(), content, stopReason: call ? "toolUse" : "stop",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        queueMicrotask(async () => {
          try {
            await options?.onPayload?.({ scripted: true }, model);
            await options?.onResponse?.({ status: 200, headers: {} }, model);
            stream.push({ type: "start", partial: message });
            stream.push({ type: "done", reason: call ? "toolUse" : "stop", message });
          } catch (error) {
            message.stopReason = "error";
            message.errorMessage = String(error);
            stream.push({ type: "error", reason: "error", error: message });
          } finally {
            stream.end();
          }
        });
        return stream;
      },
    });
    const aliasesByPath = new Map<string, readonly string[]>([
      ["<inline:vendor>", ["vendor", "package"]],
      ["<inline:other>", ["other", "package"]],
      ["builtin:codemode", ["codemode"]],
      ["builtin:mcp", ["mcp"]],
    ]);
    const guard = createGuard({ excludedEntries, aliasesByPath });
    const extensions: InlineExtension[] = [
      { name: "vendor", factory: (pi) => { vendor = pi; } },
      { name: "other", factory: (pi) => {
        other = pi;
        pi.registerTool({ name: "nested", label: "nested", description: "Nested call", parameters: Type.Object({}),
          execute: async (_id, _args, _signal, _update, ctx) => {
            const outcome = await ctx.executeTool("late_write", {});
            return { ...outcome.result, isError: outcome.isError };
          },
        });
      } },
      // A synthetic native-source registration uses the real SDK metadata path,
      // without connecting any network/MCP transport.
      { name: "mcp", builtin: true, factory: (pi) => { nativeMcp = pi; } },
      createNativeExtensionEntry("codemode"),
      ...(guard ? [guard] : []),
    ];
    const settingsManager = SettingsManager.inMemory({ defaultTools: ["+codemode"] }, { projectTrusted: false });
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir, settingsManager, noExtensions: true,
      additionalExtensionPaths: ["builtin:codemode", "builtin:mcp"], extensionFactories: extensions,
      noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const { session } = await createAgentSession({
      cwd: root, agentDir, modelRuntime, model: modelRuntime.getModel("policy-scripted", "fixture"),
      resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(root),
      ...resolveSessionToolSelection({ tools: true, excludeTools: excludedEntries }),
    });
    sessions.push(session);
    await session.bindExtensions({});
    vendor.registerTool({ name: "late_write", label: "late", description: "Late vendor write", parameters: Type.Object({}),
      execute: async () => { sideEffects++; return { content: [{ type: "text", text: "write happened" }], details: undefined }; },
    });
    const registerSafe = (pi: ExtensionAPI, name: string) => pi.registerTool({
      name, label: name, description: name, parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: `${name} allowed` }], details: undefined }),
    });
    registerSafe(other, "safe_other");
    registerSafe(nativeMcp, "mcp__safe__read");
    return {
      session, effects: () => sideEffects,
      async call(name: string, args: ToolCall["arguments"] = {}) {
        nextCall = { name, arguments: args };
        const start = session.messages.length;
        await session.prompt("Run the next local scripted tool call.");
        return session.messages.slice(start).filter((message) => message.role === "toolResult")
          .flatMap((message) => message.content).filter((content) => content.type === "text").map((content) => content.text).join("\n");
      },
    };
  }

  it.each([
    ["*", "direct"], ["*", "nested"], ["*", "codemode"],
    ["all", "direct"], ["all", "nested"], ["all", "codemode"],
  ])("late excluded vendor/%s tool is blocked on the %s route before its side effect", async (alias, route) => {
    const h = await open([`vendor/${alias}`]);
    expect(h.session.getAllTools().map((tool) => tool.name)).toContain("late_write");
    const output = await h.call(route === "direct" ? "late_write" : route, route === "codemode" ? { code: "return await tools.late_write({});" } : {});
    expect(h.effects()).toBe(0);
    expect(output).toMatch(/blocked|denied|excluded/i);
  });

  it("does not block legitimate base builtin, selected sibling, or selected native MCP-source tools", async () => {
    const h = await open();
    expect(await h.call("read", { path: "seed.txt" })).toContain("safe builtin read");
    expect(await h.call("safe_other")).toContain("safe_other allowed");
    expect(await h.call("mcp__safe__read")).toContain("mcp__safe__read allowed");
  });

  it("native codemode state survives continuation but is not shared with another child", async () => {
    const first = await open();
    expect(await first.call("codemode", { code: 'store("marker", "first-child"); return "stored";' })).toContain("stored");
    expect(await first.call("codemode", { code: 'return load("marker");' })).toContain("first-child");
    const second = await open();
    expect(await second.call("codemode", { code: 'return load("marker") ?? "fresh-child";' })).toContain("fresh-child");
  });

  it("aggregate package alias denies every selected leaf's later tool", async () => {
    const h = await open(["package/*"]);
    expect(await h.call("safe_other")).toMatch(/blocked|denied|excluded/i);
  });

  it("missing current source identity fails closed", async () => {
    const h = await open();
    const info = h.session.getAllTools().find((tool) => tool.name === "safe_other")!;
    info.sourceInfo.path = "";
    expect(await h.call("safe_other")).toMatch(/blocked|denied|source/i);
  });
});
