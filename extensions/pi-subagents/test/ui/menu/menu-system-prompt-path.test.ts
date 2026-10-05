/** The real menu reads and creates prompt files in the selected agent directory. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { createMockCtx, type ComponentFactory } from "../../menu-test-helpers.js";

vi.mock("../../../src/shell.js", () => ({
  getStore: () => ({ agent: { systemPromptMode: "custom" } }),
}));

// Import once: changing agent directories must not retain an import-time path.
import { showSystemPromptMenu } from "../../../src/ui/menu/menu-system-prompt.js";

let root: string;
let agentDir: string;
let homePrompt: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "subagents-prompt-menu-"));
  const home = join(root, "home");
  const defaultDir = join(home, ".pi", "agent");
  agentDir = join(root, "selected-agent");
  mkdirSync(defaultDir, { recursive: true });
  mkdirSync(agentDir);
  homePrompt = join(defaultDir, "subagents-lite-prompt.md");
  writeFileSync(homePrompt, "DO_NOT_OVERWRITE_HOME_PROMPT");
  vi.stubEnv("HOME", home);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

async function openMenu(): Promise<Component> {
  let component: Component | undefined;
  const ctx = createMockCtx([], [], [], {
    ui: {
      custom: async (factory: ComponentFactory) => {
        component = await factory(
          { terminal: { rows: 40 } },
          { fg: (_color, text) => text, bold: (text) => text, italic: (text) => text },
          undefined,
          () => {},
        ) as Component;
        return undefined;
      },
    },
  });
  await showSystemPromptMenu(ctx);
  return component!;
}

describe("custom prompt menu path", () => {
  it("offers and creates the selected agent's prompt without touching the HOME sentinel", async () => {
    const component = await openMenu();
    const promptPath = join(agentDir, "subagents-lite-prompt.md");
    // This checks path identity, not clipping; allow room for the isolated fixture path.
    const width = 160 + visibleWidth(promptPath);
    expect(component.render(width).join("\n")).toContain(promptPath);

    component.handleInput?.("\x1b[B");
    component.handleInput?.("\r");

    expect(readFileSync(join(agentDir, "subagents-lite-prompt.md"), "utf-8")).toContain("expert coding sub-agent");
    expect(readFileSync(homePrompt, "utf-8")).toBe("DO_NOT_OVERWRITE_HOME_PROMPT");
  });

  it("does not offer creation when the prompt already exists in the selected directory", async () => {
    const promptPath = join(agentDir, "subagents-lite-prompt.md");
    writeFileSync(promptPath, "SELECTED_PROMPT");

    const component = await openMenu();

    expect(component.render(160).join("\n")).not.toContain("Create prompt file");
    expect(readFileSync(promptPath, "utf-8")).toBe("SELECTED_PROMPT");
  });
});
