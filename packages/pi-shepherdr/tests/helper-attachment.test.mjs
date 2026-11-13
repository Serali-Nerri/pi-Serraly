import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CoreClient } from "../src/core/client.ts";
import { openCoreFocusChannel } from "../src/core/focus-channel.ts";
import { focusWire } from "../src/core/focus-channel-wire.mjs";
import { openRemoteHelper } from "../src/core/remote-helper.ts";

const machine = { id: "peer-id", name: "peer", session: "test" };

function frame(channel, kind, payload) {
	const header = Buffer.alloc(9);
	header.writeUInt32LE(channel, 0);
	header[4] = kind;
	header.writeUInt32LE(payload.length, 5);
	return Buffer.concat([header, payload]);
}

function response(result) {
	return Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
}

// A Core protocol boundary, not a replacement attachment or wire implementation.
async function fixture(t, { holdLaunch = false } = {}) {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const directory = await mkdtemp(join(tmpdir(), "shepherdr-attach-"));
	const path =
		process.platform === "win32"
			? `\\\\.\\pipe\\shepherdr-${randomUUID()}`
			: join(directory, "core.sock");
	const controller = new AbortController();
	const client = new CoreClient(path);
	const sockets = new Set();
	const attached = Promise.withResolvers();
	const launched = Promise.withResolvers();
	const killed = Promise.withResolvers();
	const received = [];
	const failures = [];
	let nonce;
	let voice = false;
	let peer;
	let releaseLaunch;
	let admit;
	let attachmentCount = 0;
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => {});
		let framed = false;
		let buffer = Buffer.alloc(0);
		socket.on("data", (bytes) => {
			buffer = Buffer.concat([buffer, bytes]);
			if (!framed) {
				const newline = buffer.indexOf(10);
				if (newline < 0) return;
				const request = JSON.parse(buffer.subarray(0, newline));
				buffer = buffer.subarray(newline + 1);
				if (request.method === "terminal.run") {
					nonce = JSON.parse(
						Buffer.from(request.params.argv.at(-1), "base64"),
					).nonce;
					voice = request.params.name.startsWith("focus-");
					releaseLaunch = () =>
						socket.end(
							Buffer.concat([
								response({ address: "peer/t1" }),
								Buffer.from("\n"),
							]),
						);
					launched.resolve();
					if (!holdLaunch) releaseLaunch();
					return;
				}
				if (request.method === "terminal.kill") {
					killed.resolve(request.params.terminal);
					socket.end(Buffer.concat([response({}), Buffer.from("\n")]));
					return;
				}
				assert.equal(request.method, "hello");
				framed = true;
				socket.write(
					Buffer.concat([
						response({ generation: 1, framed: true }),
						Buffer.from("\n"),
					]),
				);
			}
			while (buffer.length >= 9) {
				const channel = buffer.readUInt32LE(0);
				const kind = buffer[4];
				const length = buffer.readUInt32LE(5);
				if (buffer.length < 9 + length) return;
				const payload = buffer.subarray(9, 9 + length);
				buffer = buffer.subarray(9 + length);
				if (channel === 0) {
					assert.equal(JSON.parse(payload).method, "terminal.attach");
					attachmentCount++;
					admit = ({ exit = false, ping = true } = {}) => {
						peer = focusWire(
							nonce,
							(data) => socket.write(frame(7, 0, data)),
							(message) => {
								received.push(message);
								if (message.type === "start") {
									peer.send({ type: voice ? "admitted" : "ready" });
								} else if (message.type === "close") {
									peer.send({ type: "closed", padding: "x".repeat(70_000) });
								} else if (voice && message.type === "data") {
									peer.send(message);
								}
							},
							(error) => failures.push(error),
							undefined,
							{
								maxMessageBytes: 8 * 1024 * 1024,
								maxQueuedBytes: 24 * 1024 * 1024,
							},
						);
						const hello = Buffer.from(
							`!${nonce}!${Buffer.from(JSON.stringify({ ping: true })).toString("base64")}!\n`,
						);
						// One socket read can contain both the attachment ACK and first data.
						socket.write(
							Buffer.concat([
								frame(0, 0, response({ channel: 7 })),
								exit
									? frame(7, 2, Buffer.alloc(0))
									: ping
										? frame(7, 0, hello)
										: Buffer.alloc(0),
							]),
						);
					};
					attached.resolve();
				} else if (kind === 0) {
					assert.equal(channel, 7);
					peer.push(payload);
				}
			}
		});
	});
	t.after(async () => {
		controller.abort();
		peer?.close();
		client.close();
		for (const socket of sockets) socket.destroy();
		await new Promise((resolve) => server.close(resolve));
		await rm(directory, { recursive: true, force: true });
	});
	server.listen(path);
	await once(server, "listening");
	return {
		attached: attached.promise,
		launched: launched.promise,
		killed: killed.promise,
		received,
		failures,
		controller,
		admit: (options) => admit(options),
		releaseLaunch: () => releaseLaunch(),
		attachmentCount: () => attachmentCount,
		open: () =>
			openRemoteHelper(
				path,
				machine,
				() => {},
				() => {},
				controller.signal,
			),
		focus: () =>
			openCoreFocusChannel(
				client,
				path,
				machine,
				{
					pane_id: "t2",
					terminal_id: "t2",
					agent_status: "idle",
					turn: 0,
					agent_session: {
						agent: "pi",
						kind: "path",
						source: "label",
						value: "/saved.jsonl",
					},
				},
				{
					source: {
						host: "controller",
						session: "test",
						terminal: "t3",
						sessionFile: "/controller.jsonl",
					},
				},
				{ signal: controller.signal },
			),
	};
}

