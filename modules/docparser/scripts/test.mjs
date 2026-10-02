import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleRoot = fileURLToPath(new URL("..", import.meta.url));
const all = (await readdir(join(moduleRoot, "tests")))
  .filter((name) => name.endsWith(".test.ts"))
  .sort();
const native = ["native-executor.test.ts", "native-worker.integration.test.ts"];
const packaging = ["package-content.test.ts", "package-metadata.test.ts", "packed-install.test.ts"];
const groups = {
  all,
  native,
  package: packaging,
  unit: all.filter((name) => !native.includes(name) && !packaging.includes(name)),
};
const group = process.argv[2] ?? "all";
if (group !== "runtime" && !(group in groups)) throw new Error(`Unknown test group: ${group}`);
const base = await mkdtemp(join(tmpdir(), "pi-serraly-docparser-tests-"));
try {
  const environment = {
    PATH: process.env.PATH,
    HOME: join(base, "home"),
    USERPROFILE: join(base, "home"),
    PI_CODING_AGENT_DIR: join(base, "agent"),
    XDG_CONFIG_HOME: join(base, "config"),
    XDG_CACHE_HOME: join(base, "cache"),
    TMPDIR: join(base, "tmp"),
    TEMP: join(base, "tmp"),
    TMP: join(base, "tmp"),
    npm_config_cache: join(base, "npm-cache"),
    npm_config_update_notifier: "false",
    npm_config_userconfig: join(base, "empty-npmrc"),
  };
  for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  if (process.env.PI_DOCPARSER_RUNTIME_ROOT) {
    environment.PI_DOCPARSER_RUNTIME_ROOT = resolve(process.env.PI_DOCPARSER_RUNTIME_ROOT);
  }
  const cwd = join(base, "cwd");
  await Promise.all(
    ["home", "agent", "config", "cache", "tmp", "cwd", "npm-cache"].map((directory) =>
      mkdir(join(base, directory)),
    ),
  );
  const args = ["--import", import.meta.resolve("tsx")];
  if (group === "runtime") {
    args.push(
      "--input-type=module",
      "-e",
      `const {default: factory} = await import(${JSON.stringify(new URL("../extensions/docparser/index.ts", import.meta.url).href)}); if (typeof factory !== "function") throw new Error("Missing docparser factory");`,
    );
  } else {
    args.push(
      "--test",
      "--test-concurrency=1",
      ...groups[group].map((name) => join(moduleRoot, "tests", name)),
    );
  }
  const child = spawn(process.execPath, args, { cwd, env: environment, stdio: "inherit" });
  process.exitCode = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => done(code ?? 1));
  });
} finally {
  await rm(base, { recursive: true, force: true });
}
