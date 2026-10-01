import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { testEnvironment } from "./test-environment.mjs";

const root = resolve(import.meta.dirname, "..");
async function tests(dir) {
  const paths = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) paths.push(...await tests(path));
    else if (entry.name.endsWith(".test.ts")) paths.push(path);
  }
  return paths.sort();
}
const base = await mkdtemp(join(tmpdir(), "pi-ui-tests-"));
try {
  const env = testEnvironment(base, { PI_UI_HOST_PACKAGE: process.env.PI_UI_HOST_PACKAGE });
  await Promise.all([env.HOME, env.PI_CODING_AGENT_DIR, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME]
    .map((path) => mkdir(path, { recursive: true })));
  const child = spawn(process.execPath, ["--import", "tsx", "--test", ...await tests(join(root, "modules/ui/test"))],
    { cwd: join(root, "modules/ui"), env, stdio: "inherit" });
  const status = await new Promise((done, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => done(code ?? (signal ? 1 : 0)));
  });
  process.exitCode = status;
} finally {
  await rm(base, { recursive: true, force: true });
}
