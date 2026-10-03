import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { sealDist, verifyDist } from "../../scripts/lib/artifacts.mjs";
import { modules, root } from "../../scripts/lib/modules.mjs";

test("a missing lazy module is diagnosed by its artifact path before publication", async () => {
	const base = await mkdtemp(join(tmpdir(), "serraly-missing-lazy-"));
	try {
		await cp(join(root, "dist"), join(base, "dist"), { recursive: true });
		await rm(join(base, "dist/pi-background-shell/src/core/lazy-module.js"));
		await assert.rejects(verifyDist(join(base, "dist")), /pi-background-shell\/src\/core\/lazy-module\.js/);
	} finally { await rm(base, { recursive: true, force: true }); }
});

test("a modified compiled tool is rejected rather than sealed as a release", async () => {
	const base = await mkdtemp(join(tmpdir(), "serraly-modified-tool-"));
	try {
		await cp(join(root, "dist"), join(base, "dist"), { recursive: true });
		await writeFile(join(base, "dist/pi-tools/index.js"), "export default () => {};\n");
		await assert.rejects(verifyDist(join(base, "dist")), /pi-tools\/index\.js/);
	} finally { await rm(base, { recursive: true, force: true }); }
});

for (const legalFile of [
	"pi-ui/licenses/LICENSES/pi-compact-thinking.txt",
	"pi-ui/licenses/LICENSES/marked.txt",
	"pi-tools/licenses/diff-BSD.txt",
	"pi-add-dir/licenses/pi-config-store-MIT.txt",
	"pi-add-dir/licenses/proper-lockfile-MIT.txt",
	"pi-add-dir/licenses/graceful-fs-ISC.txt",
	"pi-add-dir/licenses/retry-MIT.txt",
	"pi-add-dir/licenses/signal-exit-ISC.txt",
	"pi-subagents/LICENSE",
	"pi-subagents/UPSTREAM.md",
]) {
	test(`sealing requires inherited legal payload: ${legalFile}`, async () => {
		const base = await mkdtemp(join(tmpdir(), "serraly-missing-license-"));
		try {
			await cp(join(root, "dist"), join(base, "dist"), { recursive: true });
			await rm(join(base, "dist", legalFile));
			await assert.rejects(sealDist(join(base, "dist")), (error) => error.message.includes(legalFile));
		} finally { await rm(base, { recursive: true, force: true }); }
	});
}

// A host loader may supply a `require` binding, so only native ESM proves the artifact's
// CJS interop closure (proper-lockfile and friends) is self-sufficient.
for (const { runtime, cjsRequire } of modules) {
	test(`compiled ${runtime} entry imports as native ESM without a host require binding`, { timeout: 30000 }, async () => {
		const entry = pathToFileURL(join(root, "dist", runtime, "index.js")).href;
		const source = `const factory = (await import(${JSON.stringify(entry)})).default;\nif (typeof factory !== "function") throw new Error("entry must default-export the extension factory");\nif (${Boolean(cjsRequire)}) factory({ on: () => () => {}, registerCommand() {}, registerTool() {}, appendEntry() {}, getCommands: () => [], exec: async () => ({ code: 128, killed: false, stdout: "", stderr: "not a git repository" }) });\n`;
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

for (const entry of ["pi-ui/index.js", "pi-background-shell/src/core/lazy-module.js"]) {
	for (const linked of [false, true]) {
		test(`sealing rejects an outside ${linked ? "linked" : "regular"} executable imported by ${entry}`, async () => {
			const base = await mkdtemp(join(tmpdir(), "serraly-outside-import-"));
			try {
				await cp(join(root, "dist"), join(base, "dist"), { recursive: true });
				const external = join(base, "outside.mjs");
				await writeFile(external, "export default function outside() {}\n");
				const target = linked ? join(base, "outside-link.mjs") : external;
				if (linked) await symlink(external, target);
				await writeFile(join(base, "dist", entry), `export { default } from ${JSON.stringify(target)};\n`);
				await assert.rejects(sealDist(join(base, "dist")), /outside|closure/i);
			} finally { await rm(base, { recursive: true, force: true }); }
		});
	}
}

for (const [kind, specifier, decoyName] of [
	["encoded dots", "./%2e%2e/%2e%2e/outside.mjs", "%2e%2e/%2e%2e/outside.mjs"],
	["query", "../../outside.mjs?/../dist/pi-ui/decoy.mjs", "decoy.mjs"],
	["fragment", "../../outside.mjs#/../dist/pi-ui/decoy.mjs", "decoy.mjs"],
	["backslashes", "./..\\..\\outside.mjs", "..\\..\\outside.mjs"],
	["URL control characters", "./.\n./.\n./outside.mjs", ".\n./.\n./outside.mjs"],
]) {
	test(`${kind} cannot seal a filesystem decoy instead of Node's actual worker import`, {
		skip: process.platform === "win32" && ["backslashes", "URL control characters"].includes(kind) ?
			"This fixture requires POSIX filenames which differ from file-URL resolution" : false,
	}, async () => {
		const base = await mkdtemp(join(tmpdir(), "serraly-encoded-import-"));
		try {
			await cp(join(root, "dist"), join(base, "dist"), { recursive: true });
			await writeFile(join(base, "outside.mjs"), "export default () => \"actual-outside\";\n");
			const decoy = join(base, "dist/pi-ui", decoyName);
			await mkdir(dirname(decoy), { recursive: true });
			await writeFile(decoy, "export default () => \"sealed-decoy\";\n");
			const worker = join(base, "dist/pi-ui/encoded-probe.mjs");
			await writeFile(worker, `export { default } from ${JSON.stringify(specifier)};\n`);
			assert.equal((await import(pathToFileURL(worker).href)).default(), "actual-outside");
			await assert.rejects(sealDist(join(base, "dist")), /specifier|closure|outside/i);
		} finally { await rm(base, { recursive: true, force: true }); }
	});
}
