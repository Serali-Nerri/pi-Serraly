/**
 * thinking-resolution.test.ts — The shared thinking precedence chain and the
 * displayed-value provenance.
 *
 * Spawn-effective precedence (highest to lowest):
 *   explicit > frontmatter > per-model > defaultThinking > undefined
 *
 * A configurable position may hold `parent`: it resolves to the parent
 * session's current level at that position (not as an extra fallback after
 * the chain), and reads as unset when no parent level is available, so the
 * chain continues past it.
 *
 * Display surfaces (pre-spawn) skip the explicit position, then fall through
 * to pi's global defaultThinkingLevel, then medium, clamped to the model —
 * and label which position decided the value.
 */

import { describe, it, expect } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  PARENT_THINKING_CHOICE,
  resolveThinkingLevel,
  resolveDisplayedThinking,
} from "../../src/models/thinking-resolution.js";

describe("resolveThinkingLevel", () => {
  it("returns the explicit spawn param when set, beating every other source", () => {
    expect(
      resolveThinkingLevel({ explicit: "low", frontmatter: "high", perModel: "max", defaultThinking: "medium" }),
    ).toBe("low");
  });

  it("returns frontmatter when no explicit param is given", () => {
    expect(resolveThinkingLevel({ frontmatter: "high", perModel: "max", defaultThinking: "medium" })).toBe("high");
  });

  it("returns the per-model level when explicit and frontmatter are unset", () => {
    expect(resolveThinkingLevel({ perModel: "max", defaultThinking: "medium" })).toBe("max");
  });

  it("per-model beats defaultThinking (default thinking only overrides pi's global default)", () => {
    expect(resolveThinkingLevel({ perModel: "low", defaultThinking: "max" })).toBe("low");
  });

  it("returns defaultThinking when it is the only source set", () => {
    expect(resolveThinkingLevel({ defaultThinking: "high" })).toBe("high");
  });

  it("returns undefined when nothing is set (pi's fallback decides)", () => {
    expect(resolveThinkingLevel({})).toBeUndefined();
  });

  it("treats explicit undefined keys the same as absent keys", () => {
    expect(resolveThinkingLevel({ explicit: undefined, frontmatter: undefined, perModel: undefined })).toBeUndefined();
  });
});

describe("resolveThinkingLevel — parent", () => {
  it("resolves a parent frontmatter selection to the parent session's level", () => {
    expect(
      resolveThinkingLevel({ frontmatter: PARENT_THINKING_CHOICE, perModel: "max", parentLevel: "high" }),
    ).toBe("high");
  });

  it("resolves a parent defaultThinking selection to the parent session's level", () => {
    expect(resolveThinkingLevel({ defaultThinking: PARENT_THINKING_CHOICE, parentLevel: "low" })).toBe("low");
  });

  it("resolves an explicit parent selection to the parent session's level", () => {
    expect(resolveThinkingLevel({ explicit: PARENT_THINKING_CHOICE, parentLevel: "max" })).toBe("max");
  });

  it("continues down the chain when the parent level is unavailable", () => {
    expect(resolveThinkingLevel({ frontmatter: PARENT_THINKING_CHOICE, defaultThinking: "medium" })).toBe("medium");
  });

  it("returns undefined when the only source is parent and no parent level is available", () => {
    expect(resolveThinkingLevel({ defaultThinking: PARENT_THINKING_CHOICE })).toBeUndefined();
  });

  it("a resolved explicit parent beats a concrete frontmatter value", () => {
    expect(
      resolveThinkingLevel({ explicit: PARENT_THINKING_CHOICE, frontmatter: "low", parentLevel: "high" }),
    ).toBe("high");
  });
});

describe("resolveDisplayedThinking", () => {
  // Minimal reasoning model; real clampThinkingLevel runs against it.
  const MODEL = {
    provider: "test",
    id: "model",
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh" },
  } as Model<Api>;

  it("labels a frontmatter value as frontmatter", () => {
    expect(resolveDisplayedThinking({ frontmatter: "high" }, "low", MODEL)).toEqual({
      level: "high",
      source: "frontmatter",
    });
  });

  it("labels a per-model value as pi per-model and lets it beat defaultThinking", () => {
    expect(resolveDisplayedThinking({ perModel: "high", defaultThinking: "low" }, undefined, MODEL)).toEqual({
      level: "high",
      source: "pi per-model",
    });
  });

  it("labels a defaultThinking value as subagent default", () => {
    expect(resolveDisplayedThinking({ defaultThinking: "high" }, undefined, MODEL)).toEqual({
      level: "high",
      source: "subagent default",
    });
  });

  it("labels a resolved parent value as parent, not as the position holding it", () => {
    expect(
      resolveDisplayedThinking({ frontmatter: PARENT_THINKING_CHOICE, parentLevel: "low" }, "high", MODEL),
    ).toEqual({ level: "low", source: "parent" });
  });

  it("continues past an unresolved parent to the next configured source", () => {
    expect(
      resolveDisplayedThinking({ frontmatter: PARENT_THINKING_CHOICE, perModel: "low" }, undefined, MODEL),
    ).toEqual({ level: "low", source: "pi per-model" });
  });

  it("falls through the chain to pi's global defaultThinkingLevel", () => {
    expect(resolveDisplayedThinking({}, "xhigh", MODEL)).toEqual({ level: "xhigh", source: "pi default" });
  });

  it("falls through to medium when no source and no pi default is set", () => {
    expect(resolveDisplayedThinking({}, undefined, MODEL)).toEqual({ level: "medium", source: "pi default" });
  });

  it("clamps the displayed result to the model's supported levels", () => {
    expect(resolveDisplayedThinking({ defaultThinking: "xhigh" }, undefined, MODEL)).toEqual({
      level: "xhigh",
      source: "subagent default",
    });
    expect(resolveDisplayedThinking({ defaultThinking: "max" }, undefined, MODEL)).toEqual({
      level: "xhigh",
      source: "subagent default",
    });
  });

  it("clamps a resolved parent level to the displayed model", () => {
    expect(
      resolveDisplayedThinking({ frontmatter: PARENT_THINKING_CHOICE, parentLevel: "max" }, undefined, MODEL),
    ).toEqual({ level: "xhigh", source: "parent" });
  });

  it("leaves the result unclamped when the model is not in the registry", () => {
    expect(resolveDisplayedThinking({ defaultThinking: "max" }, undefined, undefined)).toEqual({
      level: "max",
      source: "subagent default",
    });
  });
});
