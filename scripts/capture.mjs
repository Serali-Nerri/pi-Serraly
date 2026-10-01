#!/usr/bin/env node
/** Actual bundled Pi CLI in a POSIX PTY. Python stdlib only; no added dependency. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cliArguments, createSandbox, expectedVersion, reports } from "./preview.mjs";

export function ptyAvailability() {
	const result = spawnSync("/usr/bin/python3", ["-c", "import pty, termios, fcntl"], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
	if (result.error?.code === "ENOENT") return "optional PTY capture requires /usr/bin/python3 with POSIX pty/termios/fcntl";
	if (result.status !== 0 && /ModuleNotFoundError|ImportError/.test(result.stderr || "")) return "optional POSIX Python PTY modules are unavailable";
	assert.equal(result.status, 0, result.stderr || String(result.error));
	return undefined;
}

const driver = String.raw`
import os, sys, json, pty, termios, fcntl, struct, subprocess, select, time, errno, signal
config = json.loads(sys.argv[1])
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 44, config["width"], 0, 0))
def setup():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)
env = dict(config["env"], COLUMNS=str(config["width"]), LINES="44")
child = subprocess.Popen(config["argv"], cwd=config["cwd"], env=env, stdin=slave, stdout=slave, stderr=slave, preexec_fn=setup, close_fds=True)
os.close(slave)
output = bytearray()
deadline = time.monotonic() + 25
stage, at = 0, None
try:
    while True:
        if time.monotonic() > deadline:
            raise RuntimeError("PTY deadline: bundled CLI failed to finish the scripted fixture")
        ready, _, _ = select.select([master], [], [], 0.05)
        if ready:
            try:
                data = os.read(master, 65536)
                if not data: break
                output.extend(data)
            except OSError as error:
                if error.errno == errno.EIO: break
                raise
        try:
            with open(config["env"]["PI_UI_REPORT"], encoding="utf8") as report:
                events = [json.loads(line) for line in report if line.endswith("\n")]
        except (FileNotFoundError, json.JSONDecodeError):
            events = []
        if stage == 0 and any(event["phase"] == "host-identity" for event in events):
            stage, at = 1, time.monotonic() + 0.2
        if stage == 1 and time.monotonic() >= at:
            os.write(master, b"/ccstyle status\r")
            stage = 2
        if stage == 2 and any(event["phase"] == "notify" for event in events):
            stage, at = 3, time.monotonic() + 0.2
        if stage == 3 and time.monotonic() >= at:
            os.write(master, b"/quit\r")
            stage = 4
        if child.poll() is not None and not ready: break
    child.wait(timeout=3)
    if child.returncode != 0:
        raise RuntimeError("bundled CLI exit status " + str(child.returncode))
    if stage != 4:
        raise RuntimeError("CLI exited before live identity and /ccstyle status checks")
finally:
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait()
    os.close(master)
    with open(config["output"], "wb") as capture: capture.write(output)
`;

export async function capturePty(sandbox, mode, width) {
	assert.ok(["regular", "fullscreen"].includes(mode));
	assert.ok([40, 80, 120].includes(width));
	const output = join(sandbox.base, `${mode}-${width}.ansi`);
	const config = { argv: [process.execPath, ...cliArguments(sandbox, ["--tui-mode", mode, "Show the synthetic fixture"])],
		cwd: sandbox.cwd, env: sandbox.env, width, output };
	const child = spawn("/usr/bin/python3", ["-c", driver, JSON.stringify(config)], { env: sandbox.env, cwd: sandbox.cwd, stdio: ["ignore", "pipe", "pipe"] });
	let stderr = "";
	child.stdout.resume();
	child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
	const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
	try {
		const code = await new Promise((done, reject) => { child.once("error", reject); child.once("close", (code) => done(code)); });
		const ansi = await readFile(output, "utf8").catch(() => "");
		assert.equal(code, 0, `${stderr}\n${ansi.slice(-5000)}`);
		return { ansi, diagnostics: await reports(sandbox), mode, width };
	} finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); }
}

async function main() {
	const unavailable = ptyAvailability();
	assert.equal(unavailable, undefined, unavailable);
	const outputDir = resolve(process.argv[2] || "/tmp/pi-ui-stage-one-captures");
	await mkdir(outputDir, { recursive: true });
	for (const mode of ["regular", "fullscreen"]) for (const width of [40, 80, 120]) {
		const sandbox = await createSandbox();
		try {
			const result = await capturePty(sandbox, mode, width);
			const phases = result.diagnostics.map((entry) => entry.phase);
			assert.ok(phases.includes("host-identity") && phases.includes("shutdown"), "missing identity/cleanup evidence");
			assert.ok(!phases.includes("network-denied") && !phases.includes("fixture-error"));
			await writeFile(join(outputDir, `${mode}-${width}.ansi`), result.ansi);
			await writeFile(join(outputDir, `${mode}-${width}.json`), JSON.stringify(result.diagnostics, null, 2) + "\n");
			console.log(`Pi ${expectedVersion} ${mode} ${width}x44: ${result.ansi.length} ANSI characters; host identity and cleanup checked`);
		} finally { await sandbox.cleanup(); }
	}
	console.log(`Raw ANSI captures and synthetic diagnostics: ${outputDir}\nNot screenshots or visual acceptance. Inspect with: less -R ${outputDir}/regular-80.ansi`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => { console.error(error); process.exitCode = 1; });
}
