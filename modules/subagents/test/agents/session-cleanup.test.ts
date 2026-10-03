import { afterEach, describe, expect, it, vi } from "vitest";
import { closeAgentSession } from "../../src/agents/session-cleanup.js";
import { deferred, sessionFixture } from "./session-cleanup-fixture.js";

describe("closeAgentSession", () => {
  const fixtures: Awaited<ReturnType<typeof sessionFixture>>[] = [];
  afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.remove(); });
  async function makeSession(options: Parameters<typeof sessionFixture>[0] = {}) {
    const fixture = await sessionFixture(options);
    fixtures.push(fixture);
    return fixture;
  }

  it("shutdown precedes native context invalidation exactly once across concurrent callers", async () => {
    const fixture = await makeSession();
    await fixture.session.bindExtensions({});
    const nativeDispose = fixture.session.dispose.bind(fixture.session);
    let disposals = 0;
    fixture.session.dispose = () => { disposals++; nativeDispose(); };
    const closing = closeAgentSession(fixture.session, "reload");
    const duplicate = closeAgentSession(fixture.session, "quit");
    await Promise.all([closing, duplicate]);
    expect(fixture.shutdowns).toBe(1);
    expect(fixture.reasons).toEqual(["reload"]);
    expect(fixture.connected).toBe(false);
    expect(() => fixture.readContext()).toThrow(/stale/);
    await closeAgentSession(fixture.session);
    expect(fixture.shutdowns).toBe(1);
    expect(disposals).toBe(1);
  });

  it("an uncooperative abort idle promise cannot hold native shutdown hostage", async () => {
    const fixture = await makeSession();
    await fixture.session.bindExtensions({});
    vi.spyOn(fixture.session, "abort").mockImplementation(() => new Promise(() => {}));
    await closeAgentSession(fixture.session);
    expect(fixture.connected).toBe(false);
    expect(fixture.shutdowns).toBe(1);
    expect(() => fixture.readContext()).toThrow(/stale/);
  });

  it("waits for startup before closing a connection established after the close request", async () => {
    const startup = deferred();
    const fixture = await makeSession({ startup: startup.promise });
    const ready = fixture.session.bindExtensions({});
    await fixture.startupEntered.promise;
    const closing = closeAgentSession(fixture.session, "fork", ready);
    expect(fixture.shutdowns).toBe(0);
    expect(() => fixture.readContext()).not.toThrow();
    startup.resolve();
    await closing;
    expect(fixture.connected).toBe(false);
    expect(fixture.reasons).toEqual(["fork"]);
    expect(() => fixture.readContext()).toThrow(/stale/);
  });

  it("startup rejection stays with its caller while native resource cleanup succeeds", async () => {
    const fixture = await makeSession();
    await fixture.session.bindExtensions({});
    const ready = deferred();
    const error = new Error("binding failed");
    const reported = expect(ready.promise).rejects.toBe(error);
    const closing = closeAgentSession(fixture.session, "quit", ready.promise);
    ready.reject(error);
    await Promise.all([reported, closing]);
    expect(fixture.connected).toBe(false);
    expect(fixture.shutdowns).toBe(1);
    expect(() => fixture.readContext()).toThrow(/stale/);
  });

  it("native shutdown handler errors remain visible while disposal still invalidates context", async () => {
    const fixture = await makeSession({ shutdownError: new Error("disconnect failed") });
    await fixture.session.bindExtensions({});
    await expect(closeAgentSession(fixture.session)).rejects.toThrow("disconnect failed");
    expect(fixture.connected).toBe(false);
    expect(() => fixture.readContext()).toThrow(/stale/);
  });

  it("a synchronous abort failure does not bypass shutdown or dispose", async () => {
    const fixture = await makeSession();
    await fixture.session.bindExtensions({});
    vi.spyOn(fixture.session, "abort").mockImplementation(() => { throw new Error("abort hook failed"); });
    await expect(closeAgentSession(fixture.session)).rejects.toThrow("abort hook failed");
    expect(fixture.connected).toBe(false);
    expect(() => fixture.readContext()).toThrow(/stale/);
  });
});
