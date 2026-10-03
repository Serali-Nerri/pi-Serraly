/** Package identity and diagnostics use discovered entries, before any factory runs. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DefaultPackageManager, DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { resolveChildExtensions, type ChildExtensionSelection } from "../../src/agents/extension-selection.js";

const disabledNative = ["-builtin:codemode", "-builtin:tool-search", "-builtin:mcp"];
const nativePaths = ["builtin:codemode", "builtin:mcp", "builtin:tool-search"];

type SelectionOptions = Parameters<typeof resolveChildExtensions>[0];

// Fixtures only register hooks: a factory need not export tools to have side
// effects, and a post-load tool filter cannot undo its execution.
describe("package-name matching before extension factory execution", () => {
  let root: string;
  let cwd: string;
  let agentDir: string;
  let factoryLog: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "package-name-matching-"));
    cwd = join(root, "project");
    agentDir = join(root, "agent");
    factoryLog = join(root, "factories.log");
    mkdirSync(cwd);
    mkdirSync(agentDir);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function executed(): string[] {
    return existsSync(factoryLog) ? readFileSync(factoryLog, "utf8").trim().split("\n").filter(Boolean).sort() : [];
  }

  function entry(file: string, label: string): string {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `import fs from "node:fs";
export default function(pi) {
  fs.appendFileSync(${JSON.stringify(factoryLog)}, ${JSON.stringify(label + "\n")});
  pi.on("session_start", async () => {});
}
`);
    return file;
  }

  function packageFixture(directory: string, name: string, entries: string[]): string[] {
    const packageRoot = join(root, directory);
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
      name, type: "module", pi: { extensions: entries },
    }));
    return entries.map((file, index) => entry(join(packageRoot, file), `entry-${index}`));
  }

  function settings(options: { packages?: string[]; extensions?: string[] } = {}): SettingsManager {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: disabledNative, ...options }));
    return SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  }

  async function select(
    settingsManager: SettingsManager,
    extensions: SelectionOptions["extensions"],
    excludeExtensions?: string[],
  ) {
    const diagnostics: { message: string; factories: string[] }[] = [];
    const selection = await resolveChildExtensions({
      cwd, agentDir, settingsManager, extensions, excludeExtensions,
      notify: (message) => diagnostics.push({ message, factories: executed() }),
    });
    expect(executed()).toEqual([]);
    return { selection, diagnostics };
  }

  async function load(settingsManager: SettingsManager, selection: ChildExtensionSelection): Promise<string[]> {
    const loader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager, noExtensions: true,
      additionalExtensionPaths: selection.additionalExtensionPaths,
      extensionFactories: selection.extensionFactories,
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    expect(loaded.errors).toEqual([]);
    return loaded.extensions.map((extension) => extension.path).sort();
  }

  // Consolidates the original renamed-directory, case, scope, root-entry and
  // node_modules cases, using a harmless package rather than the excluded self.
  it.each([
    { identity: "renamed checkout and entry", directory: "renamed-checkout", name: "pi-fixture", file: "src/renamed.ts", request: "pi-fixture" },
    { identity: "case-insensitive package name", directory: "checkout", name: "Pi-Fixture", file: "src/index.ts", request: "PI-FIXTURE" },
    { identity: "scoped package short name", directory: "checkout", name: "@scope/pi-fixture", file: "dist/index.js", request: "pi-fixture" },
    { identity: "root entry", directory: "checkout", name: "pi-fixture", file: "index.ts", request: "pi-fixture" },
    { identity: "scoped node_modules installation", directory: "install/node_modules/@scope/pi-fixture", name: "@scope/pi-fixture", file: "dist/index.js", request: "pi-fixture" },
  ])("selects $identity without executing unrelated factories", async ({ directory, name, file, request }) => {
    const [selectedPath] = packageFixture(directory, name, [file]);
    const unrelated = entry(join(agentDir, "extensions/unrelated.ts"), "unrelated");
    const manager = settings({ packages: [join(root, directory)], extensions: [...disabledNative, unrelated] });
    const { selection, diagnostics } = await select(manager, [request]);

    expect(diagnostics).toEqual([]);
    expect(selection.additionalExtensionPaths).toEqual([selectedPath]);
    expect(await load(manager, selection)).toEqual([selectedPath]);
    expect(executed()).toEqual(["entry-0"]);
  });

  it("does not attribute a direct entry to a package that never declared it", async () => {
    const packageRoot = join(root, "checkout");
    packageFixture("checkout", "pi-fixture", ["lib/declared.ts"]);
    const loosePath = entry(join(packageRoot, "src/loose.ts"), "loose");
    const manager = settings({ extensions: [...disabledNative, loosePath] });
    // The real SDK discovers this enabled file; rejection is an identity
    // decision, not a test that passes because its candidate never existed.
    const discovered = await new DefaultPackageManager({ cwd, agentDir, settingsManager: manager }).resolve(async () => "skip");
    expect(discovered.extensions.filter((resource) => resource.enabled).map((resource) => resource.path)).toEqual([loosePath]);

    const rejected = await select(manager, ["pi-fixture"]);
    expect(rejected.selection.additionalExtensionPaths).toEqual([]);
    expect(rejected.diagnostics).toHaveLength(1);
    expect(rejected.diagnostics[0].message).toContain("pi-fixture");
    expect(rejected.diagnostics[0].factories).toEqual([]);
    expect(await load(manager, rejected.selection)).toEqual([]);

    const admitted = await select(manager, ["loose"]);
    expect(admitted.diagnostics).toEqual([]);
    expect(await load(manager, admitted.selection)).toEqual([loosePath]);
    expect(executed()).toEqual(["loose"]);
  });

  // Source module names, bundled module names, and the whole package are
  // separate identities. Hook-only siblings must not execute for a leaf alias.
  it.each([
    { shape: "source", file: "modules/widget/src/index.ts", request: "pi-widget" },
    { shape: "bundled", file: "dist/pi-widget/index.js", request: "pi-widget" },
    { shape: "named source entry", file: "src/widget.ts", request: "widget" },
    { shape: "named bundled entry", file: "dist/widget.js", request: "widget" },
  ])("keeps $shape leaf aliases distinct from the package alias", async ({ file, request }) => {
    const paths = packageFixture("checkout", "@scope/pi-fixture", [file, "extensions/sibling/index.ts"]);
    const manager = settings({ packages: [join(root, "checkout")] });
    const leaf = await select(manager, [request]);
    const whole = await select(manager, ["pi-fixture"]);
    expect(leaf.diagnostics).toEqual([]);
    expect(whole.diagnostics).toEqual([]);
    expect(leaf.selection.additionalExtensionPaths).toEqual([paths[0]]);
    expect(whole.selection.additionalExtensionPaths.sort()).toEqual([...paths].sort());
    expect(await load(manager, leaf.selection)).toEqual([paths[0]]);
    expect(executed()).toEqual(["entry-0"]);
    rmSync(factoryLog);
    expect(await load(manager, whole.selection)).toEqual([...paths].sort());
    expect(executed()).toEqual(["entry-0", "entry-1"]);
  });

  // Both original no-manifest tests become real direct-file/directory fixtures.
  it.each([
    { shape: "directory index", file: "extensions/tavily/index.ts" },
    { shape: "named file", file: "extensions/tavily.ts" },
  ])("selects a package-free $shape by its path-derived alias", async ({ file }) => {
    const selectedPath = entry(join(agentDir, file), "tavily");
    entry(join(agentDir, "extensions/other/index.ts"), "other");
    const manager = settings();
    const { selection, diagnostics } = await select(manager, ["tavily"]);
    expect(diagnostics).toEqual([]);
    expect(selection.additionalExtensionPaths).toEqual([selectedPath]);
    expect(await load(manager, selection)).toEqual([selectedPath]);
    expect(executed()).toEqual(["tavily"]);
  });

  it("excludes a renamed package before its hook-only factory executes", async () => {
    packageFixture("renamed-checkout", "pi-fixture", ["src/index.ts"]);
    const unrelated = entry(join(agentDir, "extensions/tavily/index.ts"), "tavily");
    const manager = settings({ packages: [join(root, "renamed-checkout")] });
    const { selection, diagnostics } = await select(manager, true, ["pi-fixture"]);
    expect(diagnostics).toEqual([]);
    expect(selection.additionalExtensionPaths).toEqual([unrelated]);
    expect(await load(manager, selection)).toEqual([unrelated]);
    expect(executed()).toEqual(["tavily"]);
  });

  it.each([
    { mode: "whitelist", extensions: ["nonexistent"], excludes: undefined, admitted: false },
    { mode: "exclusion", extensions: true, excludes: ["nonexistent"], admitted: true },
  ])("diagnoses an unmatched $mode before any factory runs", async ({ extensions, excludes, admitted }) => {
    const availablePath = entry(join(agentDir, "extensions/available.ts"), "available");
    const manager = settings();
    const { selection, diagnostics } = await select(manager, extensions, excludes);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("nonexistent");
    expect(diagnostics[0].factories).toEqual([]);
    expect(selection.additionalExtensionPaths).toEqual(admitted ? [availablePath] : []);
    expect(await load(manager, selection)).toEqual(admitted ? [availablePath] : []);
    expect(executed()).toEqual(admitted ? ["available"] : []);
  });

  it("falls back to a path alias with a malformed manifest and diagnoses the unavailable package alias", async () => {
    const packageRoot = join(root, "broken-package");
    const selectedPath = entry(join(packageRoot, "extensions/my-extension/index.ts"), "fallback");
    writeFileSync(join(packageRoot, "package.json"), "not valid json {{{");
    const manager = settings({ extensions: [...disabledNative, selectedPath] });
    const { selection, diagnostics } = await select(manager, ["my-extension", "pi-fixture"]);
    expect(selection.additionalExtensionPaths).toEqual([selectedPath]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("pi-fixture");
    expect(diagnostics[0].factories).toEqual([]);
    expect(await load(manager, selection)).toEqual([selectedPath]);
    expect(executed()).toEqual(["fallback"]);
  });

  // The old undefined override assertions now check the visible result: empty
  // Pi settings inherit natives, not third parties; explicit opt-outs load none.
  it.each([
    { mode: "inherit with empty Pi settings", extensions: true, piExtensions: [], expected: nativePaths },
    { mode: "inherit with natives disabled by Pi", extensions: true, piExtensions: disabledNative, expected: [] },
    { mode: "explicit false", extensions: false, piExtensions: [], expected: [] },
    { mode: "explicit empty selection", extensions: [], piExtensions: [], expected: [] },
  ])("loads the intended capabilities for $mode", async ({ extensions, piExtensions, expected }) => {
    const manager = settings({ extensions: piExtensions });
    const { selection, diagnostics } = await select(manager, extensions);
    expect(diagnostics).toEqual([]);
    expect(selection.additionalExtensionPaths.sort()).toEqual(expected);
    expect(selection.extensionFactories).toHaveLength(expected.length);
    expect(await load(manager, selection)).toEqual(expected);
    expect(executed()).toEqual([]);
  });
});
