import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { superviseParents } from "../src/core/helper-lifetime.mjs";

const denied = () =>
	Object.assign(new Error("parent access denied"), { kind: "denied" });
const live = (pid = 20) => ({ address: "t2", state: "live", pid });
const child = (address = "t3", parent = "remote/t2", pid = 30) => ({
	address,
	state: "live",
	pid,
	parent,
	die_with_parent: true,
});
const tick = () => setImmediate();

async function fixture(t, reply = () => live()) {
	let now = 0,
		next = 0,
		receive,
		fail;
	const timers = new Map(),
		calls = [],
		notices = [];
	const clock = {
		setTimeout(callback, delay) {
			const id = ++next;
			timers.set(id, { callback, at: now + delay });
			return id;
		},
		clearTimeout(id) {
			timers.delete(id);
		},
		async advance(ms) {
			const target = now + ms;
			await tick();
			for (;;) {
				const due = [...timers.entries()]
					.filter(([, timer]) => timer.at <= target)
					.sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				now = due[1].at;
				timers.delete(due[0]);
				due[1].callback();
				await tick();
			}
			now = target;
			await tick();
		},
	};
	const originals = {
		now: Date.now,
		setTimeout: globalThis.setTimeout,
		clearTimeout: globalThis.clearTimeout,
	};
	Date.now = () => now;
	globalThis.setTimeout = clock.setTimeout;
	globalThis.clearTimeout = clock.clearTimeout;
	const restore = () => {
		Date.now = originals.now;
		globalThis.setTimeout = originals.setTimeout;
		globalThis.clearTimeout = originals.clearTimeout;
	};
	t.after(() => {
		timers.clear();
		restore();
	});
	const core = {
		async request(method, params, timeout) {
			const call = { method, terminal: params.terminal, timeout, at: now };
			calls.push(call);
			return reply(call, clock);
		},
		subscribe(_filter, handler, onFailure) {
			receive = handler;
			fail = onFailure;
			handler({ method: "snapshot", terminals: [child()] });
			return {
				ready: Promise.resolve(),
				close() {
					receive = undefined;
				},
			};
		},
	};
	const supervisor = await superviseParents(
		core,
		(message, level = "warning") => notices.push({ message, level, at: now }),
	);
	await tick();
	return {
		clock,
		calls,
		notices,
		timers,
		supervisor,
		setReply(value) {
			reply = value;
		},
		async emit(type, terminal = "t9", data) {
			receive?.({ method: "event", event: { type, terminal, data } });
			await tick();
		},
		async snapshot(terminals) {
			receive?.({ method: "snapshot", terminals });
			await tick();
		},
		async fail() {
			fail(new Error("event stream unavailable"));
			await tick();
		},
		async close() {
			const closing = supervisor.close();
			await tick();
			await clock.advance(1500);
			await closing;
			assert.equal(timers.size, 0, "close left a timer");
			restore();
		},
	};
}

test("transient startup denied is retried without a warning", {
	timeout: 2000,
}, async (t) => {
	let reads = 0;
	const f = await fixture(t, () => {
		if (++reads === 1) throw denied();
		return live();
	});
	assert.equal(
		f.notices.length,
		0,
		"first startup denied must not warn immediately",
	);
	await f.clock.advance(100);
	assert.deepEqual(
		f.calls.map((call) => call.at),
		[0, 100],
	);
	assert.equal(f.notices.length, 0);
	assert.equal(f.timers.size, 0);
	await f.close();
});

test("persistent denied has five attempts, one warning and no resets from siblings/events", {
	timeout: 2000,
}, async (t) => {
	const f = await fixture(t, () => {
		throw denied();
	});
	await f.clock.advance(50);
	await f.emit("created", "t4", child("t4"));
	await f.emit("removed");
	await f.snapshot([child(), child("t4")]);
	assert.equal(f.calls.length, 1);
	assert.equal(f.timers.size, 1);
	await f.clock.advance(1450);
	assert.deepEqual(
		f.calls.map((call) => call.at),
		[0, 100, 300, 700, 1500],
	);
	assert.deepEqual(
		f.calls.map((call) => call.timeout),
		[2000, 1900, 1700, 1300, 500],
	);
	assert.equal(f.notices.length, 1);
	assert.equal(f.notices[0].level, "warning");
	assert.equal(f.timers.size, 0);
	await f.emit("removed");
	assert.equal(f.notices.length, 1);
	assert.equal(f.timers.size, 0);
	await f.close();
});

test("slow denial uses the remaining request budget", {
	timeout: 2000,
}, async (t) => {
	const f = await fixture(
		t,
		(call, clock) =>
			new Promise((_resolve, reject) =>
				clock.setTimeout(() => reject(denied()), Math.min(600, call.timeout)),
			),
	);
	await f.clock.advance(2000);
	assert.deepEqual(
		f.calls.map((call) => [call.at, call.timeout]),
		[
			[0, 2000],
			[700, 1300],
			[1500, 500],
		],
	);
	assert.equal(f.notices.length, 1);
	assert.equal(f.timers.size, 0);
	f.setReply(() => live());
	await f.close();
});

