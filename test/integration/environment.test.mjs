import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSandbox } from "../../scripts/preview.mjs";
import { isolatedEnvironment } from "../../scripts/lib/environment.mjs";

test("generic isolation carries no UI preview stage or report path", () => {
	const base = "/synthetic/generic-sandbox";
	const env = isolatedEnvironment(base);
	assert.equal(env.HOME, join(base, "home"));
	assert.equal(env.PI_OFFLINE, "1");
	assert.equal(env.PI_UI_STAGE, undefined, "the generic environment must not preload a UI preview stage");
	assert.equal(env.PI_UI_REPORT, undefined, "the generic environment must not redirect a UI preview report");
});

test("test subprocesses receive resolved host code but no inherited credentials or user directories", async () => {
	const { isolatedRun } = await import(new URL("../../scripts/lib/workspace.mjs", import.meta.url).href);
	const base = await realpath(await mkdtemp(join(tmpdir(), "serraly-env-observation-")));
	const managedRoot = join(base, "install");
	const directory = join(managedRoot, "releases/1.3.0/node_modules/@earendil-works/pi-coding-agent");
	const canaries = {
		HOME: "/synthetic/user-home", PI_CODING_AGENT_DIR: "/synthetic/user-agent",
		AWS_SECRET_ACCESS_KEY: "synthetic-canary", AWS_SESSION_TOKEN: "synthetic-canary",
		GOOGLE_APPLICATION_CREDENTIALS: "/synthetic/credential.json",
		ANTHROPIC_API_KEY: "synthetic-canary", PI_SESSION_FILE: "/synthetic/session.jsonl",
		HTTPS_PROXY: "https://synthetic.invalid", NODE_OPTIONS: "--require=synthetic-missing-module",
		PI_MANAGED_INSTALL_ROOT: managedRoot, PI_UI_HOST_PACKAGE: undefined,
	};
	const previous = new Map(Object.keys(canaries).map((key) => [key, process.env[key]]));
	try {
		await mkdir(join(directory, "dist/bundle"), { recursive: true });
		await writeFile(join(directory, "package.json"), JSON.stringify({
			name: "@earendil-works/pi-coding-agent", version: "1.3.0", bin: { pi: "dist/bundle/cli.js" },
		}));
		await writeFile(join(directory, "dist/bundle/cli.js"), "// Fixture code; never launched.\n");
		await writeFile(join(managedRoot, "current-version"), "1.3.0\n");
		for (const [key, value] of Object.entries(canaries)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		const output = join(base, "environment.json");
		await isolatedRun(process.execPath, ["--input-type=module", "-e",
			'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[1], JSON.stringify(process.env));', output], base);
		const env = JSON.parse(await readFile(output, "utf8"));
		for (const key of Object.keys(canaries).filter((key) => !["HOME", "PI_CODING_AGENT_DIR", "PI_UI_HOST_PACKAGE"].includes(key))) {
			assert.equal(env[key], undefined, key);
		}
		assert.equal(env.PI_UI_HOST_PACKAGE, directory);
		assert.notEqual(env.HOME, process.env.HOME);
		assert.notEqual(env.PI_CODING_AGENT_DIR, process.env.PI_CODING_AGENT_DIR);
		assert.equal(env.PI_CODING_AGENT_DIR, join(env.TMPDIR, "agent"));
		assert.equal(env.HOME, join(env.TMPDIR, "home"));
		assert.equal(env.XDG_CONFIG_HOME, join(env.TMPDIR, "home/.config"));
		assert.equal(env.XDG_CACHE_HOME, join(env.TMPDIR, "home/.cache"));
		assert.equal(env.PI_OFFLINE, "1");
		assert.equal(env.PI_HYPERLINKS, "1");
		assert.equal(env.PI_UI_STAGE, undefined, "test children never inherit a preview stage path");
		assert.equal(env.PI_UI_REPORT, undefined, "test children never inherit a preview report path");
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(base, { recursive: true, force: true });
	}
});

test("source-only subprocesses do not require an external Pi installation", async () => {
	const { isolatedRun } = await import("../../scripts/lib/workspace.mjs");
	const base = await mkdtemp(join(tmpdir(), "serraly-source-only-"));
	const executable = process.execPath;
	const descriptor = Object.getOwnPropertyDescriptor(process, "execPath");
	const controls = ["PI_UI_HOST_PACKAGE", "PI_MANAGED_INSTALL_ROOT"];
	const previous = new Map(controls.map((key) => [key, process.env[key]]));
	try {
		for (const key of controls) delete process.env[key];
		Object.defineProperty(process, "execPath", { ...descriptor, value: join(base, "bin/node") });
		const output = join(base, "environment.json");
		await isolatedRun(executable, ["--input-type=module", "-e",
			'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[1], JSON.stringify(process.env));', output], base);
		const env = JSON.parse(await readFile(output, "utf8"));
		assert.equal(env.PI_UI_HOST_PACKAGE, undefined);
		assert.equal(env.PI_MANAGED_INSTALL_ROOT, undefined);
		assert.equal(env.PI_OFFLINE, "1");
		assert.notEqual(env.HOME, process.env.HOME);
	} finally {
		Object.defineProperty(process, "execPath", descriptor);
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(base, { recursive: true, force: true });
	}
});

test("isolated npm build and validation commands are offline with registry side work disabled", async () => {
	const base = await mkdtemp(join(tmpdir(), "serraly-npm-config-"));
	try {
		const env = isolatedEnvironment(base);
		await mkdir(env.HOME, { recursive: true });
		env.NODE_OPTIONS = `--import=${new URL("fixtures/network-guard.mjs", import.meta.url).href}`;
		env.SERRALY_REPORT = join(base, "network-report.jsonl");
		const result = spawnSync("npm", ["config", "get", "offline", "update-notifier", "audit", "fund"], {
			cwd: base, env, encoding: "utf8", timeout: 10000,
		});
		assert.equal(result.status, 0, result.stderr);
		const config = Object.fromEntries(result.stdout.trim().split("\n").map((line) => line.split("=").map((value) => value.trim())));
		assert.equal(config.offline, "true");
		assert.equal(config["update-notifier"], "false");
		assert.equal(config.audit, "false");
		assert.equal(config.fund, "false");
		const report = await readFile(env.SERRALY_REPORT, "utf8").catch((error) => {
			if (error.code === "ENOENT") return "";
			throw error;
		});
		assert.equal(report, "", "npm configuration inspection must not attempt registry networking");
	} finally { await rm(base, { recursive: true, force: true }); }
});

test("UI preview owns its stage and report paths explicitly", { timeout: 60000 }, async () => {
	const sandbox = await createSandbox();
	try {
		assert.equal(sandbox.env.PI_UI_STAGE, join(sandbox.base, "pi-ui/index.js"));
		assert.equal(sandbox.env.PI_UI_REPORT, join(sandbox.base, "report.jsonl"));
	} finally { await sandbox.cleanup(); }
});
