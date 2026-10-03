import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readJsonFileBoundedSync, writeTextFileAtomicSync } from "../src/index.ts";

const KIB = 1024;
const LIMIT = 64 * KIB;

let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-config-core-test-"));
});

afterEach(() => {
	chmodSync(directory, 0o700);
	rmSync(directory, { recursive: true, force: true });
});

const configPath = () => join(directory, "config.json");
const temporaryFiles = () => readdirSync(directory).filter((name) => name.endsWith(".tmp"));

describe("readJsonFileBoundedSync", () => {
	it("reports a missing file without creating it", () => {
		assert.deepEqual(readJsonFileBoundedSync(configPath(), LIMIT), { source: "missing" });
		assert.deepEqual(readdirSync(directory), []);
	});

	it("returns the parsed value of a JSON file", () => {
		writeFileSync(configPath(), '{"mode":"on","nested":{"count":3}}');
		assert.deepEqual(readJsonFileBoundedSync(configPath(), LIMIT), { source: "file", value: { mode: "on", nested: { count: 3 } } });
	});

	it("accepts a file at the byte limit and rejects one byte more", () => {
		const padding = "x".repeat(LIMIT - '{"a":""}'.length);
		writeFileSync(configPath(), `{"a":"${padding}"}`);
		assert.equal(statSync(configPath()).size, LIMIT);
		assert.deepEqual(readJsonFileBoundedSync(configPath(), LIMIT), { source: "file", value: { a: padding } });
		writeFileSync(configPath(), `{"a":"${padding}x"}`);
		assert.throws(() => readJsonFileBoundedSync(configPath(), LIMIT), /exceeds 65536 bytes/);
	});

	it("counts bytes rather than characters", () => {
		// Two three-byte characters exceed a 13-byte budget while the string itself is shorter.
		writeFileSync(configPath(), '{"a":"界界"}');
		assert.throws(() => readJsonFileBoundedSync(configPath(), 13), /exceeds 13 bytes/);
		assert.deepEqual(readJsonFileBoundedSync(configPath(), 14), { source: "file", value: { a: "界界" } });
	});

	it("rejects invalid UTF-8 instead of replacing bytes", () => {
		writeFileSync(configPath(), Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
		assert.throws(() => readJsonFileBoundedSync(configPath(), LIMIT), /UTF-8/);
	});

	it("throws on invalid JSON and leaves the file alone", () => {
		writeFileSync(configPath(), "{ not json");
		assert.throws(() => readJsonFileBoundedSync(configPath(), LIMIT));
		assert.equal(readFileSync(configPath(), "utf8"), "{ not json");
	});

	it("rejects a path whose target is not a regular file", () => {
		mkdirSync(join(directory, "nested"));
		assert.throws(() => readJsonFileBoundedSync(join(directory, "nested"), LIMIT), /regular file/);
	});

	it("follows a symlink to a regular configuration file", () => {
		writeFileSync(join(directory, "real.json"), '{"mode":"off"}');
		symlinkSync(join(directory, "real.json"), configPath());
		assert.deepEqual(readJsonFileBoundedSync(configPath(), LIMIT), { source: "file", value: { mode: "off" } });
	});

	it("rejects an invalid byte limit before touching the file system", () => {
		for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
			assert.throws(() => readJsonFileBoundedSync(configPath(), bad), /positive safe integer/);
		}
		assert.deepEqual(readdirSync(directory), []);
	});

	it("does not block on a FIFO and reclaims the child", { timeout: 30000 }, async () => {
		const fifo = join(directory, "pipe");
		const made = spawn("mkfifo", [fifo]);
		const code = await new Promise<number | null>((resolve) => made.on("exit", (exitCode) => resolve(exitCode)));
		if (code !== 0) return; // No mkfifo on this platform: the check is skipped, not passed.
		const source = `
			const { readJsonFileBoundedSync } = await import(${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)});
			try { readJsonFileBoundedSync(${JSON.stringify(fifo)}, ${LIMIT}); console.log("read"); }
			catch (error) { console.log("refused: " + error.message); }`;
		const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", source]);
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		const result = await new Promise<number | null | "timeout">((resolve) => {
			const timer = setTimeout(() => { child.kill("SIGKILL"); resolve("timeout"); }, 15000);
			child.on("exit", (exitCode) => { clearTimeout(timer); resolve(exitCode); });
		});
		assert.equal(result, 0, `the bounded read must not wait for a FIFO writer (output: ${output})`);
		assert.match(output, /refused: .*regular file/);
	});
});

