import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { testEnvironment } = await import(new URL("../../../scripts/test-environment.mjs", import.meta.url).href);
test("root test environment allowlists controls and replaces all user directories", () => {
	const base = "/synthetic/test-sandbox";
	const canaries = {
		HOME: "/real/home", NODE_OPTIONS: "--require=credential-reader",
		AWS_SECRET_ACCESS_KEY: "canary", AWS_SESSION_TOKEN: "canary",
		GOOGLE_APPLICATION_CREDENTIALS: "/real/credential.json", HTTPS_PROXY: "canary",
		ANTHROPIC_API_KEY: "canary", PI_SESSION_FILE: "/real/session.jsonl",
		PI_UI_HOST_PACKAGE: "/explicit/host-package",
	};
	const env = testEnvironment(base, canaries);
	for (const key of Object.keys(canaries).filter((key) => key !== "HOME" && key !== "PI_UI_HOST_PACKAGE")) {
		assert.equal(env[key], undefined, key);
	}
	assert.equal(env.HOME, join(base, "home"));
	assert.equal(env.PI_CODING_AGENT_DIR, join(base, "agent"));
	assert.equal(env.XDG_CACHE_HOME, join(base, "home/.cache"));
	assert.equal(env.PI_UI_HOST_PACKAGE, canaries.PI_UI_HOST_PACKAGE);
	assert.equal(env.PI_OFFLINE, "1");
	assert.equal(env.PI_HYPERLINKS, "1");
});

test("the workspace process launcher excludes inherited credentials and session pointers", async () => {
	const { isolatedRun } = await import(new URL("../../../scripts/lib/workspace.mjs", import.meta.url).href);
	const base = await mkdtemp(join(tmpdir(), "serraly-env-observation-"));
	const canaries = {
		ANTHROPIC_API_KEY: "synthetic-canary", PI_SESSION_FILE: "/synthetic/session.jsonl",
		HTTPS_PROXY: "https://synthetic.invalid", NODE_OPTIONS: "--require=synthetic-missing-module",
	};
	const previous = new Map(Object.keys(canaries).map((key) => [key, process.env[key]]));
	try {
		Object.assign(process.env, canaries);
		const output = join(base, "environment.json");
		await isolatedRun(process.execPath, ["--input-type=module", "-e",
			'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[1], JSON.stringify(process.env));', output], base);
		const env = JSON.parse(await readFile(output, "utf8"));
		for (const key of Object.keys(canaries)) assert.equal(env[key], undefined, key);
		assert.notEqual(env.HOME, process.env.HOME);
		assert.equal(env.PI_OFFLINE, "1");
		assert.equal(env.PI_HYPERLINKS, "1");
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(base, { recursive: true, force: true });
	}
});