test("a pending retry leaves the serial queue available to other parents", {
	timeout: 2000,
}, async (t) => {
	const f = await fixture(t, (call) => {
		if (call.terminal === "remote/t2") throw denied();
		return { ...live(), address: "t5" };
	});
	await f.emit("created", "t6", child("t6", "remote/t5", 60));
	assert.deepEqual(
		f.calls.map((call) => [call.terminal, call.at]),
		[
			["remote/t2", 0],
			["remote/t5", 0],
		],
	);
	assert.equal(f.timers.size, 1);
	await f.close();
});

test("a retry delayed behind another check cannot exceed its original deadline", {
	timeout: 2000,
}, async (t) => {
	let release;
	const f = await fixture(t, (call) => {
		if (call.terminal === "remote/t2") throw denied();
		return new Promise((resolve) => {
			release = resolve;
		});
	});
	await f.emit("created", "t6", child("t6", "remote/t5", 60));
	await f.clock.advance(2100);
	release({ ...live(), address: "t5" });
	await tick();
	assert.equal(
		f.calls.filter((call) => call.terminal === "remote/t2").length,
		1,
	);
	assert.equal(f.notices.length, 1);
	assert.equal(f.notices[0].level, "warning");
	assert.equal(f.timers.size, 0);
	f.setReply((call) => ({
		...live(),
		address: call.terminal.split("/").at(-1),
	}));
	await f.close();
});

test("other kinds, nested denied, bad identity and unknown state warn immediately", {
	timeout: 2000,
}, async (t) => {
	for (const value of [
		Object.assign(new Error("not found"), { kind: "not_found" }),
		Object.assign(new Error("nested denied"), { data: { kind: "denied" } }),
		{ ...live(), address: "t5" },
		{ ...live(), state: "unknown" },
	]) {
		const f = await fixture(t, () => {
			if (value instanceof Error) throw value;
			return value;
		});
		assert.equal(f.notices.length, 1);
		assert.equal(f.calls.length, 1);
		assert.equal(f.timers.size, 0);
		await f.close();
	}
});

test("verified parent denial warns immediately and recovery is info and deduplicated", {
	timeout: 2000,
}, async (t) => {
	const f = await fixture(t);
	f.setReply(() => {
		throw denied();
	});
	await f.emit("removed");
	assert.equal(f.notices.length, 1);
	assert.equal(f.timers.size, 0);
	await f.emit("removed");
	assert.equal(f.notices.length, 1);
	f.setReply(() => live());
	await f.emit("removed");
	assert.deepEqual(
		f.notices.map((notice) => notice.level),
		["warning", "info"],
	);
	await f.emit("removed");
	assert.equal(f.notices.length, 2);
	await f.close();
});

test("persistent startup failure can recover once through a later event", {
	timeout: 2000,
}, async (t) => {
	const f = await fixture(t, () => {
		throw denied();
	});
	await f.clock.advance(1500);
	f.setReply(() => live());
	await f.emit("removed");
	await f.emit("removed");
	assert.deepEqual(
		f.notices.map((notice) => notice.level),
		["warning", "info"],
	);
	await f.close();
});

test("stream failure suppresses recovery announcements", {
	timeout: 2000,
}, async (t) => {
	const f = await fixture(t, () => {
		throw Object.assign(new Error("other"), { kind: "unavailable" });
	});
	await f.fail();
	f.setReply(() => live());
	await f.emit("removed");
	assert.equal(f.notices.filter((notice) => notice.level === "info").length, 0);
	await f.close();
});

test("child get and kill denied never enter the startup retry window", {
	timeout: 2000,
}, async (t) => {
	for (const failMethod of ["terminal.get", "terminal.kill"]) {
		const f = await fixture(t, (call) => {
			if (call.terminal === "remote/t2")
				return { ...live(), state: "finished", pid: null };
			if (call.method === failMethod) throw denied();
			return child();
		});
		assert.equal(f.notices.length, 1);
		assert.equal(f.timers.size, 0);
		f.setReply((call) =>
			call.terminal === "remote/t2"
				? { ...live(), state: "finished", pid: null }
				: child(),
		);
		await f.emit("removed");
		assert.deepEqual(
			f.notices.map((notice) => notice.level),
			["warning", "info"],
		);
		await f.close();
	}
});

test("forget removes the retry and a replacement parent receives its own window", {
	timeout: 2000,
}, async (t) => {
	const f = await fixture(t, () => {
		throw denied();
	});
	await f.clock.advance(50);
	await f.emit("removed", "t3");
	assert.equal(f.timers.size, 0);
	assert.equal(f.calls.length, 1);
	await f.emit("created", "t3", child());
	await f.clock.advance(100);
	assert.deepEqual(
		f.calls.map((call) => call.at),
		[0, 50, 150],
	);
	await f.emit("removed", "t3");
	await f.close();
});

