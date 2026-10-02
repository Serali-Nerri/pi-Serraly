import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const runner = resolve(import.meta.dirname, "../../scripts/test-isolated.mjs");

// A runner that inherits HOME/credentials, uses the source cwd, or leaks its
// scratch tree breaks the safety boundary before any SDK/provider fixture runs.
void describe("workspace test isolation", () => {
	void it("runs in an empty temporary cwd with temporary HOME/agent paths and no ambient credentials", () => {
		const probe = `
			const fs = require("node:fs");
			console.log(JSON.stringify({
				cwd: process.cwd(), entries: fs.readdirSync(process.cwd()),
				home: process.env.HOME, agent: process.env.PI_CODING_AGENT_DIR,
				sessions: process.env.PI_CODING_AGENT_SESSION_DIR,
				config: process.env.XDG_CONFIG_HOME, cache: process.env.XDG_CACHE_HOME,
				credential: process.env.OPENAI_API_KEY,
				offline: process.env.PI_OFFLINE
			}));
		`;
		const child = spawnSync(process.execPath, [runner, "--eval", probe], {
			encoding: "utf8", timeout: 30_000,
			env: { ...process.env, OPENAI_API_KEY: "must-not-reach-fixture" },
		});
		assert.equal(child.status, 0, `${child.stdout}${child.stderr}`);
		const observed: unknown = JSON.parse(child.stdout);
		assert.ok(typeof observed === "object" && observed !== null);
		const values = observed as Record<string, unknown>;
		assert.deepEqual(values["entries"], []);
		assert.equal(values["credential"], undefined);
		assert.equal(values["offline"], "1");
		for (const key of ["cwd", "home", "agent", "sessions", "config", "cache"]) {
			const path = values[key];
			assert.equal(typeof path, "string");
			assert.match(String(path), /pi-bg-tests-/);
			assert.equal(existsSync(String(path)), false, "runner must remove its isolated tree");
		}
	});
	void it("propagates the fixture failure status instead of reporting a green script", () => {
		const child = spawnSync(process.execPath, [runner, "--eval", "process.exitCode = 37;"], {
			encoding: "utf8", timeout: 30_000,
		});
		assert.equal(child.status, 37, `${child.stdout}${child.stderr}`);
	});
});
