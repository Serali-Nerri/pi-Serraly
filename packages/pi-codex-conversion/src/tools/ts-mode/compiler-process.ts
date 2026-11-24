import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { API } from "tsrs/async";
import type { TsRuntime } from "./runtime.ts";

export interface TsCompilerProcess {
	api: API;
	close(): Promise<void>;
}

/** Own the API server so its optimization policy never changes Pi's environment. */
export async function startTsCompiler(
	runtime: TsRuntime,
	options: { cwd: string; tsserverPath?: string },
): Promise<TsCompilerProcess> {
	const isWin = process.platform === "win32";
	const directory = join(tmpdir(), `pi-ts-${randomUUID()}`);
	const pipe = isWin
		? `\\\\.\\pipe\\pi-ts-${randomUUID()}`
		: join(directory, "socket");
	// On Windows, tsrs --pipe creates a non-overlapped pipe for SyncRpcChannel that
	// deadlocks net.createConnection; run tsrs over stdio and bridge via an overlapped server.
	const args = isWin
		? [
				"--api",
				"--async",
				"--cwd",
				options.cwd,
				"--useCaseSensitiveFileNames=false",
			]
		: ["--api", "--async", "--cwd", options.cwd, "--pipe", directory];
	// Keep the notebook's optimized compiler policy; an explicit user environment wins.
	const child = spawn(
		options.tsserverPath ?? process.execPath,
		options.tsserverPath ? args : [runtime.launcher, ...args],
		{
			cwd: options.cwd,
			env: { ...process.env, TSRS_FAST: process.env["TSRS_FAST"] ?? "1" },
			detached: !isWin,
			stdio: isWin
				? ["pipe", "pipe", "inherit"]
				: ["ignore", "ignore", "inherit"],
		},
	);
	let failure: Error | undefined;
	child.once("error", (error) => {
		failure = error;
	});
	child.stdin?.on("error", () => {});
	child.stdout?.on("error", () => {});

	const sockets = new Set<Socket>();
	let bridge: Server | undefined;
	if (isWin) {
		const srv = createServer((socket) => {
			if (
				child.exitCode !== null ||
				child.signalCode !== null ||
				!child.stdin ||
				!child.stdout
			) {
				socket.destroy();
				return;
			}
			sockets.add(socket);
			const stdout = child.stdout;
			socket.on("error", () => socket.destroy());
			socket.once("close", () => {
				sockets.delete(socket);
				stdout.unpipe(socket);
			});
			socket.pipe(child.stdin, { end: false });
			stdout.pipe(socket, { end: false });
		});
		await new Promise<void>((resolve, reject) => {
			srv.once("error", reject);
			srv.listen(pipe, () => resolve());
		});
		bridge = srv;
	}

	const closed = new Promise<void>((resolve) =>
		child.once("close", () => {
			for (const socket of sockets) socket.destroy();
			resolve();
		}),
	);
	let api = new runtime.api.API({ pipe });
	let closing: Promise<void> | undefined;
	const close = (): Promise<void> =>
		(closing ??= (async () => {
			try {
				await api.close();
			} finally {
				try {
					if (bridge) {
						for (const socket of sockets) socket.destroy();
						const srv = bridge;
						bridge = undefined;
						await new Promise<void>((resolve) => srv.close(() => resolve()));
					}
					if (isWin && child.exitCode === null && child.signalCode === null) {
						child.stdin?.end();
						await Promise.race([closed, setTimeout(500)]);
					}
					if (
						child.pid &&
						child.exitCode === null &&
						child.signalCode === null
					) {
						if (isWin)
							await new Promise<void>((resolve, reject) =>
								execFile(
									"taskkill",
									["/pid", String(child.pid), "/T", "/F"],
									(error) => {
										if (
											error &&
											child.exitCode === null &&
											child.signalCode === null
										)
											reject(error);
										else resolve();
									},
								),
							);
						else {
							try {
								process.kill(-child.pid, "SIGKILL");
							} catch (error) {
								if (
									!(
										error instanceof Error &&
										"code" in error &&
										error.code === "ESRCH"
									)
								)
									// oxlint-disable-next-line no-unsafe-finally -- Cleanup failure must remain visible, even when the primary operation failed.
									throw error;
							}
						}
					}
					await closed;
				} finally {
					if (!isWin) await rm(directory, { recursive: true, force: true });
				}
			}
		})());
	try {
		const deadline = performance.now() + 15_000;
		while (true) {
			if (failure) throw failure;
			if (child.exitCode !== null || child.signalCode !== null)
				throw new Error("TS compiler stopped during startup");
			try {
				await api.parseCommandLine([]);
				break;
			} catch (error) {
				await api.close();
				if (
					!(
						error instanceof Error &&
						/ENOENT|ECONNREFUSED|ECONNRESET|Socket error|closed the connection/i.test(
							error.message,
						)
					) ||
					performance.now() >= deadline
				)
					throw error;
				await setTimeout(10);
				api = new runtime.api.API({ pipe });
			}
		}
		return { api, close };
	} catch (error) {
		await close();
		throw error;
	}
}