test("an already queued retry cannot check a forgotten and recreated parent", {
	timeout: 2000,
}, async (t) => {
	let release;
	const f = await fixture(t, (call) => {
		if (call.terminal === "remote/t2") throw denied();
		return new Promise((resolve) => {
			release = resolve;
		});
	});
	await f.emit("created", "t6", child("t6", "remote/t5", 60));
	await f.emit("removed", "t3");
	await f.emit("created", "t3", child());
	await f.clock.advance(100);
	f.setReply((call) => {
		if (call.terminal === "remote/t2") throw denied();
		return { ...live(), address: "t5" };
	});
	release({ ...live(), address: "t5" });
	await tick();
	assert.deepEqual(
		f.calls
			.filter((call) => call.terminal === "remote/t2")
			.map((call) => call.at),
		[0, 100],
	);
	assert.equal(f.timers.size, 1);
	await f.clock.advance(100);
	assert.deepEqual(
		f.calls
			.filter((call) => call.terminal === "remote/t2")
			.map((call) => call.at),
		[0, 100, 200],
	);
	assert.equal(f.notices.length, 0);
	f.setReply((call) => ({
		...live(),
		address: call.terminal.split("/").at(-1),
	}));
	await f.close();
});

test("close disables retry but retains queue drain and final 1500ms observation", {
	timeout: 2000,
}, async (t) => {
	const f = await fixture(t, () => {
		throw denied();
	});
	const closing = f.supervisor.close();
	await tick();
	assert.equal(
		f.timers.size,
		1,
		"only the closing observation timer should remain",
	);
	await f.clock.advance(100);
	assert.equal(f.calls.length, 1);
	f.setReply((call) =>
		call.terminal === "remote/t2"
			? { ...live(), state: "finished", pid: null }
			: child(),
	);
	await f.clock.advance(1400);
	await closing;
	assert.deepEqual(
		f.calls.map((call) => [call.method, call.terminal, call.at]),
		[
			["terminal.get", "remote/t2", 0],
			["terminal.get", "remote/t2", 1500],
			["terminal.get", "t3", 1500],
			["terminal.kill", "t3", 1500],
		],
	);
	assert.equal(f.timers.size, 0);
});

test("close still verifies parent death when its observation outlasts the startup deadline", {
	timeout: 2000,
}, async (t) => {
	const f = await fixture(t, () => {
		throw denied();
	});
	await f.clock.advance(600);
	const closing = f.supervisor.close();
	await tick();
	f.setReply((call) =>
		call.terminal === "remote/t2"
			? { ...live(), state: "finished", pid: null }
			: child(),
	);
	await f.clock.advance(1500);
	await closing;
	assert.deepEqual(
		f.calls.map((call) => [call.method, call.terminal, call.at, call.timeout]),
		[
			["terminal.get", "remote/t2", 0, 2000],
			["terminal.get", "remote/t2", 100, 1900],
			["terminal.get", "remote/t2", 300, 1700],
			["terminal.get", "remote/t2", 2100, 2000],
			["terminal.get", "t3", 2100, 2000],
			["terminal.kill", "t3", 2100, 2000],
		],
	);
	assert.equal(f.notices.length, 0);
	assert.equal(f.timers.size, 0);
});

test("close drains an in-flight check before starting its final observation window", {
	timeout: 2000,
}, async (t) => {
	let reject;
	const f = await fixture(
		t,
		() =>
			new Promise((_resolve, rejectRequest) => {
				reject = rejectRequest;
			}),
	);
	const closing = f.supervisor.close();
	await tick();
	assert.equal(f.timers.size, 0);
	await f.clock.advance(50);
	reject(denied());
	await tick();
	assert.equal(f.notices.length, 1);
	assert.equal(f.timers.size, 1);
	f.setReply(() => live());
	await f.clock.advance(1499);
	assert.equal(f.calls.length, 1);
	await f.clock.advance(1);
	await closing;
	assert.deepEqual(
		f.calls.map((call) => call.at),
		[0, 1550],
	);
	assert.equal(f.timers.size, 0);
});

test("parent PID change and final states kill only freshly reverified owned children", {
	timeout: 2000,
}, async (t) => {
	for (const parent of [
		{ ...live(), state: "finished", pid: null },
		...[
			"holder_lost",
			"stopped_by_restart",
			"server_stop",
			"host_shutdown",
			"signaled",
		].map((reason) => ({ ...live(), pid: null, reason })),
		live(21),
	]) {
		const f = await fixture(t);
		f.setReply((call) => (call.terminal === "remote/t2" ? parent : child()));
		await f.emit("removed");
		assert.deepEqual(
			f.calls.slice(1).map((call) => [call.method, call.terminal]),
			[
				["terminal.get", "remote/t2"],
				["terminal.get", "t3"],
				["terminal.kill", "t3"],
			],
		);
		await f.close();
	}
	for (const changed of [
		{ address: "t4" },
		{ state: "finished" },
		{ parent: "remote/t5" },
		{ die_with_parent: false },
		{ pid: 31 },
	]) {
		const f = await fixture(t);
		f.setReply((call) =>
			call.terminal === "remote/t2"
				? { ...live(), state: "finished", pid: null }
				: { ...child(), ...changed },
		);
		await f.emit("removed");
		assert.equal(
			f.calls.filter((call) => call.method === "terminal.kill").length,
			0,
		);
		await f.close();
	}
});
