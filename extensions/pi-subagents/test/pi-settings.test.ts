/**
 * pi-settings.test.ts — readPiSettings / getHideThinkingBlock against real fs
 * with a spied home dir, exercising the exact production path
 * (~/.pi/agent/settings.json) with real JSON parsing and ENOENT handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { readPiSettings, getHideThinkingBlock, readDefaultTools } from "../src/pi-settings.js";
import { tempDirFixture } from "./fixtures.js";

// node:os is externalized (not configurable for spies) — mock only homedir
// and keep the rest of the module real (tmpdir feeds the temp fixture).
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: vi.fn(),
}));

describe("PiSettings", () => {
  const { setup, teardown } = tempDirFixture("pi-settings-test");
  let homeDir: string;

  beforeEach(() => {
    homeDir = setup();
    vi.mocked(os.homedir).mockReturnValue(homeDir);
    vi.stubEnv("PI_CODING_AGENT_DIR", path.join(homeDir, ".pi", "agent"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    teardown();
  });

  const writeSettings = (content: string): void => {
    const dir = path.join(homeDir, ".pi", "agent");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "settings.json"), content);
  };

  describe("readPiSettings", () => {
    it("reads an injected agent directory instead of conflicting HOME and environment settings", () => {
      writeSettings(JSON.stringify({ hideThinkingBlock: false }));
      const selectedDir = path.join(homeDir, "selected-agent");
      fs.mkdirSync(selectedDir);
      fs.writeFileSync(path.join(selectedDir, "settings.json"), JSON.stringify({ hideThinkingBlock: true }));

      expect(readPiSettings(selectedDir)).toEqual({ hideThinkingBlock: true });
    });

    it("uses getAgentDir at each read when PI_CODING_AGENT_DIR changes", () => {
      writeSettings(JSON.stringify({ hideThinkingBlock: false }));
      const selectedDir = path.join(homeDir, "selected-agent");
      fs.mkdirSync(selectedDir);
      fs.writeFileSync(path.join(selectedDir, "settings.json"), JSON.stringify({ hideThinkingBlock: true }));
      expect(getHideThinkingBlock()).toBe(false);

      vi.stubEnv("PI_CODING_AGENT_DIR", selectedDir);
      expect(getHideThinkingBlock()).toBe(true);
    });

    it("returns parsed settings from ~/.pi/agent/settings.json", () => {
      writeSettings(JSON.stringify({ hideThinkingBlock: true }));

      expect(readPiSettings()).toEqual({ hideThinkingBlock: true });
    });

    it("returns undefined when the file does not exist", () => {
      expect(readPiSettings()).toBeUndefined();
    });

    it("returns undefined when the JSON is invalid", () => {
      writeSettings("not json");

      expect(readPiSettings()).toBeUndefined();
    });
  });

  describe("getHideThinkingBlock", () => {
    it("returns true when hideThinkingBlock is true", () => {
      writeSettings(JSON.stringify({ hideThinkingBlock: true }));

      expect(getHideThinkingBlock()).toBe(true);
    });

    it("returns false when hideThinkingBlock is false", () => {
      writeSettings(JSON.stringify({ hideThinkingBlock: false }));

      expect(getHideThinkingBlock()).toBe(false);
    });

    it("returns false when the setting is missing", () => {
      writeSettings(JSON.stringify({}));

      expect(getHideThinkingBlock()).toBe(false);
    });

    it("returns false when the file cannot be read", () => {
      expect(getHideThinkingBlock()).toBe(false);
    });
  });
});

/* ------------------------------------------------------------------ */
/*  readDefaultTools                                                  */
/* ------------------------------------------------------------------ */

/** The public SettingsManager surface readDefaultTools consumes. */
type DefaultToolsManager = Pick<SettingsManager, "getDefaultTools">;

/** Assert a fake settings manager against the real SettingsManager at the read boundary. */
function asSettingsManager<S extends object>(fake: S): SettingsManager & S {
  return fake as SettingsManager & S;
}

describe("readDefaultTools", () => {
  it("returns the accessor's value when pi exposes getDefaultTools", () => {
    const manager: DefaultToolsManager = { getDefaultTools: () => ["read", "bash"] };
    expect(readDefaultTools(asSettingsManager(manager))).toEqual(["read", "bash"]);
  });

  it("returns undefined when the setting is unconfigured", () => {
    expect(readDefaultTools(asSettingsManager({ getDefaultTools: () => undefined }))).toBeUndefined();
  });

  it("keeps an explicitly empty [] distinct from unconfigured", () => {
    expect(readDefaultTools(asSettingsManager({ getDefaultTools: () => [] }))).toEqual([]);
  });

  it("degrades to undefined when the accessor holds a non-array", () => {
    expect(readDefaultTools(asSettingsManager({ getDefaultTools: () => null }))).toBeUndefined();
  });

  it("returns a copy so callers cannot mutate the manager's state", () => {
    const shared = ["read"];
    const manager: DefaultToolsManager = { getDefaultTools: () => shared };
    const tools = readDefaultTools(asSettingsManager(manager))!;
    tools.push("bash");
    expect(shared).toEqual(["read"]);
  });
});


describe("readDefaultTools with real Pi settings", () => {
  const { setup, teardown } = tempDirFixture("pi-default-tools-test");
  let cwd: string;
  let agentDir: string;

  beforeEach(() => {
    cwd = setup();
    agentDir = path.join(cwd, "agent");
    fs.mkdirSync(agentDir);
    fs.mkdirSync(path.join(cwd, ".pi"));
  });

  afterEach(() => teardown());

  it.each([
    { user: ["+tool_search", "+codemode"], project: undefined, want: ["read", "bash", "edit", "write", "tool_search", "codemode"] },
    { user: [], project: undefined, want: [] },
    { user: ["read", "bash"], project: ["-bash", "+grep"], want: ["read", "grep"] },
  ])("preserves Pi's resolved defaultTools ($user, $project)", ({ user, project, want }) => {
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultTools: user }));
    fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultTools: project }));

    expect(readDefaultTools(SettingsManager.create(cwd, agentDir))).toEqual(want);
  });
});
