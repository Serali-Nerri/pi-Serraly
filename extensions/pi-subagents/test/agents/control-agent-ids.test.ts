import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asExtensionAPI, asExtensionContext } from "../pi-boundaries.js";
import { AgentManager } from "../../src/agents/agent-manager.js";
import { executeAgentStatusTool } from "../../src/agents/agent-status.js";
import { executeMessageAgentTool, executeStopAgentTool } from "../../src/agents/tool-execution.js";
import { setManager } from "../../src/shell.js";

const { randomUUID } = vi.hoisted(() => ({ randomUUID: vi.fn() }));
vi.mock("node:crypto", async (original) => ({
  ...await original<typeof import("node:crypto")>(),
  randomUUID,
}));

describe("control tools resolve displayed agent IDs", () => {
  let manager: AgentManager;
  const ctx = asExtensionContext({});

  beforeEach(() => {
    randomUUID.mockReset();
    manager = new AgentManager();
    setManager(manager);
  });
  afterEach(async () => {
    await manager.dispose();
    setManager(null);
  });

  // An interrupted spawn retains a public status record without creating a
  // session, touching credentials or issuing a model request.
  function retain(id: string) {
    randomUUID.mockReturnValueOnce(id);
    return manager.spawn(asExtensionAPI({}), ctx, "Explore", "interrupted task", {
      description: "interrupted task", signal: AbortSignal.abort(),
    });
  }
  const stop = (id: unknown) => executeStopAgentTool("stop", { agent_id: id }, undefined, undefined, ctx);
  const message = (id: unknown, text: unknown) =>
    executeMessageAgentTool("message", { agent_id: id, message: text }, undefined, undefined, ctx);

  it("accepts the short ID copied from AgentStatus, including surrounding whitespace", async () => {
    const full = retain("abc123de-1111-4000-8000-000000000001");
    const status = await executeAgentStatusTool("status", {}, undefined, undefined, ctx);
    const displayedId = status.content[0].text.split(" ")[0];
    expect(displayedId).toBe("abc123de");
    expect((await stop(` ${displayedId} `)).content[0].text).toContain("already stopped");
    // Internal identity stays exact; the tools alone accept prefixes.
    expect(manager.getRecord(full)?.id).toBe(full);
    expect(manager.getRecord(displayedId)).toBeUndefined();
  });

  it("rejects ambiguous prefixes with full candidates instead of selecting a record", async () => {
    const first = retain("abc123de-1111-4000-8000-000000000001");
    const second = retain("abc123de-2222-4000-8000-000000000002");
    await expect(stop("abc123de")).rejects.toThrow(
      new RegExp(`^Ambiguous agent id abc123de\\. Matching agents: (?=.*${first})(?=.*${second}).*Use a longer id\\.$`),
    );
    expect(manager.listAgents().map((record) => record.lifecycle.status)).toEqual(["stopped", "stopped"]);
    expect((await stop("abc123de-2222")).content[0].text).toContain("already stopped");
  });

  it("prefers an exact retained ID over longer prefix matches", async () => {
    retain("abc123de");
    retain("abc123de-2222-4000-8000-000000000002");
    expect((await stop("abc123de")).content[0].text).toContain("already stopped");
  });

  it.each(["", " \n ", undefined, 3])("rejects a missing or invalid ID without acting", async (id) => {
    retain("abc123de-1111-4000-8000-000000000001");
    await expect(stop(id)).rejects.toThrow("agent_id is required");
  });

  it("does not claim delivery to a stopped record that never acquired a session", async () => {
    retain("abc123de-1111-4000-8000-000000000001");
    const result = await message("abc123de", "continue please");
    expect(result.content[0].text).toMatch(/Message not sent.*no session/i);
    expect(manager.listAgents()).toHaveLength(1);
    expect(manager.listAgents()[0].lifecycle.status).toBe("stopped");
  });

  it("MessageAgent shares exact/prefix resolution and rejects ambiguity without delivery", async () => {
    retain("abc123de-1111-4000-8000-000000000001");
    retain("abc123de-2222-4000-8000-000000000002");
    await expect(message("abc123de", "continue please")).rejects.toThrow("Ambiguous agent id abc123de");
    expect((await message(" abc123de-1111 ", "continue please")).content[0].text).toContain("Message not sent");
  });

  it.each(["", " \n ", undefined, 3])("rejects an empty or invalid message", async (text) => {
    retain("abc123de-1111-4000-8000-000000000001");
    await expect(message("abc123de", text)).rejects.toThrow("message is required");
  });
});
