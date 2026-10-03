import assert from "node:assert/strict";
import { spawn } from "node:child_process";

/** Run a bounded child inside a sandbox `{cwd, env}` and capture its stdio. */
export async function runChild(sandbox, args, input = "", timeout = 20000) {
	const child = spawn(process.execPath, args, { cwd: sandbox.cwd, env: sandbox.env, stdio: "pipe" });
	let stdout = "", stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
	child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
	const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
	try {
		child.stdin.end(input);
		const { code, signal } = await new Promise((done, reject) => {
			child.once("error", reject);
			child.once("close", (code, signal) => done({ code, signal }));
		});
		assert.equal(signal, null, `child exceeded ${timeout}ms or was killed: ${stderr}`);
		return { code, stdout, stderr };
	} finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); }
}
