import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs";
import { vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import subagents from "../src/index.js";
import { defaultUi } from "./mock-utils.js";

/** Hold one real filesystem read to exercise navigation during discovery. */
export function holdAgentRead(path: string) {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const originalRead = fs.promises.readFile;
  let blocked = false;
  vi.spyOn(fs.promises, "readFile").mockImplementation(async (...args: Parameters<typeof originalRead>) => {
    const result = await originalRead(...args);
    if (!blocked && args[0] === path) {
      blocked = true;
      entered();
      await gate;
    }
    return result;
  });
  return { waiting, release };
}

/** Real host loader/session, with isolated disk discovery and no model or credentials. */
export async function mentionHarness(options: { trusted?: boolean; mode?: ExtensionContext["mode"]; excludeTools?: string[] } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "subagent-mention-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = join(cwd, "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await mkdir(agentDir);
  let pi!: ExtensionAPI;
  let replacementPi!: ExtensionAPI;
  let provider: AutocompleteProvider | undefined;
  const errors: unknown[] = [];
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: options.trusted ?? true });
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [
      { name: "replacement-fixture", factory(api) { replacementPi = api; } },
      { name: "pi-subagents", factory(api) { pi = api; subagents(api); } },
    ],
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: {
      read: async () => undefined, list: async () => [],
      modify: async (_id, fn) => fn(undefined), delete: async () => {},
    },
    modelsPath: null, modelsStorePath: join(cwd, "models-cache.json"),
    allowModelNetwork: false, refreshOnCreate: false,
  });
  await loader.reload();
  if (loader.getExtensions().errors.length) throw new Error(JSON.stringify(loader.getExtensions().errors));
  const { session } = await createAgentSession({
    cwd, agentDir, modelRuntime, settingsManager, resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd), excludeTools: options.excludeTools,
  });
  const bind = async (current?: AutocompleteProvider) => {
    provider = current;
    await session.bindExtensions({
      mode: options.mode ?? "print", onError: (error) => errors.push(error),
      ...(current ? { uiContext: { ...defaultUi, addAutocompleteProvider(factory) { provider = factory(provider!); } } } : {}),
    });
  };
  return {
    cwd, agentDir, session, pi, replacementPi, errors, bind,
    get provider() { return provider; },
    async profile(layer: "user" | "shared" | "project", file: string, name: string, fields = "") {
      const dir = layer === "user" ? join(agentDir, "agents")
        : join(cwd, layer === "shared" ? ".agents" : ".pi", "agents");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, file + ".md"), `---\nname: ${name}\n${fields}\n---\n\nFixture instructions.\n`);
    },
    async request(prompt: string) {
      return session.extensionRunner!.emitBeforeAgentStart(prompt, undefined, { cwd, customPrompt: "Original system prompt" });
    },
    async close() {
      try {
        await session.extensionRunner!.emit({ type: "session_shutdown", reason: "quit" });
      } finally {
        session.dispose();
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(cwd, { recursive: true, force: true });
      }
    },
  };
}
