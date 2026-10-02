import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

export const moduleRoot = fileURLToPath(new URL("../..", import.meta.url));
export const workerFiles = ["native-worker.mjs", "native-protocol.mjs", "parse-output.mjs"];

// Tests stage a physical, offline dependency closure outside the workspace. Actual
// release installation/locking belongs to root tests. No symlinks or host copies.
async function copyRuntimeDependencies(runtimeRoot: string): Promise<void> {
  const copied = new Set<string>();
  async function copyPackage(name: string, from: string, optional = false): Promise<void> {
    if (copied.has(name)) return;
    let metadataPath: string;
    try {
      const require = createRequire(join(from, "package.json"));
      try {
        metadataPath = require.resolve(`${name}/package.json`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
        let directory = dirname(require.resolve(name));
        while (true) {
          const candidate = join(directory, "package.json");
          try {
            const metadata = JSON.parse(await readFile(candidate, "utf8"));
            if (metadata.name === name) {
              metadataPath = candidate;
              break;
            }
          } catch (readError) {
            if ((readError as NodeJS.ErrnoException).code !== "ENOENT") throw readError;
          }
          const parent = dirname(directory);
          if (parent === directory) throw new Error(`Cannot locate metadata for ${name}`);
          directory = parent;
        }
      }
    } catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") return;
      throw error;
    }
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    assert.equal(name.startsWith("@earendil-works/"), false, "runtime must not copy host packages");
    if (name.startsWith("@llamaindex/")) assert.equal(metadata.version, "2.10.1");
    copied.add(name);
    await cp(dirname(metadataPath), join(runtimeRoot, "node_modules", name), {
      recursive: true,
      dereference: true,
    });
    for (const dependency of Object.keys(metadata.dependencies ?? {})) {
      await copyPackage(dependency, dirname(metadataPath));
    }
    for (const dependency of Object.keys(metadata.optionalDependencies ?? {})) {
      await copyPackage(dependency, dirname(metadataPath), true);
    }
  }
  await copyPackage("@llamaindex/liteparse", moduleRoot);
}

export async function runtimeFixture(t: TestContext): Promise<string> {
  const sandbox = await mkdtemp(join(tmpdir(), "docparser-runtime-package-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const runtimeRoot = join(sandbox, "runtime");
  await mkdir(runtimeRoot);
  if (process.env.PI_DOCPARSER_RUNTIME_ROOT) {
    await cp(process.env.PI_DOCPARSER_RUNTIME_ROOT, runtimeRoot, {
      recursive: true,
      dereference: true,
    });
  } else {
    const source = join(moduleRoot, "extensions", "docparser");
    const target = join(runtimeRoot, "dist", "pi-docparser");
    await mkdir(target, { recursive: true });
    // This is a test fixture, not a second release builder. The root build can be
    // validated without rebuilding by passing PI_DOCPARSER_RUNTIME_ROOT.
    const output = await build({
      entryPoints: [join(source, "index.ts")],
      outfile: join(target, "index.js"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      external: ["@earendil-works/*", "typebox", "@llamaindex/liteparse"],
      metafile: true,
      legalComments: "eof",
    });
    const externals = Object.values(output.metafile.outputs).flatMap((file) => file.imports);
    assert.ok(externals.some((entry) => entry.path === "@earendil-works/pi-ai" && entry.external));
    assert.ok(
      externals.some((entry) => entry.path === "@earendil-works/pi-coding-agent" && entry.external),
    );
    assert.equal(
      Object.keys(output.metafile.inputs).some((path) => path.includes("node_modules/")),
      false,
      "the factory must not contain physical Pi or native library code",
    );
    for (const file of workerFiles) await cp(join(source, file), join(target, file));
    await cp(join(moduleRoot, "LICENSE"), join(target, "LICENSE"));
    await cp(join(moduleRoot, "licenses"), join(target, "licenses"), { recursive: true });
    await cp(join(moduleRoot, "THIRD_PARTY_NOTICES.md"), join(target, "THIRD_PARTY_NOTICES.md"));
    await writeFile(
      join(runtimeRoot, "package.json"),
      JSON.stringify({
        name: "pi-serraly-docparser-runtime-fixture",
        private: true,
        type: "module",
        dependencies: { "@llamaindex/liteparse": "2.10.1" },
        peerDependencies: { "@earendil-works/pi-ai": "*", "@earendil-works/pi-coding-agent": "*" },
        pi: { extensions: ["./dist/pi-docparser/index.js"] },
      }),
    );
    await copyRuntimeDependencies(runtimeRoot);
  }
  const metadata = JSON.parse(await readFile(join(runtimeRoot, "package.json"), "utf8"));
  assert.equal(metadata.private, true);
  assert.equal(metadata.dependencies["@llamaindex/liteparse"], "2.10.1");
  const resources = Object.keys(metadata.pi);
  assert.deepEqual(resources, ["extensions"], "runtime must not activate companion resources");
  for (const file of ["index.js", ...workerFiles]) {
    assert.ok((await stat(join(runtimeRoot, "dist", "pi-docparser", file))).isFile());
  }
  await assert.rejects(stat(join(runtimeRoot, "node_modules", "@earendil-works")), {
    code: "ENOENT",
  });
  await assert.rejects(stat(join(runtimeRoot, "node_modules", "typebox")), { code: "ENOENT" });
  return runtimeRoot;
}