describe("writeTextFileAtomicSync", () => {
	it("creates a private file and no temporary leftover", () => {
		writeTextFileAtomicSync(configPath(), '{"mode":"on"}\n', LIMIT);
		assert.equal(readFileSync(configPath(), "utf8"), '{"mode":"on"}\n');
		assert.deepEqual(readdirSync(directory), ["config.json"]);
		if (process.platform !== "win32") assert.equal(statSync(configPath()).mode & 0o777, 0o600);
	});

	it("creates a missing parent directory private and leaves an existing one untouched", () => {
		const nested = join(directory, "nested", "agent", "config.json");
		writeTextFileAtomicSync(nested, "{}\n", LIMIT);
		if (process.platform !== "win32") {
			assert.equal(statSync(join(directory, "nested")).mode & 0o777, 0o700);
			assert.equal(statSync(join(directory, "nested", "agent")).mode & 0o777, 0o700);
		}
		const existing = join(directory, "shared");
		mkdirSync(existing, { mode: 0o755 });
		chmodSync(existing, 0o755);
		writeTextFileAtomicSync(join(existing, "config.json"), "{}\n", LIMIT);
		if (process.platform !== "win32") assert.equal(statSync(existing).mode & 0o777, 0o755);
	});

	it("replaces the file so that an already open descriptor still reads the old bytes", () => {
		writeTextFileAtomicSync(configPath(), '{"before":true}\n', LIMIT);
		const before = statSync(configPath());
		const descriptor = openSync(configPath(), "r");
		try {
			writeTextFileAtomicSync(configPath(), '{"after":true}\n', LIMIT);
			assert.equal(readFileSync(descriptor, "utf8"), '{"before":true}\n');
		} finally { closeSync(descriptor); }
		assert.equal(readFileSync(configPath(), "utf8"), '{"after":true}\n');
		assert.notEqual(statSync(configPath()).ino, before.ino);
	});

	it("refuses oversized contents before any side effect", () => {
		const oversized = `{"a":"${"x".repeat(LIMIT)}"}`;
		assert.throws(() => writeTextFileAtomicSync(configPath(), oversized, LIMIT), /exceed 65536 bytes/);
		const nested = join(directory, "nested", "config.json");
		assert.throws(() => writeTextFileAtomicSync(nested, oversized, LIMIT), /exceed 65536 bytes/);
		assert.deepEqual(readdirSync(directory), []);
		assert.deepEqual(readJsonFileBoundedSync(configPath(), LIMIT), { source: "missing" });
	});

	it("counts bytes rather than characters when bounding a write", () => {
		assert.throws(() => writeTextFileAtomicSync(configPath(), '"界界界界"', 10), /exceed 10 bytes/);
		assert.deepEqual(readdirSync(directory), []);
	});

	it("rejects an invalid byte limit before any side effect", () => {
		assert.throws(() => writeTextFileAtomicSync(configPath(), "{}\n", 0), /positive safe integer/);
		assert.throws(() => writeTextFileAtomicSync(configPath(), "{}\n", 2.5), /positive safe integer/);
		assert.deepEqual(readdirSync(directory), []);
	});

	it("keeps the target and leaves no temporary file when the rename fails", () => {
		writeTextFileAtomicSync(configPath(), '{"kept":true}\n', LIMIT);
		const target = join(directory, "blocked");
		mkdirSync(target);
		assert.throws(() => writeTextFileAtomicSync(target, "{}\n", LIMIT));
		assert.deepEqual(readdirSync(target), []);
		assert.equal(readFileSync(configPath(), "utf8"), '{"kept":true}\n');
		assert.deepEqual(temporaryFiles(), []);
	});

	it("keeps the target and leaves no temporary file when the directory refuses the write", () => {
		if (process.platform === "win32" || process.getuid?.() === 0) return;
		const readOnly = join(directory, "read-only");
		mkdirSync(readOnly);
		writeTextFileAtomicSync(join(readOnly, "config.json"), '{"kept":true}\n', LIMIT);
		chmodSync(readOnly, 0o500);
		try {
			assert.throws(() => writeTextFileAtomicSync(join(readOnly, "config.json"), "{}\n", LIMIT));
			assert.equal(readFileSync(join(readOnly, "config.json"), "utf8"), '{"kept":true}\n');
			assert.deepEqual(readdirSync(readOnly), ["config.json"]);
		} finally { chmodSync(readOnly, 0o700); }
	});

	it("serializes concurrent writers into one complete payload without collisions", { timeout: 60000 }, async () => {
		const writers = Array.from({ length: 6 }, (_, index) => {
			const payload = JSON.stringify({ writer: index, body: "y".repeat(4096) });
			const source = `
				const { writeTextFileAtomicSync } = await import(${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)});
				writeTextFileAtomicSync(${JSON.stringify(configPath())}, ${JSON.stringify(`${payload}\n`)}, ${LIMIT});`;
			return new Promise<number | null>((resolve) => {
				const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", source]);
				child.on("exit", (code) => resolve(code));
			});
		});
		const codes = await Promise.all(writers);
		assert.deepEqual(codes, [0, 0, 0, 0, 0, 0]);
		const contents = readFileSync(configPath(), "utf8");
		const parsed = JSON.parse(contents);
		assert.equal(contents, `${JSON.stringify({ writer: parsed.writer, body: "y".repeat(4096) })}\n`, "the survivor is one complete payload");
		assert.deepEqual(temporaryFiles(), []);
	});
});
