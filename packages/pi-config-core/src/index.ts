/**
 * Bounded, atomic JSON file I/O for the UI configuration layer.
 *
 * This library owns the mechanism only: a caller-declared byte ceiling, strict
 * UTF-8 decoding, a collision-free temporary file, private permissions and the
 * rename that publishes the write. Every consumer keeps its own error, trust and
 * merge policy — a missing file is reported rather than created, and a malformed
 * or oversized file is a failure the caller decides how to treat.
 */
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export type JsonFileRead =
	| { readonly source: "missing" }
	| { readonly source: "file"; readonly value: unknown };

/** A byte ceiling must be a positive safe integer; reject anything else before I/O. */
function assertByteLimit(maxBytes: number): void {
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
		throw new RangeError(`maxBytes must be a positive safe integer, received ${maxBytes}`);
	}
}

/** Strict UTF-8: never silently replace bytes. A leading byte order mark is kept. */
function decodeUtf8(bytes: Buffer, path: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch (cause) {
		throw new Error(`Invalid UTF-8 in ${path}: ${(cause as Error).message}`);
	}
}

/**
 * Read at most `maxBytes` bytes of a text file, never reading the whole file first.
 * A missing file is reported; a non-regular target, an oversized file, invalid
 * UTF-8 and I/O failures throw. The descriptor is closed on every path.
 */
function readTextBoundedSync(path: string, maxBytes: number): { readonly contents: string } | { readonly missing: true } {
	assertByteLimit(maxBytes);
	let descriptor: number;
	try {
		// Symlinks are followed as before. O_NONBLOCK keeps opening a FIFO from
		// waiting for a writer; the fstat below refuses it before any read.
		descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { missing: true };
		throw cause;
	}
	try {
		if (!fstatSync(descriptor).isFile()) throw new Error(`Not a regular file: ${path}`);
		const buffer = Buffer.allocUnsafe(maxBytes + 1);
		let filled = 0;
		while (filled < buffer.length) {
			const read = readSync(descriptor, buffer, filled, buffer.length - filled, null);
			if (read === 0) break;
			filled += read;
		}
		if (filled > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes: ${path}`);
		return { contents: decodeUtf8(buffer.subarray(0, filled), path) };
	} finally {
		closeSync(descriptor);
	}
}

/**
 * Read and parse a JSON file within `maxBytes`.
 *
 * A missing file returns `{source: "missing"}` and is never created. Any other
 * failure — unreadable path, non-regular target, oversized file, invalid UTF-8,
 * invalid JSON — throws. The parsed value stays `unknown`: shape validation
 * belongs to the consumer.
 */
export function readJsonFileBoundedSync(path: string, maxBytes: number): JsonFileRead {
	const read = readTextBoundedSync(path, maxBytes);
	if ("missing" in read) return { source: "missing" };
	return { source: "file", value: JSON.parse(read.contents) };
}

/**
 * Write text atomically, refusing contents that exceed `maxBytes`.
 *
 * The size is checked before any side effect, so an oversized write creates no
 * directory and no temporary file. The write goes to `<name>.<pid>.<uuid>.tmp` in
 * the same directory with `wx` and `0600`, then renames over the target. A missing
 * parent directory is created with `0700`; an existing one keeps its mode.
 * Failures remove the temporary file and propagate. There is no lock and no
 * crash-durable `fsync`: concurrent writers are last-writer-wins, and every write
 * that succeeds is complete.
 */
export function writeTextFileAtomicSync(path: string, contents: string, maxBytes: number): void {
	assertByteLimit(maxBytes);
	const bytes = Buffer.from(contents, "utf8");
	if (bytes.length > maxBytes) throw new Error(`Contents exceed ${maxBytes} bytes: ${path}`);
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const temporary = join(directory, `${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
		writeFileSync(descriptor, bytes);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporary, path);
	} catch (cause) {
		if (descriptor !== undefined) {
			try { closeSync(descriptor); } catch { /* Already closed, or never opened. */ }
		}
		try { unlinkSync(temporary); } catch { /* Already renamed, or never created. */ }
		throw cause;
	}
}
