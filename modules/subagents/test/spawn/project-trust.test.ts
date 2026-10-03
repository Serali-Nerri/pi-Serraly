/**
 * project-trust.test.ts — Trust gate resolution for cross-repo worktree targets.
 *
 * resolveSubagentTrust decides whether a subagent session treats the target
 * project as trusted:
 *   - Saved decisions win, including denials for same-repo targets.
 *   - Undecided same-repo targets inherit parent trust.
 *   - Undecided cross-repo targets use only the user-level
 *     defaultProjectTrust setting ("always" = trusted, anything else = not).
 *
 * The SDK building blocks (ProjectTrustStore, SettingsManager.getDefaultProjectTrust) are injected as
 * deps so the branching logic is unit-tested with fakes. An integration test
 * at the bottom exercises the real SDK functions against a temp agent dir.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveSubagentTrust,
  createSubagentTrustDeps,
  type SubagentTrustDeps,
} from "../../src/spawn/project-trust.js";

function makeDeps(overrides: Partial<SubagentTrustDeps> = {}): SubagentTrustDeps {
  return {
    getTrustDecision: () => null,
    getDefaultProjectTrust: () => "ask",
    ...overrides,
  };
}

describe("resolveSubagentTrust", () => {
  it("does not upgrade an undecided same-repo target of an untrusted parent", () => {
    expect(resolveSubagentTrust({
      targetPath: "/wt/feature",
      sameRepo: true,
      parentProjectTrusted: false,
      deps: makeDeps({ getDefaultProjectTrust: () => "always" }),
    })).toBe(false);
  });

  it("inherits trusted-parent state for an undecided same-repo target", () => {
    expect(resolveSubagentTrust({
      targetPath: "/wt/feature",
      sameRepo: true,
      parentProjectTrusted: true,
      deps: makeDeps({ getDefaultProjectTrust: () => "never" }),
    })).toBe(true);
  });

  it("honors an explicit deny even before a target acquires protected resources", () => {
    expect(resolveSubagentTrust({
      targetPath: "/repo-b",
      sameRepo: false,
      parentProjectTrusted: true,
      deps: makeDeps({ getTrustDecision: () => false }),
    })).toBe(false);
  });

  it("honors an explicit target deny over a trusted same-repo parent", () => {
    const result = resolveSubagentTrust({
      targetPath: "/wt/feature",
      sameRepo: true,
      parentProjectTrusted: true,
      deps: makeDeps({
        getTrustDecision: () => false,
      }),
    });
    expect(result).toBe(false);
  });

  it("loads an undecided resource-less cross-repo target under a user always default", () => {
    const result = resolveSubagentTrust({
      targetPath: "/repo-b",
      sameRepo: false,
      parentProjectTrusted: true,
      deps: makeDeps({ getDefaultProjectTrust: () => "always" }),
    });
    expect(result).toBe(true);
  });

  it("applies a saved untrusted decision for a cross-repo target", () => {
    const result = resolveSubagentTrust({
      targetPath: "/repo-b",
      sameRepo: false,
      parentProjectTrusted: true,
      deps: makeDeps({
        getTrustDecision: () => false,
      }),
    });
    expect(result).toBe(false);
  });

  it("applies a saved trusted decision for a cross-repo target", () => {
    const result = resolveSubagentTrust({
      targetPath: "/repo-b",
      sameRepo: false,
      parentProjectTrusted: true,
      deps: makeDeps({
        getTrustDecision: () => true,
      }),
    });
    expect(result).toBe(true);
  });

  it("falls back to defaultProjectTrust always → trusted when undecided", () => {
    const result = resolveSubagentTrust({
      targetPath: "/repo-b",
      sameRepo: false,
      parentProjectTrusted: true,
      deps: makeDeps({
        getTrustDecision: () => null,
        getDefaultProjectTrust: () => "always",
      }),
    });
    expect(result).toBe(true);
  });

  it("treats undecided targets as untrusted when the default is ask", () => {
    const result = resolveSubagentTrust({
      targetPath: "/repo-b",
      sameRepo: false,
      parentProjectTrusted: true,
      deps: makeDeps({
        getTrustDecision: () => null,
        getDefaultProjectTrust: () => "ask",
      }),
    });
    expect(result).toBe(false);
  });

  it("treats undecided targets as untrusted when the default is never", () => {
    const result = resolveSubagentTrust({
      targetPath: "/repo-b",
      sameRepo: false,
      parentProjectTrusted: true,
      deps: makeDeps({
        getTrustDecision: () => null,
        getDefaultProjectTrust: () => "never",
      }),
    });
    expect(result).toBe(false);
  });

  it("only asks for the default when the store is undecided", () => {
    const getDefaultProjectTrust = (): "ask" | "always" | "never" => {
      throw new Error("should not be consulted when a decision exists");
    };
    const result = resolveSubagentTrust({
      targetPath: "/repo-b",
      sameRepo: false,
      parentProjectTrusted: true,
      deps: makeDeps({
        getTrustDecision: () => true,
        getDefaultProjectTrust,
      }),
    });
    expect(result).toBe(true);
  });
});

// ── Integration: the real SDK building blocks behind the deps ────────────
// Proves the extension wiring (ProjectTrustStore +
// SettingsManager.getDefaultProjectTrust) resolves the
// same way against a real temp agent dir.

describe("resolveSubagentTrust — real SDK building blocks", () => {
  let baseDir: string;
  let agentDir: string;
  let targetDir: string;
  let parentDir: string;

  beforeEach(() => {
    baseDir = join(tmpdir(), `trust-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    agentDir = join(baseDir, "agent");
    targetDir = join(baseDir, "repo-b");
    parentDir = join(baseDir, "repo-a");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    mkdirSync(parentDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("gates an undecided target with .pi resources when the global default is ask", async () => {
    mkdirSync(join(targetDir, ".pi"), { recursive: true });
    writeFileSync(join(targetDir, ".pi", "settings.json"), "{}");
    const deps = createSubagentTrustDeps(agentDir, parentDir);

    const result = resolveSubagentTrust({ targetPath: targetDir, sameRepo: false,
      parentProjectTrusted: true, deps });

    expect(result).toBe(false);
  });

  it("loads resources for an undecided target when the global default is always", async () => {
    mkdirSync(join(targetDir, ".pi"), { recursive: true });
    writeFileSync(join(targetDir, ".pi", "settings.json"), "{}");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
    const deps = createSubagentTrustDeps(agentDir, parentDir);

    const result = resolveSubagentTrust({ targetPath: targetDir, sameRepo: false,
      parentProjectTrusted: true, deps });

    expect(result).toBe(true);
  });

  it("respects a saved trusted decision over an ask default", async () => {
    mkdirSync(join(targetDir, ".pi"), { recursive: true });
    writeFileSync(join(targetDir, ".pi", "settings.json"), "{}");
    const { ProjectTrustStore } = await import("@earendil-works/pi-coding-agent");
    new ProjectTrustStore(agentDir).set(targetDir, true);
    const deps = createSubagentTrustDeps(agentDir, parentDir);

    const result = resolveSubagentTrust({ targetPath: targetDir, sameRepo: false,
      parentProjectTrusted: true, deps });

    expect(result).toBe(true);
  });

  it("loads a target without protected resources when the user default is always", async () => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
    const deps = createSubagentTrustDeps(agentDir, parentDir);
    const result = resolveSubagentTrust({ targetPath: targetDir, sameRepo: false,
      parentProjectTrusted: true, deps });
    expect(result).toBe(true);
  });
  it.each(["ask", "never"] as const)(
    "does not preauthorize an undecided resource-less cross-repo target under user %s",
    (defaultProjectTrust) => {
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust }));
      const deps = createSubagentTrustDeps(agentDir, parentDir);

      expect(resolveSubagentTrust({
        targetPath: targetDir, sameRepo: false, parentProjectTrusted: true, deps,
      })).toBe(false);
    },
  );

  it.each(["ask", "never"] as const)(
    "ignores parent and target projects attempting to override the user %s trust default",
    (defaultProjectTrust) => {
      mkdirSync(join(parentDir, ".pi"));
      mkdirSync(join(targetDir, ".pi"));
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust }));
      writeFileSync(join(parentDir, ".pi", "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
      writeFileSync(join(targetDir, ".pi", "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
      const deps = createSubagentTrustDeps(agentDir, parentDir);

      expect(resolveSubagentTrust({
        targetPath: targetDir, sameRepo: false, parentProjectTrusted: false, deps,
      })).toBe(false);
    },
  );

  it("a saved same-repo deny beats trusted-parent inference with real SDK storage", async () => {
    mkdirSync(join(targetDir, ".pi"));
    writeFileSync(join(targetDir, ".pi", "settings.json"), "{}");
    const { ProjectTrustStore } = await import("@earendil-works/pi-coding-agent");
    new ProjectTrustStore(agentDir).set(targetDir, false);
    const deps = createSubagentTrustDeps(agentDir, parentDir);

    expect(resolveSubagentTrust({
      targetPath: targetDir, sameRepo: true, parentProjectTrusted: true, deps,
    })).toBe(false);
  });

});
