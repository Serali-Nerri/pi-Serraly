#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, globSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2).flatMap((arg) => {
	if (arg.includes("*") && arg.endsWith(".ts")) {
		const matches = globSync(arg, { cwd: packageRoot }).sort();
		if (matches.length === 0) throw new Error(`No test files match ${arg}`);
		return matches.map((path) => resolve(packageRoot, path));
	}
	if (!isAbsolute(arg) && arg.endsWith(".ts") && existsSync(resolve(packageRoot, arg))) {
		return [resolve(packageRoot, arg)];
	}
	return [arg];
});
if (args.length === 0) throw new Error("Expected test or fixture arguments");
const scratch = await mkdtemp(join(tmpdir(), "pi-bg-tests-"));
try {
	const home = join(scratch, "home"), agent = join(scratch, "agent");
	const config = join(scratch, "config"), cache = join(scratch, "cache");
	const cwd = join(scratch, "project"), temp = join(scratch, "tmp");
	await Promise.all([home, agent, config, cache, cwd, temp].map((path) => mkdir(path)));
	const userConfig = join(config, "user.npmrc"), globalConfig = join(config, "global.npmrc");
	await Promise.all([userConfig, globalConfig].map((path) => writeFile(path, "")));
	const env = {};
	// Keep only launch/terminal/platform inputs, never ambient credentials or
	// shell/Node startup hooks. SDK fixtures add only local scripted providers.
	for (const key of ["PATH", "SHELL", "TERM", "COLORTERM", "LANG", "LC_ALL", "TZ", "SystemRoot", "WINDIR", "ComSpec", "PI_BG_TEST_BASH", "npm_execpath"]) {
		if (process.env[key] !== undefined) env[key] = process.env[key];
	}
	Object.assign(env, {
		HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent,
		PI_CODING_AGENT_SESSION_DIR: join(agent, "sessions"),
		XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache,
		TMPDIR: temp, TMP: temp, TEMP: temp,
		NPM_CONFIG_USERCONFIG: userConfig, npm_config_userconfig: userConfig,
		NPM_CONFIG_GLOBALCONFIG: globalConfig, npm_config_globalconfig: globalConfig,
		NPM_CONFIG_CACHE: cache, npm_config_cache: cache,
		NPM_CONFIG_REGISTRY: "http://127.0.0.1.invalid/", npm_config_registry: "http://127.0.0.1.invalid/",
		PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", CI: "1", GIT_ALLOW_PROTOCOL: "file",
	});
	const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), ...args], {
		cwd, env, stdio: "inherit",
	});
	process.exitCode = await new Promise((done, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => done(code ?? (signal ? 1 : 0)));
	});
} finally {
	await rm(scratch, { recursive: true, force: true });
}
