import fs from "node:fs/promises";
import path from "node:path";
import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultPackageManager,
  type InlineExtension,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";

export const NATIVE_EXTENSION_NAMES = ["codemode", "tool-search", "mcp"] as const;
export type NativeExtensionName = (typeof NATIVE_EXTENSION_NAMES)[number];

/** Fresh session-scoped factories; Pi owns replacement and inactive defaults. */
export function createNativeExtensionEntry(name: NativeExtensionName): InlineExtension {
  const factories = {
    codemode: createCodemodeExtension,
    "tool-search": createToolSearchExtension,
    mcp: createMcpExtension,
  };
  return { name, builtin: true, replaceable: true, factory: factories[name]() };
}

export interface ChildExtensionSelection {
  extensionFactories: InlineExtension[];
  additionalExtensionPaths: string[];
  aliasesByPath: Map<string, readonly string[]>;
}

/** Leaf identity, separate from its aggregate package's identity. */
export function extractExtensionName(extPath: string): string {
  if (extPath.startsWith("builtin:")) return extPath.slice("builtin:".length);
  const parts = extPath.split(path.sep);
  const extensionDir = parts.lastIndexOf("extensions");
  if (extensionDir !== -1 && extensionDir + 1 < parts.length) {
    return path.parse(parts[extensionDir + 1]).name;
  }
  const file = path.parse(extPath).name;
  if (file !== "index") return file;
  const parent = path.basename(path.dirname(extPath));
  if (["src", "dist", "lib"].includes(parent)) {
    const owner = path.basename(path.dirname(path.dirname(extPath)));
    return extPath.includes(`${path.sep}modules${path.sep}`) ? `pi-${owner}` : owner;
  }
  return parent;
}

function shortName(name: string): string {
  return (name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name).toLowerCase();
}

interface ExtensionManifest {
  name?: unknown;
  pi?: { extensions?: unknown };
}

async function readManifest(directory: string): Promise<ExtensionManifest | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
}

async function packageName(packageRoot: string): Promise<string | undefined> {
  const manifest = await readManifest(packageRoot);
  return typeof manifest?.name === "string" ? manifest.name : undefined;
}

/** Preserve the legacy declared-entry alias for explicit file settings. */
async function declaringPackageName(entry: string): Promise<string | undefined> {
  let directory = path.dirname(entry);
  while (path.basename(directory) !== "node_modules") {
    const manifest = await readManifest(directory);
    if (manifest) {
      const entries = manifest.pi?.extensions;
      // Identity only: Pi already did discovery and filtering. Do not reparse
      // package patterns or attribute a loose file to a co-located project.
      return typeof manifest.name === "string" && Array.isArray(entries)
        && entries.some((item) => typeof item === "string" && path.resolve(directory, item) === entry)
        ? manifest.name : undefined;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

const SELF_NAMES = new Set(["subagents", "pi-subagents", "subagents-lite", "pi-subagents-lite"]);

function isSubagentsEntry(extPath: string, aliases: readonly string[]): boolean {
  if (aliases.some((alias) => SELF_NAMES.has(alias))) return true;
  return extPath.split(path.sep).some((part) => SELF_NAMES.has(part.toLowerCase()));
}

function matches(entry: string, extPath: string, aliases: readonly string[]): boolean {
  // Paths are exact and case-sensitive. Never reinterpret an absolute path as
  // the legacy ext/tool syntax, or install an npm/git source from an agent list.
  if (entry === extPath) return true;
  if (path.isAbsolute(entry)) return false;
  const name = entry.toLowerCase();
  if (aliases.includes(name)) return true;
  if (entry.startsWith("builtin:")) return false;
  const slash = name.indexOf("/");
  return slash !== -1 && aliases.includes(name.slice(0, slash));
}

/**
 * Discover using Pi's enabled/trust/package filters, without importing any
 * candidate. The consumer MUST use noExtensions:true with these selected
 * additional paths, so the loader cannot rediscover and execute other entries.
 */
export async function resolveChildExtensions(options: {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
  extensions: true | string[] | false;
  excludeExtensions?: readonly string[];
  notify?: (message: string) => void;
}): Promise<ChildExtensionSelection> {
  const selection: ChildExtensionSelection = {
    extensionFactories: [], additionalExtensionPaths: [], aliasesByPath: new Map(),
  };
  if (options.extensions === false || (Array.isArray(options.extensions) && options.extensions.length === 0)) {
    return selection;
  }

  const manager = new DefaultPackageManager({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager: options.settingsManager,
    builtinExtensions: [...NATIVE_EXTENSION_NAMES],
  });
  // Child discovery never installs missing sources as a side effect.
  const resolved = await manager.resolve(async (source) => {
    options.notify?.(`extension package "${source}" is not installed; skipping child capability`);
    return "skip";
  });
  const requests = Array.isArray(options.extensions) ? options.extensions : options.excludeExtensions ?? [];
  const matched = new Set<string>();
  const packageNames = new Map<string, string | undefined>();

  for (const resource of resolved.extensions) {
    if (!resource.enabled) continue;
    const builtin = resource.path.startsWith("builtin:");
    const canonicalPath = builtin ? resource.path : await fs.realpath(resource.path).catch(() => resource.path);
    const root = resource.metadata.packageRoot;
    if (root && !packageNames.has(root)) packageNames.set(root, await packageName(root));
    const owner = root ? packageNames.get(root) : builtin ? undefined : await declaringPackageName(canonicalPath);
    const aliases = new Set([resource.path, extractExtensionName(resource.path).toLowerCase()]);
    if (owner) {
      aliases.add(owner.toLowerCase());
      aliases.add(shortName(owner));
    }
    const names = [...aliases];
    if (isSubagentsEntry(resource.path, names) || isSubagentsEntry(canonicalPath, [extractExtensionName(canonicalPath).toLowerCase()])) continue;
    const hits = requests.filter((request) => matches(request, resource.path, names));
    for (const hit of hits) matched.add(hit);
    const selected = Array.isArray(options.extensions) ? hits.length > 0 : hits.length === 0;
    if (!selected) continue;

    selection.additionalExtensionPaths.push(resource.path);
    selection.aliasesByPath.set(resource.path, names);
    selection.aliasesByPath.set(canonicalPath, names);
    if (builtin) {
      const name = resource.path.slice("builtin:".length) as NativeExtensionName;
      selection.extensionFactories.push(createNativeExtensionEntry(name));
    }
  }

  for (const request of requests) {
    if (matched.has(request)) continue;
    const builtinHint = request.startsWith("builtin:")
      ? `; canonical native names are ${NATIVE_EXTENSION_NAMES.map((name) => `builtin:${name}`).join(", ")}`
      : "";
    options.notify?.(`extension "${request}" is not an enabled child capability${builtinHint}`);
  }
  return selection;
}

/** Static ext/* aliases aggregate tools across all leaves of the same package. */
export function buildExtToolMap(
  extensions: readonly { path: string; tools: ReadonlyMap<string, unknown> }[],
  aliasesByPath: ReadonlyMap<string, readonly string[]>,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const extension of extensions) {
    const aliases = aliasesByPath.get(extension.path) ?? [extractExtensionName(extension.path)];
    for (const alias of aliases) {
      const tools = new Set(map.get(alias));
      for (const tool of extension.tools.keys()) tools.add(tool);
      if (tools.size > 0) map.set(alias, [...tools]);
    }
  }
  return map;
}
