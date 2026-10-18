/**
 * agent-widget-performance.test.ts — Widget work is bounded by what the host
 * actually shows: context samples stay fresh for a short window keyed by the
 * session/branch/model version, and records outside the viewport are not
 * formatted at all.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { agentConfigMock } from "../agent-types-mock.js";
import { asAgentSession } from "../pi-boundaries.js";
import type { LiveView, AgentRecord } from "../../src/types.js";
import type { Theme } from "../../src/ui/types.js";
import { AgentWidget, type UICtx } from "../../src/ui/agent-widget.js";
import {
  makeMockManager,
  makeMockTheme,
  makeRunningAgent,
  makeFinishedAgent,
  makeQueuedAgent,
  makeActivity,
} from "./widget-helpers.js";

/* ------------------------------------------------------------------ */
/*  Mock setup                                                        */
/* ------------------------------------------------------------------ */

vi.mock("../../src/agents/agent-types.js", () => ({
  getConfig: (type: string) => ({
    displayName: type.charAt(0).toUpperCase() + type.slice(1),
    tools: [],
    maxTurns: undefined,
    thinkingLevel: undefined,
  }),
  getAgentConfig: agentConfigMock(),
}));

// ANSI-aware width helpers (same contract as the real pi-tui exports).
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;
function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

vi.mock("@earendil-works/pi-tui", () => ({
  truncateToWidth: (text: string, width: number, ellipsis: string = "...") => {
    const visible = stripAnsi(text);
    if (visible.length <= width) return text;
    return visible.slice(0, Math.max(0, width - ellipsis.length)) + ellipsis;
  },
  visibleWidth: (text: string) => stripAnsi(text).length,
}));

/* ------------------------------------------------------------------ */
/*  Host harness — UI context + TUI external ports                    */
/* ------------------------------------------------------------------ */

type WidgetContent = NonNullable<Parameters<UICtx["setWidget"]>[1]>;

let widgets: AgentWidget[] = [];

