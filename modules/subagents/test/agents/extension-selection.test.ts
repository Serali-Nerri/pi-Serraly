import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { buildExtToolMap, resolveChildExtensions } from "../../src/agents/extension-selection.js";
import { resolveSessionToolSelection } from "../../src/agents/agent-types.js";

// These fixtures write factory side effects, not mock invocations: importing or
// executing an unselected package entry must not happen during discovery.
describe("child extension selection before factory execution", () => {
  let root: string;
  let cwd: string;
  let agentDir: string;
  let packageDir: string;
  let log: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "child-extensions-"));
    cwd = path.join(root, "project");
    agentDir = path.join(root, "agent");
    packageDir = path.join(root, "package");
    log = path.join(root, "factory.log");
    await Promise.all([fs.mkdir(cwd), fs.mkdir(agentDir), fs.mkdir(packageDir)]);
    const entries = ["pi-ui", "pi-tools", "pi-questions", "pi-subagents", "subagents-lite"];
    for (const name of entries) {
      const file = path.join(packageDir, "dist", name, "index.js");
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `import fs from "node:fs";
export default function(pi) {
  fs.appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name + "\n")});
  pi.registerCommand(${JSON.stringify(name)}, { handler: async () => {} });
  pi.registerTool({ name: ${JSON.stringify("tool_" + name.replaceAll("-", "_"))}, label: "fixture", description: "fixture",
    parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: undefined }) });
}
`);
    }
    await fs.writeFile(path.join(packageDir, "package.json"), JSON.stringify({
      name: "@example/pi-serraly", type: "module",
      pi: { extensions: entries.map((name) => `./dist/${name}/index.js`) },
    }));
    await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [packageDir] }));
  });

  afterEach(async () => fs.rm(root, { recursive: true, force: true }));

  async function executed(): Promise<string[]> {
    try { return (await fs.readFile(log, "utf8")).trim().split("\n").filter(Boolean).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }

  async function load(extensions: true | string[] | false, options: { excludeExtensions?: string[]; projectTrusted?: boolean } = {}) {
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: options.projectTrusted ?? true });
    const selection = await resolveChildExtensions({
      cwd, agentDir, settingsManager, extensions, excludeExtensions: options.excludeExtensions,
    });
    expect(await executed()).toEqual([]);
    const loader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager,
      noExtensions: true,
      extensionFactories: selection.extensionFactories,
      additionalExtensionPaths: selection.additionalExtensionPaths,
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    return loader.getExtensions().extensions;
  }

  it.each([{ selection: false }, { selection: [] }])("selection $selection executes zero factories", async ({ selection }) => {
    await load(selection as false | string[]);
    expect(await executed()).toEqual([]);
  });

  it("selecting pi-tools never executes sibling factories in the same package", async () => {
    await load(["pi-tools"]);
    expect(await executed()).toEqual(["pi-tools"]);
  });

  it("package alias selects its leaves but never either subagents entry", async () => {
    await load(["pi-serraly"]);
    expect(await executed()).toEqual(["pi-questions", "pi-tools", "pi-ui"]);
  });

  it("an absolute path selects only that discovered entry", async () => {
    await load([path.join(packageDir, "dist/pi-tools/index.js")]);
    expect(await executed()).toEqual(["pi-tools"]);
  });

  it("direct file settings still recognize the declaring package alias", async () => {
    await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
      extensions: [path.join(packageDir, "dist/pi-tools/index.js"), path.join(packageDir, "dist/pi-ui/index.js")],
    }));
    await load(["pi-serraly"]);
    expect(await executed()).toEqual(["pi-tools", "pi-ui"]);
  });

  it("a renamed symlink cannot admit the subagents entry", async () => {
    await fs.mkdir(path.join(agentDir, "extensions"));
    await fs.symlink(path.join(packageDir, "dist/pi-subagents/index.js"), path.join(agentDir, "extensions/innocent.js"));
    await load(["innocent"]);
    expect(await executed()).toEqual([]);
  });

  it("inherit mode honors excludes and always excludes subagents", async () => {
    await load(true, { excludeExtensions: ["pi-ui"] });
    expect(await executed()).toEqual(["pi-questions", "pi-tools"]);
  });

  it("whitelist wins extension excludes", async () => {
    await load(["pi-tools"], { excludeExtensions: ["pi-tools"] });
    expect(await executed()).toEqual(["pi-tools"]);
  });

  it("native descriptors load canonically while Pi disables win over explicit selection", async () => {
    await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ extensions: ["-builtin:mcp"] }));
    const loaded = await load(["builtin:codemode", "builtin:tool-search", "builtin:mcp"]);
    expect(loaded.map((ext) => ext.path).sort()).toEqual(["builtin:codemode", "builtin:tool-search"]);
    expect(loaded.flatMap((ext) => [...ext.tools.keys()]).sort()).toEqual(["codemode", "tool_search"]);
  });

  it("aggregate static ext selectors keep tools from every selected package leaf", async () => {
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const selection = await resolveChildExtensions({ cwd, agentDir, settingsManager, extensions: ["pi-serraly"] });
    const loaded = await load(["pi-serraly"]);
    const extToolMap = buildExtToolMap(loaded, selection.aliasesByPath);
    expect(resolveSessionToolSelection({ tools: ["pi-serraly/*"], extToolMap }).tools?.sort())
      .toEqual(["tool_pi_questions", "tool_pi_tools", "tool_pi_ui"]);
    expect(resolveSessionToolSelection({ tools: ["pi-tools/*"], extToolMap }).tools).toEqual(["tool_pi_tools"]);
  });

  it("selected third-party replacements use Pi's native replaceable mechanism", async () => {
    const replacement = path.join(agentDir, "extensions/replacement.js");
    await fs.mkdir(path.dirname(replacement), { recursive: true });
    await fs.writeFile(replacement, `export default function(pi) {
      pi.registerCommand("mcp", { handler: async () => {} });
    }`);
    const loaded = await load(["builtin:mcp", "replacement"]);
    expect(loaded.map((extension) => extension.path)).toEqual([replacement]);
    expect(loaded[0].commands.has("mcp")).toBe(true);
  });

  it("unknown native requests diagnose canonical names without loading other factories", async () => {
    const messages: string[] = [];
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const selection = await resolveChildExtensions({
      cwd, agentDir, settingsManager, extensions: ["builtin:tool_search", "missing"], notify: (message) => messages.push(message),
    });
    expect(selection.additionalExtensionPaths).toEqual([]);
    expect(messages.join("\n")).toContain("builtin:tool-search");
    expect(messages.join("\n")).toContain("missing");
    expect(await executed()).toEqual([]);
  });

  it("an untrusted target cannot execute project candidates even when selected", async () => {
    await fs.mkdir(path.join(cwd, ".pi"));
    await fs.writeFile(path.join(cwd, ".pi/settings.json"), JSON.stringify({ packages: [packageDir] }));
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}");
    await load(["pi-tools"], { projectTrusted: false });
    expect(await executed()).toEqual([]);
  });
});
