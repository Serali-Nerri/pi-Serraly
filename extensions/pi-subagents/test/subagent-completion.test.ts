import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { holdAgentRead, mentionHarness } from "./mention-harness.js";

let harness: Awaited<ReturnType<typeof mentionHarness>> | undefined;
afterEach(async () => { vi.restoreAllMocks(); await harness?.close(); harness = undefined; });
const options = () => ({ signal: new AbortController().signal });

describe("subagent completion through public host provider stacking", () => {
  it.each([true, false])("inserts exact visible effective names with project trust %s and preserves native file ranges", async (trusted) => {
    harness = await mentionHarness({ mode: "tui", trusted });
    await harness.profile("user", "worker", "Worker", "description: User worker");
    await harness.profile("shared", "worker", "Worker", "description: Shared worker");
    await harness.profile("project", "worker", "Worker", "description: Project worker");
    await harness.profile("user", "team", "review team");
    await harness.profile("project", "hidden", "Hidden", "hidden: true");
    await harness.profile("user", "control", "bad\x1b[2J");
    await harness.profile("user", "brackets", "bad[name]");
    await writeFile(join(harness.cwd, "seed.txt"), "seed");
    const native = new CombinedAutocompleteProvider([], harness.cwd);
    await harness.bind(native);
    const provider = harness.provider!;
    const all = await provider.getSuggestions(["@subagent:"], 0, 10, options());
    expect(all?.items.map((item) => item.value)).toEqual([
      "@subagent:[general-purpose]", "@subagent:[Explore]", "@subagent:[review team]", "@subagent:[Worker]",
    ]);
    expect(all?.items.find((item) => item.value === "@subagent:[Worker]")?.description).toBe(trusted ? "Project worker" : "User worker");
    const lines = ["Keep this", "delegate (@subagent:[w) then continue"];
    const cursor = "delegate (@subagent:[w".length;
    const suggestions = await provider.getSuggestions(lines, 1, cursor, options());
    expect(suggestions?.prefix).toBe("@subagent:[w");
    expect(provider.applyCompletion(lines, 1, cursor, suggestions!.items[0], suggestions!.prefix)).toEqual({
      lines: ["Keep this", "delegate (@subagent:[Worker] ) then continue"], cursorLine: 1, cursorCol: 29,
    });
    const nativeLines = ["open ./see"];
    const expected = await native.getSuggestions(nativeLines, 0, 10, options());
    const actual = await provider.getSuggestions(nativeLines, 0, 10, options());
    expect(actual?.items.some((item) => item.value.includes("seed.txt"))).toBe(true);
    expect(actual).toEqual(expected);
    expect(provider.applyCompletion(nativeLines, 0, 10, actual!.items[0], actual!.prefix))
      .toEqual(native.applyCompletion(nativeLines, 0, 10, expected!.items[0], expected!.prefix));
    expect(harness.errors).toEqual([]);
  });

  it("owns complete mention tokens and replaces a partially edited bracketed name without turning it into an attachment", async () => {
    harness = await mentionHarness({ mode: "tui" });
    await harness.bind(new CombinedAutocompleteProvider([], harness.cwd));
    const provider = harness.provider!;
    expect(provider.shouldTriggerFileCompletion?.(["@subagent:[Explore]"], 0, 19)).toBe(false);
    expect(await provider.getSuggestions(["@subagent:[Explore]"], 0, 19, options())).toBeNull();
    const edited = ["@subagent:[Explore] tail"];
    const suggestions = await provider.getSuggestions(edited, 0, 14, options());
    expect(provider.applyCompletion(edited, 0, 14, suggestions!.items[0], suggestions!.prefix)).toEqual({
      lines: ["@subagent:[Explore] tail"], cursorLine: 0, cursorCol: 19,
    });
  });

  it("does not publish a disposed session's completion or guidance after shutdown and restart", async () => {
    harness = await mentionHarness({ mode: "tui" });
    const native = new CombinedAutocompleteProvider([], harness.cwd);
    await harness.bind(native);
    const oldProvider = harness.provider!;
    const pending = oldProvider.getSuggestions(["@subagent:"], 0, 10, options());
    const pendingRequest = harness.request("@subagent:[Explore]");
    await harness.session.extensionRunner!.emit({ type: "session_shutdown", reason: "new" });
    expect(await pending).toBeNull();
    expect((await pendingRequest).messages).toEqual([]);
    expect(await oldProvider.getSuggestions(["@subagent:"], 0, 10, options())).toBeNull();
    expect((await harness.request("@subagent:[Explore]")).messages).toEqual([]);
    await harness.session.extensionRunner!.emit({ type: "session_start", reason: "new" });
    expect(await oldProvider.getSuggestions(["@subagent:"], 0, 10, options())).toBeNull();
    expect((await harness.provider!.getSuggestions(["@subagent:"], 0, 10, options()))?.items.map((item) => item.value))
      .toContain("@subagent:[Explore]");
    expect(harness.errors).toEqual([]);
  });

  it.each(["reload", "tree"] as const)("keeps current candidates and guidance when an older %s scan completes late", async (navigation) => {
    harness = await mentionHarness({ mode: "tui" });
    await harness.profile("project", "late", "OldProject");
    await harness.bind(new CombinedAutocompleteProvider([], harness.cwd));
    const { waiting, release } = holdAgentRead(join(harness.cwd, ".pi", "agents", "late.md"));
    const older = harness.session.extensionRunner!.emit(navigation === "reload"
      ? { type: "session_start", reason: "reload" }
      : { type: "session_tree", oldLeafId: null, newLeafId: null });
    try {
      await waiting;
      await harness.session.extensionRunner!.emit({ type: "session_shutdown", reason: "new" });
      await harness.profile("project", "late", "NewProject");
      await harness.session.extensionRunner!.emit({ type: "session_start", reason: "new" });
    } finally {
      release();
      await older;
    }
    const suggestions = await harness.provider!.getSuggestions(["@subagent:"], 0, 10, options());
    expect(suggestions?.items.map((item) => item.value)).toContain("@subagent:[NewProject]");
    expect(suggestions?.items.map((item) => item.value)).not.toContain("@subagent:[OldProject]");
    const request = await harness.request("@subagent:[OldProject] @subagent:[NewProject]");
    expect(request.messages[0].content).toContain('Agent {"agent":"NewProject"}');
    expect(request.messages[0].content).not.toContain('Agent {"agent":"OldProject"}');
    expect(harness.errors).toEqual([]);
  });

  it("does not import an old project's on-demand Agent discovery into the next session", async () => {
    harness = await mentionHarness({ mode: "tui" });
    await harness.bind(new CombinedAutocompleteProvider([], harness.cwd));
    await harness.profile("project", "late", "OldProject");
    const { waiting, release } = holdAgentRead(join(harness.cwd, ".pi", "agents", "late.md"));
    const older = harness.session.getToolDefinition("Agent")!.execute(
      "unknown", { prompt: "Do not spawn", agent: "missing" }, undefined, undefined,
      harness.session.extensionRunner!.createToolContext("unknown", undefined),
    ).catch((error: unknown) => error);
    try {
      await waiting;
      await harness.session.extensionRunner!.emit({ type: "session_shutdown", reason: "new" });
      await harness.profile("project", "late", "NewProject");
      await harness.session.extensionRunner!.emit({ type: "session_start", reason: "new" });
    } finally {
      release();
    }
    expect(await older).toMatchObject({ message: "Unknown agent type: missing" });
    const suggestions = await harness.provider!.getSuggestions(["@subagent:"], 0, 10, options());
    expect(suggestions?.items.map((item) => item.value)).not.toContain("@subagent:[OldProject]");
    expect(suggestions?.items.map((item) => item.value)).toContain("@subagent:[NewProject]");
  });
});
