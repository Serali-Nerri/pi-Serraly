import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

import { runtimeFixture } from "./helpers/runtime-package.ts";

const execFileAsync = promisify(execFile);
const fixturePath = fileURLToPath(new URL("./fixtures/minimal.pdf", import.meta.url));
const smokeHelperPath = fileURLToPath(
  new URL("./helpers/packed-worker-smoke.mjs", import.meta.url),
);

async function discover(runtimeRoot: string) {
  const cwd = join(runtimeRoot, "empty-cwd");
  const agentDir = join(runtimeRoot, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noContextFiles: true,
    settingsManager: SettingsManager.inMemory({
      packages: [
        {
          source: runtimeRoot,
          extensions: ["dist/pi-docparser/index.js"],
        },
      ],
    }),
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.deepEqual(loader.getSkills().skills, []);
  assert.equal(loader.getExtensions().extensions.length, 1);
  return { extension: loader.getExtensions().extensions[0], cwd };
}

// Catches incorrect dist-relative worker placement, missing .mjs closure and
// accidental reliance on a source-tree node_modules link. No npm/network install.
test(
  "runtime package executes plain-JavaScript parse, search and screenshot workers outside the dependency tree",
  { timeout: 60_000 },
  async (t) => {
    const runtimeRoot = await runtimeFixture(t);
    await Promise.all([
      copyFile(fixturePath, join(runtimeRoot, "minimal.pdf")),
      copyFile(smokeHelperPath, join(runtimeRoot, "packed-worker-smoke.mjs")),
    ]);
    await execFileAsync(process.execPath, [join(runtimeRoot, "packed-worker-smoke.mjs")], {
      cwd: runtimeRoot,
      timeout: 45_000,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    assert.equal(
      JSON.parse(await readFile(join(runtimeRoot, "parsed.json"), "utf8")).text,
      "Hello Pi",
    );
  },
);

test(
  "Pi host loader runs the compiled factory and all three frozen tool contracts",
  { timeout: 60_000 },
  async (t) => {
    const runtimeRoot = await runtimeFixture(t);
    const { extension, cwd } = await discover(runtimeRoot);
    t.after(async () => {
      for (const handler of extension.handlers.get("session_shutdown") ?? []) {
        await handler({ type: "session_shutdown" }, {} as never);
      }
    });
    await copyFile(fixturePath, join(cwd, "minimal.pdf"));
    assert.deepEqual([...extension.tools.keys()].sort(), [
      "document_parse",
      "document_screenshot",
      "document_search",
    ]);
    assert.deepEqual([...extension.commands.keys()], ["docparser:doctor"]);
    for (const { definition } of extension.tools.values()) {
      assert.equal(definition.exposure, "deferred");
      assert.equal(definition.promptSnippet, undefined);
      assert.equal(definition.promptGuidelines, undefined);
    }
    const context = { cwd } as never;
    const parsed = await extension.tools.get("document_parse")!.definition.execute(
      "parse",
      {
        path: "minimal.pdf",
        format: "json",
        targetPages: "1",
        ocr: "off",
        numWorkers: 1,
        maxPages: 1,
        dpi: 72,
      },
      undefined,
      undefined,
      context,
    );
    const parseDetails = parsed.details as {
      outputPath: string;
      outputDir: string;
      pageCount: number;
    };
    t.after(() => rm(parseDetails.outputDir, { recursive: true, force: true }));
    assert.equal(parseDetails.pageCount, 1);
    assert.equal(JSON.parse(await readFile(parseDetails.outputPath, "utf8")).text, "Hello Pi");
    const searched = await extension.tools.get("document_search")!.definition.execute(
      "search",
      {
        path: "minimal.pdf",
        phrase: "Hello",
        targetPages: "1",
        ocr: "off",
        numWorkers: 1,
        maxPages: 1,
        dpi: 72,
      },
      undefined,
      undefined,
      context,
    );
    const searchDetails = searched.details as {
      hits: Array<{ text: string; pageNum: number }>;
      truncatedByCount: boolean;
    };
    assert.equal(searchDetails.hits.length, 1);
    assert.equal(searchDetails.hits[0].text, "Hello");
    assert.equal(searchDetails.hits[0].pageNum, 1);
    assert.equal(searchDetails.truncatedByCount, false);
    const screenshotted = await extension.tools.get("document_screenshot")!.definition.execute(
      "screenshot",
      {
        path: "minimal.pdf",
        pages: "1",
        dpi: 72,
      },
      undefined,
      undefined,
      context,
    );
    const screenshotDetails = screenshotted.details as {
      outputDir: string;
      screenshots: Array<{ outputPath: string }>;
    };
    t.after(() => rm(screenshotDetails.outputDir, { recursive: true, force: true }));
    assert.equal(screenshotted.content.filter((item) => item.type === "image").length, 1);
    assert.deepEqual(
      (await readFile(screenshotDetails.screenshots[0].outputPath)).subarray(0, 8),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
  },
);

for (const missing of ["native-worker.mjs", "native-protocol.mjs", "parse-output.mjs"]) {
  test(
    `runtime package diagnoses a missing ${missing} without crashing the Pi host`,
    { timeout: 30_000 },
    async (t) => {
      const runtimeRoot = await runtimeFixture(t);
      const { extension, cwd } = await discover(runtimeRoot);
      t.after(async () => {
        for (const handler of extension.handlers.get("session_shutdown") ?? []) {
          await handler({ type: "session_shutdown" }, {} as never);
        }
      });
      await copyFile(fixturePath, join(cwd, "minimal.pdf"));
      await rm(join(runtimeRoot, "dist", "pi-docparser", missing));
      await assert.rejects(
        extension.tools.get("document_parse")!.definition.execute(
          "missing",
          {
            path: "minimal.pdf",
            ocr: "off",
            numWorkers: 1,
            maxPages: 1,
            dpi: 72,
          },
          undefined,
          undefined,
          { cwd } as never,
        ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /worker crashed|protocol error/i);
          assert.ok(error.message.includes(missing), error.message);
          return true;
        },
      );
    },
  );
}
