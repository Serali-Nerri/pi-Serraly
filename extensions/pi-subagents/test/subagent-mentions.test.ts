import { afterEach, describe, expect, it } from "vitest";
import { mentionHarness } from "./mention-harness.js";

let harness: Awaited<ReturnType<typeof mentionHarness>> | undefined;
afterEach(async () => { await harness?.close(); harness = undefined; });

describe("explicit subagent mentions through the host request lifecycle", () => {
  it.each(["print", "json", "rpc"] as const)("adds canonical request guidance in %s without changing tools or creating children", async (mode) => {
    harness = await mentionHarness({ mode });
    await harness.profile("user", "review", "Review", "description: Review code");
    await harness.bind();
    const active = harness.session.getActiveToolNames();
    const prompt = "Use @subagent:[review], then @subagent:[Explore] and @subagent:[Review].";
    const result = await harness.request(prompt);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      customType: "subagent-mention", display: true, details: { requestBackground: true },
    });
    expect(result.messages[0].content).toContain('Agent {"agent":"Review"}');
    expect(result.messages[0].content).toContain('Agent {"agent":"Explore"}');
    expect(String(result.messages[0].content).match(/"agent":"Review"/g)).toHaveLength(1);
    expect(String(result.messages[0].content).indexOf('"Review"')).toBeLessThan(String(result.messages[0].content).indexOf('"Explore"'));
    expect(result.systemPromptOptions.customPrompt).toBe("Original system prompt");
    expect(result.systemPromptOptions.forceSystemPrompt).toBeUndefined();
    expect(harness.session.getActiveToolNames()).toEqual(active);
    const status = await harness.session.getToolDefinition("AgentStatus")!.execute(
      "status", {}, undefined, undefined, harness.session.extensionRunner!.createToolContext("status", undefined),
    );
    expect(status.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("No agents running or completed.") });
    expect((await harness.request("No new mention here")).messages).toEqual([]);
    expect(harness.errors).toEqual([]);
  });

  it("diagnoses inactive or replaced Agent without enabling it or inventing valid guidance", async () => {
    harness = await mentionHarness();
    await harness.bind();
    const active = harness.session.getActiveToolNames();
    harness.session.setActiveToolsByName(active.filter((name) => name !== "Agent"));
    const inactive = await harness.request("@subagent:[Explore]");
    expect(inactive.messages[0].content).toContain("local Agent tool is unavailable");
    expect(inactive.messages[0].content).not.toContain('Agent {"agent":');
    expect(harness.session.getActiveToolNames()).not.toContain("Agent");

    harness.session.setActiveToolsByName(active);
    const local = harness.session.getToolDefinition("Agent")!;
    harness.pi.registerTool({ ...local, parameters: structuredClone(local.parameters), execute: async () => ({ content: [], details: {} }) });
    const replaced = await harness.request("@subagent:[Explore]");
    expect(replaced.messages[0].content).toContain("local Agent tool is unavailable");
    expect(replaced.messages[0].content).not.toContain('Agent {"agent":');
    expect(harness.session.getActiveToolNames()).toEqual(active);
    expect(harness.errors).toEqual([]);
  });

  it("reports an excluded Agent without registering or activating it", async () => {
    harness = await mentionHarness({ excludeTools: ["Agent"] });
    await harness.bind();
    const result = await harness.request("@subagent:[Explore]");
    expect(result.messages[0].content).toContain("local Agent tool is unavailable");
    expect(result.messages[0].content).not.toContain('Agent {"agent":');
    expect(harness.session.getAllTools().map((tool) => tool.name)).not.toContain("Agent");
    expect(harness.errors).toEqual([]);
  });

  it("rejects another extension's Agent even when it reuses the public local schema", async () => {
    harness = await mentionHarness();
    await harness.bind();
    const local = harness.session.getToolDefinition("Agent")!;
    const active = harness.session.getActiveToolNames();
    harness.replacementPi.registerTool({
      ...local, parameters: local.parameters, execute: async () => ({ content: [], details: {} }),
    });
    const result = await harness.request("@subagent:[Explore]");
    expect(result.messages[0].content).toContain("local Agent tool is unavailable");
    expect(result.messages[0].content).not.toContain('Agent {"agent":');
    expect(harness.session.getActiveToolNames()).toEqual(active);
    expect(harness.errors).toEqual([]);
  });

  it("diagnoses missing, unknown, hidden, ambiguous and unsafe selections while retaining healthy delegation intent", async () => {
    harness = await mentionHarness({ trusted: false });
    await harness.profile("user", "visible", "Visible");
    await harness.profile("user", "hidden", "Hidden", "hidden: true");
    await harness.profile("user", "case-a", "Reviewer");
    await harness.profile("user", "case-b", "reviewer");
    await harness.profile("user", "unsafe", "bad\u202e");
    await harness.profile("shared", "visible", "Visible", "hidden: true");
    await harness.profile("project", "project", "ProjectOnly");
    await harness.bind();
    const result = await harness.request("@subagent:[missing] @subagent:[Hidden] @subagent:[REVIEWER] @subagent:[bad\u202e] @subagent:[ProjectOnly] @subagent:[Visible]");
    expect(String(result.messages[0].content).match(/Agent \{"agent":/g)).toHaveLength(1);
    expect(result.messages[0].content).toContain('Agent {"agent":"Visible"}');
    expect(result.messages[0].content).toContain("missing");
    expect(result.messages[0].content).toContain("Hidden");
    expect(result.messages[0].content).toContain("REVIEWER");
    expect(result.messages[0].content).toContain("ProjectOnly");
    expect(result.messages[0].content).not.toContain("\u202e");
    expect((await harness.request("Bare @subagent:Explore, embedded email@subagent:[Explore], and @Agent are not mentions")).messages).toEqual([]);
    expect(harness.errors).toEqual([]);
  });
});
