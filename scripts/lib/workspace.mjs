import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));
const networkGuard = new URL("./network-guard.mjs", import.meta.url).href;

export function requireNode(version = process.versions.node) {
	const parts = version.split(".").map(Number);
	if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part)) ||
		parts[0] < 22 || (parts[0] === 22 && parts[1] < 19)) {
		throw new Error("Node >=22.19.0 is required");
	}
}

export async function packages(directory = root) {
	const result = [];
	for (const entry of await readdir(join(directory, "packages"), { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const path = join(directory, "packages", entry.name);
		const manifest = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
		result.push({ name: entry.name, directory: path, manifest });
	}
	return result.sort((a, b) => a.name.localeCompare(b.name));
}

/** A command owns its temporary home and process group, including failure paths. */
export async function runIsolated(command, args, { cwd = root, env = {}, timeoutMs = 120_000, echo = false } = {}) {
	requireNode();
	const home = await mkdtemp(join(tmpdir(), "pi-serraly-"));
	for (const directory of ["agent", "config", "cache", "data", "state", "tmp", "work"]) {
		await mkdir(join(home, directory));
	}
	const log = join(home, "network-denied.log");
	try {
		const result = await new Promise((resolve, reject) => {
			const child = spawn(command, args, {
				cwd, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
				env: {
					PATH: process.env.PATH ?? `${dirname(process.execPath)}:/usr/bin:/bin`,
					LANG: "C.UTF-8", TERM: "xterm-256color", COLORTERM: "truecolor",
					HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"),
					XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"),
					PI_CODING_AGENT_DIR: join(home, "agent"), TMPDIR: join(home, "tmp"),
					PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
					GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
					npm_config_offline: "true", npm_config_ignore_scripts: "true", npm_config_audit: "false",
					npm_config_fund: "false", npm_config_update_notifier: "false",
					...env,
					NODE_OPTIONS: `--import=${networkGuard}`,
					PI_SERRALY_NETWORK_LOG: log,
				},
			});
			let stdout = "", stderr = "", timedOut = false;
			const kill = () => {
				if (!child.pid) return;
				try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); }
				catch (error) { if (error.code !== "ESRCH") throw error; }
			};
			const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
			child.stdout.on("data", (chunk) => { stdout += chunk; if (echo) process.stdout.write(chunk); });
			child.stderr.on("data", (chunk) => { stderr += chunk; if (echo) process.stderr.write(chunk); });
			child.once("error", (error) => { clearTimeout(timer); reject(error); });
			child.once("close", (code, signal) => {
				clearTimeout(timer);
				kill(); // Reap any descendants that outlived a successful parent too.
				if (timedOut) reject(new Error(`${command} timed out after ${timeoutMs}ms`));
				else resolve({ code, signal, stdout, stderr });
			});
		});
		let denied = "";
		try { denied = await readFile(log, "utf8"); }
		catch (error) { if (error.code !== "ENOENT") throw error; }
		if (denied) throw new Error(`Network access denied:\n${denied}`);
		if (result.code !== 0) throw new Error(`${command} exited ${result.code ?? result.signal}\n${result.stderr}\n${result.stdout}`);
		return result;
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}
