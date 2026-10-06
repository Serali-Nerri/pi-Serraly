import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chmod, copyFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { releaseFixture, sandboxFixture, diagnostics } from "./helpers/runtime.mjs";
import { runChild } from "../../scripts/lib/process.mjs";

let stage;
before(async () => {
	stage = await releaseFixture({ packages: ["pi-subagents", "pi-session-reference", "pi-add-dir"] });
}, { timeout: 180000 });
after(async () => { await stage?.cleanup(); });

async function run(scenario, config = {}) {
	const sandbox = await sandboxFixture(stage.release, config);
	try {
		// Reuse the existing fd process-boundary fixture with the real host provider.
		const fd = join(sandbox.base, "fixtures/reference-fd.mjs");
		await copyFile(resolve(import.meta.dirname, "../../extensions/pi-add-dir/test/fixtures/fd.mjs"), fd);
		await chmod(fd, 0o755);
		const result = await runChild(sandbox,
			[join(sandbox.base, "fixtures/references-worker.mjs"), stage.host.directory, scenario], "", 30000);
		const reports = await diagnostics(sandbox);
		assert.equal(result.code, 0, `${scenario}: ${result.stderr}\n${JSON.stringify(reports)}`);
		assert.equal(result.stdout, "", "reference SDK probes must not pollute protocol stdout");
		assert.equal(result.stderr, "");
		assert.ok(!reports.some((item) => ["network-denied", "fixture-error"].includes(item.phase)), JSON.stringify(reports));
		assert.ok(reports.some((item) => item.phase === "complete" && item.scenario === scenario));
		return reports;
	} finally { await sandbox.cleanup(); }
}

for (const names of [
	["pi-subagents", "pi-session-reference", "pi-add-dir"],
	["pi-add-dir", "pi-session-reference", "pi-subagents"],
]) test(`compiled reference and file completion compose with ${names.join(" → ")}`, { timeout: 40000 }, async () => {
	await run("completion", { names });
});

test("compiled supplemental backgrounds coexist in actual requests and sequential automatic retries", { timeout: 40000 }, async () => {
	const reports = await run("requests", { retryRequests: [2, 3],
		names: ["pi-subagents", "pi-session-reference", "pi-add-dir"] });
	assert.equal(reports.filter((item) => item.phase === "reference-provider-request").length, 5);
	assert.equal(reports.filter((item) => item.phase === "reference-tool-call").length, 0,
		"explicit references alone never execute tools or spawn an Agent");
});

for (const [disabled, mode] of [["pi-session-reference", "json"], ["pi-subagents", "rpc"]]) {
	test(`disabling compiled ${disabled} leaves the other reference capability and add-dir intact (${mode} binding)`, { timeout: 40000 }, async () => {
		const reports = await run("requests", { disabled, mode,
			packageFilter: [`-extensions/${disabled}/dist/${disabled}.js`] });
		assert.equal(reports.filter((item) => item.phase === "reference-tool-call").length, 0);
	});
}

test("compiled supplemental backgrounds also compose in reversed factory order", { timeout: 40000 }, async () => {
	await run("requests", { names: ["pi-add-dir", "pi-session-reference", "pi-subagents"] });
});

async function rpcReference(sandbox, args, prompt) {
	const child = spawn(process.execPath, args, { cwd: sandbox.cwd, env: sandbox.env, stdio: "pipe" });
	const records = [];
	let stdout = "", stderr = "", parseError, resolveSettled, rejectSettled, settled = false;
	const completion = new Promise((resolve, reject) => { resolveSettled = resolve; rejectSettled = reject; });
	const closed = new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => { if (!settled) rejectSettled(new Error("RPC exited before settlement: " + stderr)); resolve(code); });
	});
	void closed.catch(() => {});
	child.once("error", rejectSettled);
	child.stdin.on("error", rejectSettled);
	child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
	child.stdout.setEncoding("utf8").on("data", (chunk) => {
		stdout += chunk;
		while (stdout.includes("\n")) {
			const end = stdout.indexOf("\n"), line = stdout.slice(0, end).replace(/\r$/, "");
			stdout = stdout.slice(end + 1);
			try {
				const record = JSON.parse(line);
				records.push(record);
				if (record.type === "agent_settled") { settled = true; resolveSettled(); }
			} catch (error) { parseError = error; rejectSettled(error); }
		}
	});
	const timer = setTimeout(() => { rejectSettled(new Error("reference RPC deadline")); child.kill("SIGKILL"); }, 25000);
	try {
		child.stdin.write(JSON.stringify({ id: "references", type: "prompt", message: prompt }) + "\n");
		await completion;
		child.stdin.end();
		assert.equal(await closed, 0, stderr);
		assert.equal(stderr, "");
		assert.equal(parseError, undefined);
		assert.equal(stdout, "", "RPC protocol remains LF-terminated JSONL");
		assert.ok(records.some((record) => record.id === "references" && record.success === true));
		return records;
	} finally {
		clearTimeout(timer);
		if (child.exitCode === null) child.kill("SIGKILL");
		await closed.catch(() => {});
	}
}

