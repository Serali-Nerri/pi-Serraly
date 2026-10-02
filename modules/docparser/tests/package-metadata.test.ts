import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const moduleRoot = fileURLToPath(new URL("..", import.meta.url));

test("workspace discovery registers the document tools without enabling the companion skill", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "docparser-workspace-discovery-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const cwd = join(sandbox, "cwd");
  const agentDir = join(sandbox, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory({ packages: [moduleRoot] }),
    noContextFiles: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getSkills().skills, [], "companion skill is source-only, not activated");
  const { extensions, errors } = loader.getExtensions();
  assert.deepEqual(errors, []);
  assert.equal(extensions.length, 1);
  const extension = extensions[0];
  assert.deepEqual([...extension.tools.keys()].sort(), [
    "document_parse",
    "document_screenshot",
    "document_search",
  ]);
  assert.deepEqual([...extension.commands.keys()], ["docparser:doctor"]);
  for (const tool of extension.tools.values()) {
    assert.equal(tool.definition.exposure, "deferred");
    assert.equal(tool.definition.promptSnippet, undefined);
    assert.equal(tool.definition.promptGuidelines, undefined);
  }
  for (const handler of extension.handlers.get("session_shutdown") ?? []) {
    await handler({ type: "session_shutdown" }, {} as never);
  }
});

test("workspace resolves the root Pi host and TypeScript instead of shadowing them with local copies", async () => {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  for (const dependency of [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-ai",
    "typescript",
  ]) {
    const packageRoot = join(root, "node_modules", dependency);
    const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    assert.equal(
      fileURLToPath(import.meta.resolve(dependency)),
      join(packageRoot, metadata.main),
      `${dependency} must resolve from the root development tree`,
    );
  }
});

test("workspace manifest does not create a competing host or runtime dependency tree", async () => {
  const metadata = JSON.parse(await readFile(join(moduleRoot, "package.json"), "utf8"));
  assert.equal(metadata.private, true, "workspace must not be publishable");
  assert.equal(metadata.engines.node, ">=22.19.0");
  assert.deepEqual(metadata.peerDependencies, {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
  });
  assert.deepEqual(metadata.dependencies ?? {}, {}, "root owns LiteParse runtime installation");
  assert.deepEqual(metadata.devDependencies ?? {}, {}, "root owns development dependencies");
});
