import { afterEach, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface ScopeModule {
  isInsideSubagentSpawn(): boolean;
  runInSubagentContext?: <T>(operation: () => Promise<T>) => Promise<T>;
  enterSubagentSpawn?: () => void;
  exitSubagentSpawn?: () => void;
}

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function compiledScope(): Promise<ScopeModule> {
  const directory = await mkdtemp(join(tmpdir(), "subagents-scope-"));
  directories.push(directory);
  const outfile = join(directory, "scope.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../../src/shell.ts", import.meta.url))],
    outfile, bundle: true, platform: "node", format: "esm", target: "node22",
    plugins: [{
      name: "fixture-host-peers",
      setup(builder) {
        builder.onResolve({ filter: /^(?:@earendil-works\/|typebox(?:\/|$))/ }, ({ path }) => ({
          path: fileURLToPath(import.meta.resolve(path)), external: true,
        }));
      },
    }],
  });
  return import(pathToFileURL(outfile).href);
}

async function inChild<T>(scope: ScopeModule, operation: () => Promise<T>): Promise<T> {
  if (scope.runInSubagentContext) return scope.runInSubagentContext(operation);
  // Exercise the imported baseline before replacing its module-local depth.
  scope.enterSubagentSpawn!();
  try { return await operation(); } finally { scope.exitSubagentSpawn!(); }
}

describe("spawn context across independent compiled module instances", () => {
  it("a fresh module instance recognizes child initialization", async () => {
    const first = await compiledScope();
    const second = await compiledScope();
    await inChild(first, async () => {
      expect(first.isInsideSubagentSpawn()).toBe(true);
      await Promise.resolve();
      expect(second.isInsideSubagentSpawn()).toBe(true);
    });
    expect(second.isInsideSubagentSpawn()).toBe(false);
  }, 30_000);

  it("parallel parent work remains outside a pending child scope", async () => {
    const first = await compiledScope();
    const second = await compiledScope();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const child = inChild(first, async () => {
      await gate;
      expect(second.isInsideSubagentSpawn()).toBe(true);
    });
    try {
      expect(first.isInsideSubagentSpawn()).toBe(false);
      expect(second.isInsideSubagentSpawn()).toBe(false);
    } finally { release(); await child; }
  });

  it("a rejected child does not leave the parent in child context", async () => {
    const first = await compiledScope();
    await expect(inChild(first, async () => { throw new Error("startup failed"); })).rejects.toThrow("startup failed");
    expect(first.isInsideSubagentSpawn()).toBe(false);
  });
});
