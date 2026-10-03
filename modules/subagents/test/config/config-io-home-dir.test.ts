/** Config reads stay inside the selected Pi agent directory. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
let createConfigIO: typeof import("../../src/config/config-io.js").createConfigIO;
let loadConfig: typeof import("../../src/config/config-io.js").loadConfig;

let root: string;
let defaultAgentDir: string;
let agentDir: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "pi-subagents-config-"));
  const home = join(root, "home");
  defaultAgentDir = join(home, ".pi", "agent");
  agentDir = join(root, "selected-agent");
  mkdirSync(defaultAgentDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  vi.stubEnv("HOME", home);
  vi.stubEnv("PI_CODING_AGENT_DIR", defaultAgentDir);
  writeConfig(defaultAgentDir, "sentinel/home");
  vi.resetModules();
  ({ createConfigIO, loadConfig } = await import("../../src/config/config-io.js"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function writeConfig(dir: string, model: string): void {
  writeFileSync(join(dir, "subagents-lite.json"), JSON.stringify({ agent: { default: model } }));
}

describe("agent directory selection", () => {
  it("reads the environment-selected directory rather than the conflicting HOME config", () => {
    writeConfig(defaultAgentDir, "sentinel/home");
    writeConfig(agentDir, "sentinel/selected");

    expect(loadConfig().agent.default).toBe("sentinel/selected");
  });

  it("reads and saves only the injected directory when HOME and the environment disagree", () => {
    writeConfig(defaultAgentDir, "sentinel/home");
    writeConfig(agentDir, "sentinel/environment");
    const injectedDir = join(root, "injected");
    mkdirSync(injectedDir);
    writeConfig(injectedDir, "sentinel/injected");

    expect(loadConfig(injectedDir).agent.default).toBe("sentinel/injected");
    const io = createConfigIO(undefined, injectedDir);
    expect(io.load().global.agent?.default).toBe("sentinel/injected");
    io.saveGlobal({ agent: { default: "sentinel/saved" } });

    expect(JSON.parse(readFileSync(join(injectedDir, "subagents-lite.json"), "utf-8"))).toEqual({
      agent: { default: "sentinel/saved" },
    });
    expect(loadConfig(agentDir).agent.default).toBe("sentinel/environment");
    expect(loadConfig(defaultAgentDir).agent.default).toBe("sentinel/home");
  });

  it("resolves the current agent directory after import and between IO operations", () => {
    writeConfig(agentDir, "sentinel/first");
    const secondDir = join(root, "second-agent");
    mkdirSync(secondDir);
    writeConfig(secondDir, "sentinel/second");
    const io = createConfigIO();
    expect(io.load().global.agent?.default).toBe("sentinel/first");

    vi.stubEnv("PI_CODING_AGENT_DIR", secondDir);
    expect(loadConfig().agent.default).toBe("sentinel/second");
    expect(io.load().global.agent?.default).toBe("sentinel/second");
    io.saveGlobal({ agent: { default: "sentinel/new-second" } });
    expect(loadConfig(secondDir).agent.default).toBe("sentinel/new-second");
    expect(loadConfig(agentDir).agent.default).toBe("sentinel/first");
  });
});

describe("loadConfig defaults", () => {
  it("bakes in widget and watchdog defaults when no config file exists", () => {
    const config = loadConfig();
    expect(config.agent.widgetMaxLines).toBe(12);
    expect(config.agent.toolTimeoutMinutes).toBe(45);
    expect(config.agent.idleTimeoutMinutes).toBe(45);
  });
});
