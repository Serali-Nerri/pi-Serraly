import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { root } from "./packages.mjs";
import { testEnvironment } from "./environment.mjs";

export async function discoverTests(directory) {
	const paths = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory() && entry.name !== "node_modules") paths.push(...await discoverTests(path));
		else if (entry.isFile() && /\.test\.(?:ts|mjs)$/.test(entry.name)) paths.push(path);
	}
	return paths.sort();
}

export async function isolatedRun(command, args, cwd = root, { denyNetwork = false } = {}) {
	const base = await mkdtemp(join(tmpdir(), "pi-serraly-verify-"));
	try {
		const env = testEnvironment(base);
		if (denyNetwork) {
			env.SERRALY_REPORT = join(base, "network-report.jsonl");
			env.NODE_OPTIONS = `--import=${pathToFileURL(join(root, "test/integration/fixtures/network-guard.mjs")).href}`;
			env.NPM_CONFIG_UPDATE_NOTIFIER = "false";
			env.NPM_CONFIG_AUDIT = "false";
			env.NPM_CONFIG_FUND = "false";
		}
		await Promise.all([env.HOME, env.PI_CODING_AGENT_DIR, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME]
			.map((path) => mkdir(path, { recursive: true })));
		const child = spawn(command, args, { cwd, env, stdio: "inherit" });
		const interrupt = () => child.kill("SIGTERM");
		process.once("SIGINT", interrupt);
		process.once("SIGTERM", interrupt);
		try {
			const code = await new Promise((done, reject) => {
				child.once("error", reject);
				child.once("exit", (code, signal) => done(code ?? (signal ? 1 : 0)));
			});
			if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed (${code})`);
				if (denyNetwork) {
					const report = await readFile(env.SERRALY_REPORT, "utf8").catch((error) => {
						if (error.code === "ENOENT") return "";
						throw error;
					});
					if (report.split("\n").filter(Boolean).some((line) => JSON.parse(line).phase === "network-denied")) {
						throw new Error(`${command} attempted forbidden networking`);
					}
				}
		} finally {
			process.removeListener("SIGINT", interrupt);
			process.removeListener("SIGTERM", interrupt);
		}
	} finally { await rm(base, { recursive: true, force: true }); }
}
