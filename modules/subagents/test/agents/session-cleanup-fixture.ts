import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { ExtensionContext, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Real SDK startup/shutdown/context invalidation, with only the model prompt replaced. */
export async function sessionFixture(options: { startup?: Promise<void>; shutdownError?: Error } = {}) {
  const sdk = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>("@earendil-works/pi-coding-agent");
  const directory = mkdtempSync(join(tmpdir(), "subagents-cleanup-"));
  const startupEntered = deferred();
  const promptEntered = deferred();
  const promptFinished = deferred();
  const shutdownFinished = deferred();
  let context: ExtensionContext | undefined;
  let connected = false;
  let shutdowns = 0;
  const reasons: SessionShutdownEvent["reason"][] = [];
  const settingsManager = sdk.SettingsManager.inMemory();
  const loader = new sdk.DefaultResourceLoader({
    cwd: directory,
    agentDir: join(directory, "agent"),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [(pi) => {
      pi.on("session_start", async (_event, ctx) => {
        context = ctx;
        startupEntered.resolve();
        await options.startup;
        connected = true;
      });
      pi.on("session_shutdown", (event, ctx) => {
        // Accessing the native context here detects dispose-before-shutdown,
        // including an allocated session whose startup was cancelled.
        ctx.getSystemPrompt();
        context ??= ctx;
        connected = false;
        shutdowns++;
        reasons.push(event.reason);
        shutdownFinished.resolve();
        if (options.shutdownError) throw options.shutdownError;
      });
    }],
  });
  await loader.reload();
  const result = await sdk.createAgentSession({
    cwd: directory,
    agentDir: join(directory, "agent"),
    resourceLoader: loader,
    settingsManager,
    sessionManager: sdk.SessionManager.inMemory(directory),
    noTools: "all",
  });
  const session = result.session;
  vi.spyOn(session, "prompt").mockImplementation(async () => {
    promptEntered.resolve();
    await promptFinished.promise;
  });
  return {
    result, session, directory, startupEntered, promptEntered, promptFinished, shutdownFinished,
    get connected() { return connected; },
    get shutdowns() { return shutdowns; },
    reasons,
    readContext: () => context!.getSystemPrompt(),
    remove: () => { session.dispose(); rmSync(directory, { recursive: true, force: true }); },
  };
}
