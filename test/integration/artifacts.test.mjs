import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { discoverPackages } from "../../scripts/lib/packages.mjs";

const root = resolve(import.meta.dirname, "../..");

// A host loader may supply a `require` binding, so only native ESM proves the
// artifact's CJS interop closure is self-sufficient.
for (const name of ["context-view", "pi-add-dir", "pi-ask-user-question", "pi-background-shell", "pi-loop", "pi-subagents", "pi-tools", "pi-ui"]) {
	test(`compiled ${name} entry imports as native ESM without a host require binding`, { timeout: 30000 }, async () => {
		const packages = await discoverPackages();
		const pkg = packages.find((candidate) => candidate.name === name);
		assert.ok(pkg, `${name} is a discovered package`);
		const entry = pathToFileURL(join(pkg.directory, pkg.manifest.pi.extensions[0].slice(2))).href;
		const cjsRequire = pkg.manifest.serraly.build.cjsRequire === true;
		const source = `const factory = (await import(${JSON.stringify(entry)})).default;\n`
			+ `if (typeof factory !== "function") throw new Error("entry must default-export the extension factory");\n`
			+ (cjsRequire ? `factory({ on: () => () => {}, registerCommand() {}, registerTool() {}, appendEntry() {}, getCommands: () => [], exec: async () => ({ code: 128, killed: false, stdout: "", stderr: "not a git repository" }) });\n` : "");
		const child = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
		const timer = setTimeout(() => child.kill("SIGKILL"), 25000);
		try {
			const code = await new Promise((done, reject) => { child.once("error", reject); child.once("close", done); });
			assert.equal(code, 0, stderr.slice(-2000));
			assert.equal(stderr, "");
		} finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); }
	});
}
