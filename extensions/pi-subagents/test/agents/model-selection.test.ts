import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, type ExtensionUIContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { fakeCtx } from "../fixtures.js";
import { defaultModel, defaultModelRegistry } from "../mock-utils.js";
import { asCommandContext, asExtensionAPI } from "../pi-boundaries.js";
import subagents from "../../src/index.js";

// The SDK session factory is the external boundary. Never start a model call.
const { createAgentSession } = vi.hoisted(() => ({ createAgentSession: vi.fn() }));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...await importOriginal<typeof import("@earendil-works/pi-coding-agent")>(),
  createAgentSession,
}));

let cwd: string;
let ctx: ExtensionToolContext;
let tools: Map<string, ToolDefinition>;
let commands: Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>;
let listeners: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;

beforeEach(async () => {
  cwd = mkdtempSync(join(tmpdir(), "subagents-model-selection-"));
  mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
  tools = new Map();
  commands = new Map();
  listeners = new Map();
  ctx = {
    ...fakeCtx({
      cwd,
      hasUI: false,
      mode: "print",
      modelRegistry: defaultModelRegistry({
        find: (provider: string, id: string) =>
          provider === "test" && id === "model" ? defaultModel() : undefined,
      }),
    }),
    tools: [],
    executeTool: vi.fn(async () => { throw new Error("No nested tool calls expected"); }),
  };
  createAgentSession.mockReset();
  createAgentSession.mockImplementation(async ({ model }) => {
    throw new Error(`SDK boundary selected ${model?.provider}/${model?.id}`);
  });
  subagents(asExtensionAPI({
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
      commands.set(name, command);
    },
    registerMessageRenderer: () => {},
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      listeners.set(event, handler);
    },
    exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
  }));
});

afterEach(async () => {
  await listeners.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
  rmSync(cwd, { recursive: true, force: true });
});

it.each([
  { source: "config default", value: "missing/unavailable", errorKind: "unavailable" },
  { source: "config per-type", value: "missing/unavailable", errorKind: "unavailable" },
  { source: "frontmatter", value: "missing/unavailable", errorKind: "unavailable" },
  { source: "default frontmatter", value: "missing/unavailable", errorKind: "unavailable" },
  { source: "Agent override", value: "missing/unavailable", errorKind: "unavailable" },
  { source: "config default", value: "not-a-model-key", errorKind: "invalid" },
  { source: "config default", value: "", errorKind: "invalid" },
  { source: "frontmatter", value: "test/", errorKind: "invalid" },
  { source: "frontmatter", value: "", errorKind: "invalid" },
  { source: "Agent override", value: "/model", errorKind: "invalid" },
  { source: "Agent override", value: "", errorKind: "invalid" },
])("rejects $source model $value before labelling or starting the Agent", async ({ source, value, errorKind }) => {
  const input: Record<string, unknown> = { prompt: "do nothing" };
  if (source.startsWith("config")) {
    const key = source === "config default" ? "default" : "general-purpose";
    writeFileSync(join(cwd, ".pi", "subagents-lite.json"), JSON.stringify({
      agent: { [key]: value },
    }));
  } else if (source.endsWith("frontmatter")) {
    const name = source === "default frontmatter" ? "general-purpose" : "configured-child";
    writeFileSync(join(cwd, ".pi", "agents", `${name}.md`),
      `---\nname: ${name}\nmodel: ${JSON.stringify(value)}\n---\nDo nothing.`);
    if (source === "frontmatter") input.agent = name;
  } else {
    input.model = value;
  }
  await listeners.get("session_start")!({ type: "session_start" }, ctx);
  const error = errorKind === "unavailable"
    ? `Subagent model unavailable: "${value}". Choose a registered provider/model-id.`
    : `Invalid subagent model: "${value}". Expected provider/model-id.`;

  await expect(listeners.get("tool_call")!({
    type: "tool_call", toolName: "Agent", toolCallId: "test-call", input,
  }, ctx)).rejects.toThrow(error);
  expect(input).not.toHaveProperty("_modelOverride");
  for (const runInBackground of [false, true]) {
    await expect(tools.get("Agent")!.execute("test-call", {
      ...input, run_in_background: runInBackground,
    }, undefined, undefined, ctx)).rejects.toThrow(error);
  }
  expect(createAgentSession).not.toHaveBeenCalled();
});

