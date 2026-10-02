import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { diagnostics } from "./runtime.mjs";

export async function runRpc(sandbox, args) {
	const child = spawn(process.execPath, args, { cwd: sandbox.cwd, env: sandbox.env, stdio: "pipe" });
	const events = new EventEmitter(), records = [];
	let stdout = "", stderr = "", parseError;
	child.stdout.setEncoding("utf8").on("data", (chunk) => {
		stdout += chunk;
		while (stdout.includes("\n")) {
			const index = stdout.indexOf("\n"), line = stdout.slice(0, index).replace(/\r$/, ""); stdout = stdout.slice(index + 1);
			try { const record = JSON.parse(line); records.push(record); events.emit("record", record); }
			catch (error) { parseError = error; events.emit("failure", error); }
		}
	});
	child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
	const closed = new Promise((done, reject) => { child.once("error", reject); child.once("close", (code) => done(code)); });
	void closed.catch(() => {});
	const timer = setTimeout(() => child.kill("SIGKILL"), 25000);
	function waitFor(predicate) {
		const prior = records.find(predicate); if (prior) return Promise.resolve(prior);
		return new Promise((done, reject) => {
			const timeout = setTimeout(() => finish(new Error("RPC event deadline: " + stderr)), 20000);
			const record = (value) => { if (predicate(value)) finish(undefined, value); };
			const failed = (error) => finish(error);
			const exit = () => finish(new Error("RPC exited before expected event: " + stderr));
			function finish(error, value) { clearTimeout(timeout); events.off("record", record); events.off("failure", failed); child.off("close", exit); if (error) reject(error); else done(value); }
			events.on("record", record); events.on("failure", failed); child.once("close", exit);
		});
	}
	async function request(id, type, extra = {}) {
		const response = waitFor((record) => record.type === "response" && record.id === id);
		child.stdin.write(JSON.stringify({ id, type, ...extra }) + "\n");
		const value = await response; assert.equal(value.success, true, JSON.stringify(value)); return value.data;
	}
	try {
		const state = await request("state", "get_state"); assert.equal(state.sessionFile, undefined);
		const commands = await request("commands", "get_commands");
		assert.deepEqual(commands.commands.map((item) => item.name).sort(), ["bg", "bg-clear", "bg-tasks", "ccstyle", "context", "docparser:doctor", "jobs", "kill", "logs", "loop", "tasks"]);
		const settled = waitFor((record) => record.type === "agent_settled");
		await request("prompt", "prompt", { message: "Local synthetic reply" }); await settled;
		child.stdin.end(); assert.equal(await closed, 0, stderr);
		assert.equal(stderr, ""); assert.equal(parseError, undefined); assert.equal(stdout, "", "strict LF-terminated JSONL");
		assert.ok(!records.some((record) => record.type === "extension_ui_request" && ["setWidget", "setHeader", "setFooter"].includes(record.method)), "no UI-owned bridge in RPC");
		return records;
	} finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); await closed.catch(() => {}); }
}

// Same Python/POSIX technique as scripts/capture.mjs, but with the final six
// compiled entries and fixture arguments rather than its stage-one UI bundle.
const ptyDriver = String.raw`
import os,sys,json,pty,termios,fcntl,struct,subprocess,select,time,errno,signal
config=json.loads(sys.argv[1])
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack("HHHH",44,80,0,0))
def setup():
    os.setsid()
    fcntl.ioctl(0,termios.TIOCSCTTY,0)
child=subprocess.Popen(config["argv"],cwd=config["cwd"],env=config["env"],stdin=slave,stdout=slave,stderr=slave,preexec_fn=setup,close_fds=True)
os.close(slave)
output=bytearray(); deadline=time.monotonic()+30; sent=False
try:
    while True:
        if time.monotonic()>deadline: raise RuntimeError("Six-entry PTY fixture deadline")
        ready,_,_=select.select([master],[],[],0.05)
        if ready:
            try:
                data=os.read(master,65536)
                if not data: break
                output.extend(data)
            except OSError as error:
                if error.errno==errno.EIO: break
                raise
        try:
            with open(config["env"]["SERRALY_REPORT"],encoding="utf8") as report:
                events=[json.loads(line) for line in report if line.endswith("\n")]
        except (FileNotFoundError,json.JSONDecodeError): events=[]
        if not sent and any(event["phase"]=="settled" for event in events):
            os.write(master,b"/quit\r"); sent=True
        if child.poll() is not None and not ready: break
    child.wait(timeout=3)
    if child.returncode!=0: raise RuntimeError("Bundled CLI failed: "+str(child.returncode))
    if not sent: raise RuntimeError("Fixture never settled")
finally:
    if child.poll() is None:
        os.killpg(child.pid,signal.SIGKILL); child.wait()
    os.close(master)
    with open(config["output"],"wb") as capture: capture.write(output)
`;

export async function captureReleasePty(sandbox, args) {
	await writeFile(join(sandbox.cwd, "seed.txt"), "Independent release synthetic read fixture.\n");
	const output = join(sandbox.base, "capture.ansi");
	const child = spawn("/usr/bin/python3", ["-c", ptyDriver, JSON.stringify({
		argv: [process.execPath, ...args], cwd: sandbox.cwd, env: sandbox.env, output,
	})], { cwd: sandbox.cwd, env: sandbox.env, stdio: ["ignore", "ignore", "pipe"] });
	let stderr = "";
	child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
	const timer = setTimeout(() => child.kill("SIGKILL"), 35000);
	try {
		const code = await new Promise((done, reject) => { child.once("error", reject); child.once("close", done); });
		const ansi = await readFile(output, "utf8").catch(() => "");
		const reports = await diagnostics(sandbox);
		assert.equal(code, 0, `${stderr}\n${JSON.stringify(reports)}\n${ansi.slice(-5000)}`);
		return { ansi, reports };
	} finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); }
}
