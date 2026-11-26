import type { ChildProcessByStdio } from "node:child_process";
import { createServer, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";

/** Adapt the owned compiler's separate stdio streams to the public tsrs socket client. */
export function bridgeCompilerStdio(
	child: ChildProcessByStdio<Writable, Readable, null>,
	pipe: string,
) {
	const { stdin, stdout } = child;
	let socket: Socket | undefined;
	let closing: Promise<void> | undefined;
	const server = createServer((connection) => {
		if (socket || child.exitCode !== null || child.signalCode !== null) {
			connection.destroy();
			return;
		}
		socket = connection;
		connection.on("error", () => connection.destroy());
		connection.once("close", () => {
			connection.unpipe(stdin);
			stdout.unpipe(connection);
			stdin.end();
		});
		connection.pipe(stdin);
		stdout.pipe(connection);
	});
	const close = (): Promise<void> => {
		socket?.destroy();
		if (closing) return closing;
		if (!server.listening) return Promise.resolve();
		return (closing = new Promise<void>((resolve) =>
			server.close(() => resolve()),
		));
	};
	const stop = () => {
		void close();
	};
	child.once("close", stop);
	stdin.on("error", stop);
	stdout.on("error", stop);
	return {
		listen: () =>
			new Promise<void>((resolve, reject) => {
				const onError = (error: Error) => reject(error);
				server.once("error", onError);
				server.listen(pipe, () => {
					server.off("error", onError);
					server.on("error", stop);
					resolve();
				});
			}),
		close,
	};
}