for (const mode of ["print", "json", "rpc"]) {
	test(`compiled explicit references reach the actual CLI ${mode} provider without protocol pollution`, { timeout: 40000 }, async () => {
		const sandbox = await sandboxFixture(stage.release);
		try {
			const seeded = await runChild(sandbox, [join(sandbox.base, "fixtures/references-worker.mjs"), stage.host.directory, "seed"]);
			assert.equal(seeded.code, 0, seeded.stderr);
			assert.equal(seeded.stdout, "");
			assert.equal(seeded.stderr, "");
			const source = (await diagnostics(sandbox)).find((item) => item.phase === "reference-seed");
			assert.ok(source);
			const bytes = await readFile(source.file);
			const manifest = JSON.parse(await readFile(join(stage.release, "package.json"), "utf8"));
			const prompt = `Use @session:[${source.id}] with @subagent:[example].`;
			const args = [stage.host.cli, "--offline", "--no-session", "--no-approve", "--no-extensions", "--no-skills",
				"--no-prompt-templates", "--no-themes", "--no-context-files",
				"-e", join(sandbox.base, "fixtures/references-provider.js"),
				...manifest.pi.extensions.flatMap((entry) => ["-e", join(stage.release, entry.slice(2))]),
				"--provider", "serraly-fixture", "--model", "fixture", "--thinking", "off"];
			let records;
			if (mode === "rpc") records = await rpcReference(sandbox, [...args, "--mode", "rpc"], prompt);
			else {
				const result = await runChild(sandbox, [...args, ...(mode === "print" ? ["--print"] : ["--mode", "json"]), prompt]);
				assert.equal(result.code, 0, result.stderr);
				assert.equal(result.stderr, "");
				if (mode === "print") assert.equal(result.stdout.trim(), "Reference fixture complete.");
				else records = result.stdout.trim().split("\n").map(JSON.parse);
			}
			if (records) {
				assert.ok(records.some((record) => record.type === "agent_settled"));
				assert.ok(!records.some((record) => record.type === "extension_error" || record.type === "extension_ui_request"));
				const backgrounds = records.filter((record) => record.type === "message_start" && record.message.role === "custom");
				assert.deepEqual(backgrounds.map((record) => record.message.customType).sort(), ["session-reference", "subagent-mention"]);
			}
			const reports = await diagnostics(sandbox);
			assert.ok(!reports.some((item) => ["network-denied", "fixture-error", "reference-tool-call"].includes(item.phase)), JSON.stringify(reports));
			const requests = reports.filter((item) => item.phase === "reference-provider-request");
			assert.equal(requests.length, 1, "one scripted parent request, no spawned child");
			const actual = JSON.stringify(requests[0].context.messages);
			assert.ok(actual.includes(prompt));
			assert.match(actual, /EFFECTIVE EDITED HISTORY/);
			assert.match(actual, /RETAINED COMPACTION SUMMARY/);
			assert.ok(actual.includes('Agent {\\"agent\\":\\"Example\\"}'));
			assert.doesNotMatch(actual, /ABANDONED BRANCH|NESTED REFERENCE GUIDANCE|NESTED DELEGATION GUIDANCE|UNSELECTED HISTORY/);
			assert.ok(reports.some((item) => item.phase === "reference-settled" && item.mode === mode));
			assert.deepEqual(await readFile(source.file), bytes, "headless selection leaves the source bytes unchanged");
		} finally { await sandbox.cleanup(); }
	});
}
