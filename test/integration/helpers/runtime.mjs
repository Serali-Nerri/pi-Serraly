import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRelease, validateRelease } from "../../../scripts/lib/package.mjs";
import { hostPackage, isolatedEnvironment, runChild } from "../../../scripts/preview.mjs";

import { entries } from "../fixtures/contracts.mjs";
export { entries };
export const fixtures = resolve(import.meta.dirname, "../fixtures");

export async function releaseFixture() {
	const base = await mkdtemp(join(tmpdir(), "serraly-runtime-release-"));
	try {
		const release = join(base, "release");
		await createRelease(release, { buildId: "runtime-integration" });
		await validateRelease(release);
		return { release, host: hostPackage(), async cleanup() { await rm(base, { recursive: true, force: true }); } };
	} catch (error) { await rm(base, { recursive: true, force: true }); throw error; }
}

export async function sandboxFixture(release, config = {}) {
	const base = await mkdtemp(join(tmpdir(), "serraly-runtime-session-"));
	const env = isolatedEnvironment(base);
	const cwd = join(base, "cwd");
	try {
		await Promise.all([cwd, env.HOME, env.PI_CODING_AGENT_DIR].map((path) => mkdir(path, { recursive: true })));
		await cp(fixtures, join(base, "fixtures"), { recursive: true });
		await writeFile(join(base, "fixtures/cli-safety.js"), 'export { installGuard as default } from "./cli-fixture.js";\n');
		await writeFile(join(base, "package.json"), '{"type":"module"}\n');
		env.NODE_OPTIONS = `--import=${join(base, "fixtures/network-guard.mjs")}`;
		env.SERRALY_REPORT = join(base, "report.jsonl");
		env.SERRALY_RELEASE = release;
		env.SERRALY_CONFIG = join(base, "config.json");
		await writeFile(env.SERRALY_CONFIG, JSON.stringify(config));
		await writeFile(join(env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({
			theme: "dark", hideThinkingBlock: true, defaultTools: ["+tool_search", "+codemode"],
			defaultProvider: "serraly-fixture", defaultModel: "fixture", cacheWarming: "off",
			compaction: { enabled: false }, retry: { enabled: false },
			enableInstallTelemetry: false, enableAnalytics: false, defaultProjectTrust: "never",
			packages: config.packageFilter === undefined ? [] : [{ source: release, extensions: config.packageFilter }],
		}));
		return { base, cwd, env, async cleanup() { await rm(base, { recursive: true, force: true }); } };
	} catch (error) { await rm(base, { recursive: true, force: true }); throw error; }
}

export async function diagnostics(sandbox) {
	try { return (await readFile(sandbox.env.SERRALY_REPORT, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); }
	catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

export async function sdkScenario(stage, scenario, config = {}, timeout = 30000) {
	const sandbox = await sandboxFixture(stage.release, config);
	try {
		const result = await runChild(sandbox, [join(sandbox.base, "fixtures/sdk-worker.mjs"), stage.host.directory, scenario], "", timeout);
		const reports = await diagnostics(sandbox);
		assert.equal(result.code, 0, `${scenario}: ${result.stderr}\n${JSON.stringify(reports)}`);
		assert.equal(result.stderr, "");
		assert.ok(!reports.some((report) => report.phase === "network-denied" || report.phase === "fixture-error"), JSON.stringify(reports));
		assert.ok(reports.some((report) => report.phase === "complete" && report.scenario === scenario), "worker assertions reached completion");
		assert.equal(result.stdout, "", "SDK behavior probes never pollute protocol stdout");
		return reports;
	} finally { await sandbox.cleanup(); }
}

export function cliArgs(sandbox, host, extra = []) {
	return [host.cli, "--offline", "--no-session", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
		"--no-extensions", "-e", join(sandbox.base, "fixtures/cli-guard.js"), "-e", join(sandbox.base, "fixtures/cli-safety.js"),
		...entries.flatMap((entry) => ["-e", join(sandbox.env.SERRALY_RELEASE, entry)]),
		"-e", "builtin:tool-search", "-e", join(sandbox.base, "fixtures/cli-fixture.js"),
		"--provider", "serraly-fixture", "--model", "fixture", "--thinking", "off", ...extra];
}
