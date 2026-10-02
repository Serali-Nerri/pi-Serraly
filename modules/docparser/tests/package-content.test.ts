import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import { moduleRoot } from "./helpers/runtime-package.ts";

const execFileAsync = promisify(execFile);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

test("workspace source archive retains worker, license, provenance and inactive skill sources", async () => {
  const { stdout } = await execFileAsync(
    npmCommand,
    ["pack", "--json", "--dry-run", "--ignore-scripts", "--offline"],
    {
      cwd: moduleRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      shell: process.platform === "win32",
    },
  );
  const results = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
  assert.equal(results.length, 1);
  const paths = results[0].files.map(({ path }) => path);
  for (const path of [
    "LICENSE",
    "README.md",
    "UPSTREAM.md",
    "VALIDATION.md",
    "THIRD_PARTY_NOTICES.md",
    "extensions/docparser/index.ts",
    "extensions/docparser/native-protocol.mjs",
    "extensions/docparser/native-worker.mjs",
    "extensions/docparser/parse-output.mjs",
    "licenses/LiteParse-APACHE-2.0.txt",
    "skills/parse-document/SKILL.md",
  ])
    assert.ok(paths.includes(path), `workspace source archive is missing ${path}`);
  assert.equal(new Set(paths).size, paths.length);
  for (const path of paths) {
    assert.equal(
      /^(tests|node_modules|dist|\.pi|\.plans|\.reviews|scripts)\//.test(path),
      false,
      path,
    );
    assert.equal(/(lock\.(yaml|json)|deploy\.mjs|undeploy\.mjs)$/.test(path), false, path);
  }
});
