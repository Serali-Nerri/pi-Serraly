import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
	const source = readFileSync(new URL("../../../scripts/test.mjs", import.meta.url), "utf8");
	assert.doesNotMatch(source, /\.\.\.\s*process\.env/);
	assert.match(source, /testEnvironment\(base/);
});