function mount(
  agents: AgentRecord[],
  getLiveView: (id: string) => LiveView | undefined,
  theme: Theme = makeMockTheme(),
  configureWidget?: (widget: AgentWidget) => void,
) {
  const widget = new AgentWidget(makeMockManager(agents), getLiveView);
  configureWidget?.(widget);
  let component: ReturnType<WidgetContent> | undefined;
  let lines: string[] = [];

  const tui = {
    terminal: { columns: 400 },
    requestRender: vi.fn(() => {
      lines = component ? component.render() : [];
    }),
  };
  const ui: UICtx = {
    setStatus: vi.fn(),
    setWidget: vi.fn((_key: string, content: Parameters<UICtx["setWidget"]>[1]) => {
      component = content ? content(tui, theme) : undefined;
      lines = component ? component.render() : [];
    }),
  };

  widget.setUICtx(ui);
  widget.update();
  widgets.push(widget);

  return {
    widget,
    tui,
    ui,
    theme,
    render: () => {
      lines = component ? component.render() : [];
      return lines;
    },
    get lines() {
      return lines;
    },
    get component() {
      return component;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  widgets = [];
});

afterEach(() => {
  for (const widget of widgets) widget.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ */
/*  Context sampling — cheap getter, bounded TTL, version-key invalidation */
/* ------------------------------------------------------------------ */

interface ContextState {
  percent: number | null;
  sessionId: string;
  leaf: { id: string };
  model: { id: string; contextWindow: number };
}

function makeContextSource(state: ContextState) {
  const manager = {
    getSessionId: () => state.sessionId,
    getLeafId: () => state.leaf.id,
    getLeafEntry: () => state.leaf,
  };
  const getContextUsage = vi.fn(() => ({
    tokens: 100,
    contextWindow: state.model.contextWindow,
    percent: state.percent,
  }));
  const getSessionStats = vi.fn(() => {
    throw new Error("full session stats should not be computed for widget rows");
  });
  const session = asAgentSession({
    sessionManager: manager,
    get model() {
      return state.model;
    },
    getContextUsage,
    getSessionStats,
  });
  return { state, manager, session, getContextUsage, getSessionStats };
}

function contextState(overrides: Partial<ContextState> = {}): ContextState {
  return {
    percent: 40,
    sessionId: "session-1",
    leaf: { id: "leaf-1" },
    model: { id: "selected", contextWindow: 1000 },
    ...overrides,
  };
}

function runningWithContext(id: string, source: ReturnType<typeof makeContextSource>): AgentRecord {
  const running = makeRunningAgent(id);
  running.execution.session = source.session as never;
  return running;
}

describe("context sampling", () => {
  it("reuses one sample for direct host renders inside the freshness window", () => {
    const source = makeContextSource(contextState());
    const host = mount([runningWithContext("running", source)], () => makeActivity("running"));

    for (let i = 0; i < 100; i++) host.render();

    expect(source.getContextUsage).toHaveBeenCalledTimes(1);
    expect(host.lines.join("\n")).toContain("40%");
  });

  it("resamples on a branch change inside the freshness window", () => {
    const source = makeContextSource(contextState({ percent: 40 }));
    const host = mount([runningWithContext("running", source)], () => makeActivity("running"));

    source.state.percent = 70;
    vi.advanceTimersByTime(100);
    host.widget.update();
    expect(host.lines.join("\n")).toContain("40%");

    // A branch change invalidates immediately, even inside the 500 ms window.
    source.state.leaf = { id: "leaf-2" };
    host.widget.update();
    expect(host.lines.join("\n")).toContain("70%");
    expect(source.getSessionStats).not.toHaveBeenCalled();
  });

  it("resamples when session, leaf entry, model or compaction identity changes", () => {
    const source = makeContextSource(contextState());
    const running = runningWithContext("running", source);
    const host = mount([running], () => makeActivity("running"));
    source.getContextUsage.mockClear();

    host.widget.update();
    expect(source.getContextUsage).not.toHaveBeenCalled();

    source.state.leaf = { id: "leaf-2" };
    host.widget.update();
    expect(source.getContextUsage).toHaveBeenCalledTimes(1);

    source.state.leaf = { id: "leaf-2" };
    host.widget.update();
    expect(source.getContextUsage).toHaveBeenCalledTimes(2);

    source.state.sessionId = "session-2";
    host.widget.update();
    expect(source.getContextUsage).toHaveBeenCalledTimes(3);

    source.state.model = { id: "other", contextWindow: 1000 };
    host.widget.update();
    expect(source.getContextUsage).toHaveBeenCalledTimes(4);

    source.state.model.contextWindow = 2000;
    host.widget.update();
    expect(source.getContextUsage).toHaveBeenCalledTimes(5);

    running.stats.compactionCount++;
    host.widget.update();
    expect(source.getContextUsage).toHaveBeenCalledTimes(6);
  });

  it("drops the stale percent after a compaction until a fresh sample exists", () => {
    const source = makeContextSource(contextState({ percent: 40 }));
    const running = runningWithContext("running", source);
    const host = mount([running], () => makeActivity("running"));
    expect(host.lines.join("\n")).toContain("40%");

    running.stats.compactionCount++;
    source.state.percent = null;
    host.widget.update();

    expect(host.lines.join("\n")).not.toContain("40%");
  });

  it("skips context queries while the context column is hidden", () => {
    const source = makeContextSource(contextState({ percent: 40 }));
    const host = mount([runningWithContext("running", source)], () => makeActivity("running"));

    host.widget.setStatsVisibility({ showContext: false });
    host.widget.update();
    source.getContextUsage.mockClear();
    host.widget.ensureTimer();
    vi.advanceTimersByTime(800);

    expect(source.getContextUsage).not.toHaveBeenCalled();
    expect(host.lines.join("\n")).not.toContain("40%");

    host.widget.setStatsVisibility({ showContext: true });
    host.widget.update();
    expect(source.getContextUsage).toHaveBeenCalledTimes(1);
    expect(host.lines.join("\n")).toContain("40%");
  });

  it("does not query context for finished or queued rows", () => {
    const finished = makeFinishedAgent("done", { withSession: true });
    const getContextUsage = vi.fn(() => {
      throw new Error("finished rows must not query context");
    });
    finished.execution.session = asAgentSession({ getContextUsage, getSessionStats: vi.fn() }) as never;
    const queued = makeQueuedAgent("queued");
    const host = mount([finished, queued], () => undefined);

    expect(getContextUsage).not.toHaveBeenCalled();

    finished.stats.contextPercent = 55;
    host.widget.update();
    expect(getContextUsage).not.toHaveBeenCalled();
    expect(host.lines.join("\n")).toContain("55%");
  });

  it("refreshes after at most half a second even when branch and model stay unchanged", () => {
    const source = makeContextSource(contextState({ percent: 10 }));
    const host = mount([runningWithContext("running", source)], () => makeActivity("running"));
    source.state.percent = 20;
    vi.advanceTimersByTime(499);
    host.widget.update();
    expect(host.lines.join("\n")).toContain("10%");
    vi.advanceTimersByTime(1);
    host.widget.update();
    expect(source.getContextUsage).toHaveBeenCalledTimes(2);
    expect(host.lines.join("\n")).toContain("20%");
  });

  it("survives a failing branch identity lookup", () => {
    const source = makeContextSource(contextState({ percent: 45 }));
    const running = runningWithContext("running", source);
    const host = mount([running], () => makeActivity("running"));

    source.manager.getLeafId = () => {
      throw new Error("session manager closed");
    };
    host.widget.update();

    expect(host.lines.join("\n")).toContain("45%");
  });

  it("resamples after the clock moves backwards", () => {
    const source = makeContextSource(contextState());
    const host = mount([runningWithContext("running", source)], () => makeActivity("running"));
    source.getContextUsage.mockClear();

    vi.setSystemTime(new Date(Date.now() - 1000));
    host.widget.update();

    expect(source.getContextUsage).toHaveBeenCalledTimes(1);
  });

  it("drops samples on dispose", () => {
    const source = makeContextSource(contextState());
    const host = mount([runningWithContext("running", source)], () => makeActivity("running"));
    source.getContextUsage.mockClear();

    host.widget.dispose();
    host.widget.update();

    expect(source.getContextUsage).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ */
/*  Lazy formatting — rows outside the viewport are never built       */
/* ------------------------------------------------------------------ */

describe("visible-row formatting", () => {
  it("does not format rows outside the viewport or redraw a static block", () => {
    const finishedA = makeFinishedAgent("alpha");
    const finishedB = makeFinishedAgent("beta");
    const source = makeContextSource(contextState({ percent: 40 }));
    const running = runningWithContext("running", source);
    const getLiveView = vi.fn<(id: string) => LiveView | undefined>(() => makeActivity("running"));

    const host = mount([finishedA, finishedB, running], getLiveView);

    host.widget.setMaxLines(4);
    host.widget.update();
    expect(host.lines.join("\n")).toContain("+1 more");
    expect(host.lines.join("\n")).not.toContain("Test agent running");

    getLiveView.mockClear();
    source.getContextUsage.mockClear();
    host.tui.requestRender.mockClear();
    host.widget.ensureTimer();
    vi.advanceTimersByTime(800);

    expect(getLiveView).not.toHaveBeenCalled();
    expect(source.getContextUsage).not.toHaveBeenCalled();
    expect(host.tui.requestRender).not.toHaveBeenCalled();

    // Revealing the row through navigation formats it again.
    host.widget.navActivate();
    host.widget.navDown();
    host.widget.navDown();
    expect(host.lines.join("\n")).toContain("Test agent running");
    expect(getLiveView).toHaveBeenCalled();
    expect(source.getContextUsage).toHaveBeenCalled();

    host.tui.requestRender.mockClear();
    vi.advanceTimersByTime(160);
    expect(host.tui.requestRender).toHaveBeenCalledTimes(2);
  });
});

/* ------------------------------------------------------------------ */
/*  Static redraw suppression — identical frames skip requestRender    */
/* ------------------------------------------------------------------ */

describe("static redraw suppression", () => {
  it("does not redraw a static finished block on every timer tick", () => {
    const finished = makeFinishedAgent("done");
    finished.lifecycle.completedAt = Date.now();
    const host = mount([finished], () => undefined);
    host.widget.ensureTimer();

    vi.advanceTimersByTime(60_000);
    expect(host.tui.requestRender).not.toHaveBeenCalled();
    expect(host.lines.join("\n")).toContain("Finished agent done");

    // Once the retention window closes the block is dropped, not redrawn.
    vi.advanceTimersByTime(80);
    expect(host.ui.setWidget).toHaveBeenLastCalledWith("agents", undefined);
    expect(host.lines).toEqual([]);
    expect(host.ui.setStatus).not.toHaveBeenCalledWith("subagents", undefined);
  });

  it("redraws when a queued agent starts running", () => {
    const queued = makeQueuedAgent("queued");
    const host = mount([queued], () => undefined);
    host.widget.ensureTimer();

    vi.advanceTimersByTime(8_000);
    expect(host.tui.requestRender).not.toHaveBeenCalled();

    queued.lifecycle.status = "running";
    queued.lifecycle.started = true;
    vi.advanceTimersByTime(80);
    expect(host.tui.requestRender).toHaveBeenCalledTimes(1);

    // A running row animates, so every tick is a redraw from now on.
    const previous = [...host.lines];
    vi.advanceTimersByTime(80);
    expect(host.tui.requestRender).toHaveBeenCalledTimes(2);
    expect(host.lines).not.toEqual(previous);
  });

  it("keeps the visible spinner and activity on the 80 ms cadence", () => {
    const running = makeRunningAgent("running");
    const activity = makeActivity("running");
    const host = mount([running], () => activity);
    const initial = [...host.lines];
    host.widget.ensureTimer();

    vi.advanceTimersByTime(800);
    expect(host.tui.requestRender).toHaveBeenCalledTimes(10);
    expect(host.lines).toEqual(initial);

    activity.activeTools.clear();
    activity.responseText = "new response";
    vi.advanceTimersByTime(80);
    expect(host.tui.requestRender).toHaveBeenCalledTimes(11);
    expect(host.lines.join("\n")).toContain("new response");
  });

  it("observes finished-record mutations and widget settings", () => {
    const finished = makeFinishedAgent("done");
    const host = mount([finished], () => undefined);

    finished.stats.contextPercent = 77;
    host.widget.update();
    expect(host.tui.requestRender).toHaveBeenCalledTimes(1);
    expect(host.lines.join("\n")).toContain("77%");

    host.widget.setStatsVisibility({ showContext: false });
    host.widget.update();
    expect(host.tui.requestRender).toHaveBeenCalledTimes(2);
    expect(host.lines.join("\n")).not.toContain("77%");

    host.widget.ensureTimer();
    vi.advanceTimersByTime(800);
    expect(host.tui.requestRender).toHaveBeenCalledTimes(2);
  });

  it("re-registers the component after a width or theme change", () => {
    const finished = makeFinishedAgent("done");
    const host = mount([finished], () => undefined);

    host.tui.terminal.columns = 30;
    host.widget.update();
    expect(host.tui.requestRender).toHaveBeenCalledTimes(1);
    expect(host.ui.setWidget).toHaveBeenCalledTimes(1);

    host.tui.terminal.columns = 400;
    host.theme.fg = (color: string, text: string) => `<${color}:${text}>`;
    host.component!.invalidate();
    host.widget.update();
    expect(host.ui.setWidget).toHaveBeenCalledTimes(2);
    expect(host.lines.join("\n")).toContain("<dim:Finished agent done>");
  });

  it("does not retain the mutable line array handed to the host", () => {
    const finished = makeFinishedAgent("done");
    const host = mount([finished], () => undefined);

    host.lines[1] = "consumer mutation";
    host.widget.update();

    expect(host.tui.requestRender).not.toHaveBeenCalled();
  });

  it("re-ranks finished navigation rows after the freeze window without a spinner", () => {
    const running = makeRunningAgent("running");
    const finished = makeFinishedAgent("done");
    const host = mount([running, finished], () => makeActivity("running"));

    host.widget.navActivate();
    host.widget.navDown();

    running.lifecycle.status = "completed";
    running.lifecycle.completedAt = Date.now();
    host.widget.ensureTimer();
    vi.advanceTimersByTime(80);
    expect(host.lines[1]).toContain("Finished agent done");
    expect(host.lines[2]).toMatch(/^→ /);

    host.tui.requestRender.mockClear();
    vi.advanceTimersByTime(1920);
    expect(host.tui.requestRender).not.toHaveBeenCalled();

    vi.advanceTimersByTime(80);
    expect(host.tui.requestRender).toHaveBeenCalledTimes(1);
    expect(host.lines[1]).toMatch(/^→ /);
    expect(host.lines[2]).toContain("Finished agent done");
  });

  it("serves fresh rows on host-driven component renders", () => {
    const finished = makeFinishedAgent("done");
    const host = mount([finished], () => undefined);

    finished.display.description = "Updated description";
    expect(host.render().join("\n")).toContain("Updated description");
  });

  it("keeps navigation moving when a live-view read fails during the comparison render", () => {
    const queued = makeQueuedAgent("first");
    const agents: AgentRecord[] = [queued];
    const getLiveView = vi.fn<(id: string) => LiveView | undefined>(() => {
      throw new Error("transcript unavailable");
    });
    const host = mount(agents, getLiveView, makeMockTheme(), (widget) => widget.navActivate());

    const running = makeRunningAgent("second");
    agents.push(running);
    host.tui.requestRender.mockImplementation(() => {});

    expect(() => host.widget.navDown()).not.toThrow();
    expect(host.widget.navSelect()?.id).toBe("second");
  });
});