test("delayed attachment preserves the first data frame and graceful close under credit pressure", {
	timeout: 5000,
}, async (t) => {
	const core = await fixture(t);
	const opening = core.open();
	void opening.catch(() => {});
	await core.attached;
	t.mock.timers.tick(1500);
	core.admit();
	const helper = await opening;
	assert.equal(core.received[0].type, "start");
	assert.equal(typeof core.received[0].input.modules.helper, "string");
	helper.send({ type: "bulk", payload: "x".repeat(70_000) });
	await helper.close();
	assert.deepEqual(
		core.received.map((message) => message.type),
		["start", "bulk", "close"],
	);
	assert.equal(await core.killed, "peer-id/t1");
	assert.deepEqual(core.failures, []);
});

test("voice focus also waits for attachment before starting its heartbeat", {
	timeout: 5000,
}, async (t) => {
	const core = await fixture(t);
	const opening = core.focus();
	void opening.catch(() => {});
	await core.attached;
	t.mock.timers.tick(1500);
	core.admit();
	const channel = await opening;
	const reply = Promise.withResolvers();
	channel.onMessage(reply.resolve);
	channel.send({ sample: "voice" });
	assert.deepEqual(await reply.promise, { sample: "voice" });
	channel.close();
	assert.equal(await core.killed, "peer-id/t1");
});

test("an exit coalesced with attachment fails startup without leaking the helper", {
	timeout: 5000,
}, async (t) => {
	const core = await fixture(t);
	const opening = core.open();
	void opening.catch(() => {});
	await core.attached;
	core.admit({ exit: true });
	await assert.rejects(opening, /Remote focus process ended/);
	assert.equal(await core.killed, "peer-id/t1");
	assert.deepEqual(core.received, []);
});

test("cancellation before a late launch reply still kills the accepted helper", {
	timeout: 5000,
}, async (t) => {
	const core = await fixture(t, { holdLaunch: true });
	const opening = core.open();
	void opening.catch(() => {});
	await core.launched;
	core.controller.abort();
	core.releaseLaunch();
	await assert.rejects(opening, /cancelled/);
	assert.equal(await core.killed, "peer-id/t1");
	assert.equal(core.attachmentCount(), 0);
});