it("passes an explicit registered override to the child and labels that model", async () => {
  const childModel = { ...defaultModel(), id: "child" };
  ctx.modelRegistry = defaultModelRegistry({
    find: (provider: string, id: string) =>
      provider === "test" && id === "child" ? childModel : undefined,
  });
  writeFileSync(join(cwd, ".pi", "subagents-lite.json"), JSON.stringify({
    agent: { default: "missing/unavailable" },
  }));
  await listeners.get("session_start")!({ type: "session_start" }, ctx);
  const input: Record<string, unknown> = { prompt: "do nothing", model: "test/child" };
  await listeners.get("tool_call")!({
    type: "tool_call", toolName: "Agent", toolCallId: "test-call", input,
  }, ctx);

  expect(input._modelOverride).toBe("child");
  await expect(tools.get("Agent")!.execute("test-call", input, undefined, undefined, ctx))
    .rejects.toThrow("SDK boundary selected test/child");
  expect(createAgentSession.mock.calls[0][0].model).toBe(childModel);
});

it.each([null, "missing/unavailable"])(
  "uses the canonical per-type model for a lowercase Agent call over default %s",
  async (defaultOverride) => {
    const childModel = { ...defaultModel()!, id: "child" };
    ctx.model = { ...defaultModel()!, id: "parent" };
    ctx.modelRegistry = defaultModelRegistry({
      find: (provider: string, id: string) =>
        provider === "test" && id === "child" ? childModel : undefined,
    });
    writeFileSync(join(cwd, ".pi", "subagents-lite.json"), JSON.stringify({
      agent: { default: defaultOverride, Explore: "test/child" },
    }));
    await listeners.get("session_start")!({ type: "session_start" }, ctx);
    const input: Record<string, unknown> = { prompt: "inspect only", agent: "explore" };
    await listeners.get("tool_call")!({
      type: "tool_call", toolName: "Agent", toolCallId: "test-call", input,
    }, ctx);

    expect(input._modelOverride).toBe("child");
    await expect(tools.get("Agent")!.execute("test-call", input, undefined, undefined, ctx))
      .rejects.toThrow("SDK boundary selected test/child");
    expect(createAgentSession.mock.calls[0][0].model).toBe(childModel);
  },
);

it("discovers a late profile before choosing the listener title and child model", async () => {
  const childModel = { ...defaultModel()!, id: "late-child" };
  ctx.model = { ...defaultModel()!, id: "parent" };
  ctx.modelRegistry = defaultModelRegistry({
    find: (provider: string, id: string) =>
      provider === "test" && id === "late-child" ? childModel : undefined,
  });
  await listeners.get("session_start")!({ type: "session_start" }, ctx);
  writeFileSync(join(cwd, ".pi", "agents", "LateScout.md"),
    "---\nname: LateScout\nmodel: test/late-child\n---\nInspect only.");
  const input: Record<string, unknown> = { prompt: "inspect only", agent: "latescout" };
  await listeners.get("tool_call")!({
    type: "tool_call", toolName: "Agent", toolCallId: "test-call", input,
  }, ctx);

  expect(input._modelOverride).toBe("late-child");
  await expect(tools.get("Agent")!.execute("test-call", input, undefined, undefined, ctx))
    .rejects.toThrow("SDK boundary selected test/late-child");
  expect(createAgentSession.mock.calls[0][0].model).toBe(childModel);
});

// Drive the host UI boundary; the registered command creates all real menus.
async function spawnFromAgentsMenu() {
  initTheme("dark", false);
  const steps = [
    { title: "Agents", keys: ["\x1b[B", "\r"] },
    { title: "Select Agent Type", keys: [..."general-purpose", "\r"] },
    { title: "Agent Prompt", keys: [..."Do nothing.", "\r"] },
    { title: "Spawn Options", keys: ["\r", "\x1b"] },
    { title: "Agents", keys: ["\x1b"] },
  ];
  let stepIndex = 0;
  const notify = vi.fn();
  // The menus do not use tui/keybindings. Adapt only the host's UI factory.
  type MenuFactory = (
    tui: undefined,
    theme: { fg: (color: string, text: string) => string; bold: (text: string) => string },
    keybindings: undefined,
    done: (value: unknown) => void,
  ) => Component | Promise<Component>;
  const custom = async (factory: MenuFactory) => {
    const step = steps[stepIndex++];
    expect(step).toBeDefined();
    let closed = false;
    let result: unknown;
    const component = await factory(undefined, {
      fg: (_color, text) => text,
      bold: (text) => text,
    }, undefined, (value) => {
      closed = true;
      result = value;
    });
    expect(component.render(100).join("\n")).toContain(step.title);
    for (const key of step.keys) {
      if (closed) break;
      component.handleInput?.(key);
      component.render(100);
    }
    expect(closed).toBe(true);
    return result;
  };
  ctx.ui = { ...ctx.ui, custom: custom as unknown as ExtensionUIContext["custom"], notify };
  await commands.get("agents")!.handler("", asCommandContext(ctx));
  expect(stepIndex).toBe(steps.length);
  // Background spawn continues after the options menu closes.
  await vi.waitFor(() => {
    expect(notify.mock.calls.length + createAgentSession.mock.calls.length).toBeGreaterThan(0);
  });
  return notify;
}

it("rejects an explicit empty model from the registered /agents menu before child allocation", async () => {
  writeFileSync(join(cwd, ".pi", "subagents-lite.json"), JSON.stringify({ agent: { default: "" } }));
  await listeners.get("session_start")!({ type: "session_start" }, ctx);

  const notify = await spawnFromAgentsMenu();

  expect(notify).toHaveBeenCalledWith('Invalid subagent model: "". Expected provider/model-id.', "error");
  expect(createAgentSession).not.toHaveBeenCalled();
});

it.each([undefined, null, "test/child"])(
  "spawns from the registered /agents menu with model override %s",
  async (override) => {
    const childModel = { ...defaultModel()!, id: "child" };
    ctx.model = { ...defaultModel()!, id: "parent" };
    ctx.modelRegistry = defaultModelRegistry({
      find: (provider: string, id: string) =>
        provider === "test" && id === "child" ? childModel : undefined,
      getAvailable: () => [childModel],
    });
    writeFileSync(join(cwd, ".pi", "subagents-lite.json"), JSON.stringify({ agent: { default: override } }));
    await listeners.get("session_start")!({ type: "session_start" }, ctx);

    await spawnFromAgentsMenu();

    expect(createAgentSession).toHaveBeenCalledOnce();
    expect(createAgentSession.mock.calls[0][0].model).toBe(override == null ? ctx.model : childModel);
  },
);

it("inherits the parent model object when no model was selected", async () => {
  // A parent model need not be rediscovered from a registry snapshot.
  ctx = { ...ctx, ...fakeCtx({ cwd, hasUI: false, mode: "print" }) };
  await listeners.get("session_start")!({ type: "session_start" }, ctx);
  const input = { prompt: "do nothing" };
  await listeners.get("tool_call")!({
    type: "tool_call", toolName: "Agent", toolCallId: "test-call", input,
  }, ctx);

  await expect(tools.get("Agent")!.execute("test-call", input, undefined, undefined, ctx))
    .rejects.toThrow("SDK boundary selected test/model");
  expect(createAgentSession.mock.calls[0][0].model).toBe(ctx.model);
});
