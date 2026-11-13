import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { dispatchAgentWork } from "../src/agents-work.ts";
import { terminalPane, terminalSnapshot } from "../src/core/terminal.ts";
import { parseMonitoredAgent } from "../src/monitor-record.ts";
import { MonitorState } from "../src/monitor-state.ts";
import { SettlementReporter } from "../src/settlement/index.ts";

function fixture(t) {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const native = {
		address: "t1",
		state: "live",
		turn: 0,
		status: { app: "pi", state: "idle" },
		labels: { "pi.session_file": "/fixture/session.jsonl" },
	};
	const snapshot = () => terminalSnapshot({ terminals: [native] });
	const state = new MonitorState();
	state.watch(terminalPane(native), undefined, false);
	let view = {};
	let read = async () => view;
	const notices = [];
	const client = {
		core: {
			async request(method, params) {
				assert.equal(method, "terminal.get");
				assert.equal(params.terminal, "t1");
				return native;
			},
			async localSnapshot() {
				return { terminals: [native] };
			},
		},
	};
	const reporter = new SettlementReporter(
		{
			sendMessage() {
				assert.fail("A claimed settlement must not be injected");
			},
		},
		client,
		state,
		() => {},
		{ view: () => read(), latest: async () => view.assistant },
		{ machine: "local", label: () => "local", operatorPrefix: "" },
		async () => assert.fail("The fixture terminal is live"),
	);
	const lifecycle = {
		context: { ui: { notify: (message) => notices.push(message) } },
		generation: 1,
		isCurrent: () => true,
	};
	t.after(() => reporter.stop());
	return {
		client,
		native,
		state,
		reporter,
		notices,
		lifecycle,
		set view(value) {
			view = value;
		},
		set read(value) {
			read = value;
		},
		begin(
			task = "initial task",
			expected = { after: null, turn: native.turn },
		) {
			return state.beginWork("t1", task, expected);
		},
		claim(attempt, signal = new AbortController().signal) {
			const outcome = { status: "pending" };
			reporter.claim(attempt, signal).then(
				(value) => Object.assign(outcome, { status: "resolved", value }),
				(error) => Object.assign(outcome, { status: "rejected", error }),
			);
			return outcome;
		},
		async reconcile() {
			const result = state.reconcile(snapshot());
			for (const request of result.completions)
				await reporter.report(lifecycle, request);
			await setImmediate();
			return result;
		},
		async tick(ms) {
			// Let asynchronous collection finish between controlled clock advances.
			for (let remaining = ms; remaining > 0; remaining -= 250) {
				t.mock.timers.tick(Math.min(remaining, 250));
				await setImmediate();
			}
		},
	};
}

function persisted(input = "input-1", assistant = "assistant-1") {
	return {
		input: { id: input, text: "expanded input" },
		assistant: { id: assistant, text: "finished", stopReason: "stop" },
		assistantAfterInput: true,
	};
}

test("a queued idle task survives more than eight seconds, then uses the normal persistence grace", async (t) => {
	const f = fixture(t);
	const attempt = f.begin();
	const outcome = f.claim(attempt);
	f.state.acceptWork(attempt);
	assert.equal((await f.reconcile()).completions.length, 0);
	await f.tick(10_000);
	// A directly invoked report also has to check the fresh native counter.
	await f.reporter.report(f.lifecycle, {
		record: f.state.byTerminal("t1"),
		status: "idle",
	});
	await f.tick(10_000);
	assert.equal(outcome.status, "pending");
	assert.deepEqual(f.notices, []);
	f.native.status.state = "working";
	await f.reconcile();
	f.native.status.state = "done";
	f.native.turn = 1;
	await f.reconcile();
	assert.equal(outcome.status, "pending");
	f.view = persisted();
	await f.tick(250);
	assert.equal(outcome.status, "resolved");
	assert.equal(outcome.value.reply.id, "assistant-1");
});

test("a fast task can finish before its receipt without any observed working snapshot", async (t) => {
	const f = fixture(t);
	f.native.status.state = "done";
	const attempt = f.begin();
	const outcome = f.claim(attempt);
	f.native.turn = 1;
	assert.equal((await f.reconcile()).completions.length, 0);
	f.state.acceptWork(attempt);
	await f.reconcile();
	assert.equal(outcome.status, "pending");
	f.view = persisted();
	await f.tick(250);
	assert.equal(outcome.status, "resolved");
	assert.equal(outcome.value.status, "done");
});

test("an old persistence retry cannot consume an active steer's fresh budget or steal its waiter", async (t) => {
	const f = fixture(t);
	const first = f.begin();
	const outcome = f.claim(first);
	f.state.acceptWork(first);
	f.native.status.state = "done";
	f.native.turn = 1;
	await f.reconcile();
	await f.tick(1_750);
	const update = f.begin("updated instructions");
	assert.equal(update.attemptId, first.attemptId);
	assert.equal(f.state.byTerminal("t1").activity.task, "initial task");
	assert.equal(
		f.reporter.claim(update, new AbortController().signal),
		undefined,
	);
	f.state.acceptWork(update);
	await f.reconcile();
	await f.tick(10_000);
	assert.equal(outcome.status, "pending");
	assert.deepEqual(f.notices, []);
	f.native.turn = 2;
	await f.reconcile();
	await f.tick(4_000);
	assert.equal(outcome.status, "pending");
	f.view = persisted("input-2", "assistant-2");
	await f.tick(4_000);
	assert.equal(outcome.status, "resolved");
	assert.equal(outcome.value.reply.id, "assistant-2");
});

test("a stale in-flight collection failure cannot charge a new active submission", async (t) => {
	const f = fixture(t);
	const first = f.begin();
	const outcome = f.claim(first);
	f.state.acceptWork(first);
	f.native.status.state = "done";
	f.native.turn = 1;
	let rejectRead;
	let entered;
	const reading = new Promise((resolve) => {
		entered = resolve;
	});
	f.read = () =>
		new Promise((_resolve, reject) => {
			rejectRead = reject;
			entered();
		});
	const oldReport = f.reconcile();
	await reading;
	const update = f.begin("new submission");
	f.state.acceptWork(update);
	rejectRead(new Error("old session read failed"));
	await oldReport;
	await f.tick(10_000);
	assert.equal(outcome.status, "pending");
	assert.deepEqual(f.notices, []);
});

test("rejected steering restores the exact baseline and restoration preserves it", async (t) => {
	const f = fixture(t);
	const first = f.begin();
	f.state.acceptWork(first);
	const original = f.state.byTerminal("t1").activity;
	f.native.turn = 1;
	const update = f.begin("rejected update");
	f.state.rejectWork(update);
	assert.deepEqual(f.state.byTerminal("t1").activity, original);
	assert.equal(f.state.restore(JSON.parse(JSON.stringify(f.state.list()))), 0);
	assert.deepEqual(f.state.byTerminal("t1").activity, original);
	const outcome = f.claim(first);
	f.native.turn = 0;
	f.native.status.state = "done";
	assert.equal((await f.reconcile()).completions.length, 0);
	f.native.turn = 1;
	f.view = persisted();
	await f.reconcile();
	assert.equal(outcome.status, "resolved");
});

for (const phase of ["working", "submitting"]) {
	test(`legacy ${phase} records retain supervision and metadata without inventing a turn baseline`, async (t) => {
		const f = fixture(t);
		const previous = {
			phase: "working",
			attemptId: "legacy-attempt",
			task: "original task",
			expectedUserAfter: "previous-input",
		};
		const record = {
			paneId: "t1",
			terminalId: "t1",
			scope: "persistent",
			instructions: "original instructions",
			latestInstruction: "latest instructions",
			lastAssistantId: "previous-assistant",
			name: "legacy-worker",
			activity:
				phase === "working"
					? previous
					: {
							...previous,
							phase: "submitting",
							previous,
						},
		};
		assert.deepEqual(parseMonitoredAgent(record), record);
		assert.equal(f.state.restore(JSON.parse(JSON.stringify([record]))), 0);
		assert.deepEqual(f.state.byTerminal("t1"), record);
		const outcome = f.claim({ attemptId: "legacy-attempt", terminalId: "t1" });
		f.view = persisted("previous-input", "previous-assistant");
		await f.reconcile();
		assert.equal(outcome.status, "pending");
		f.view = persisted("new-input", "new-assistant");
		await f.tick(250);
		assert.equal(outcome.status, "resolved");
		assert.equal(f.native.turn, 0);
		const settled = f.state.byTerminal("t1");
		assert.equal(settled.scope, "persistent");
		assert.equal(settled.instructions, record.instructions);
		assert.equal(settled.latestInstruction, record.latestInstruction);
		assert.equal(settled.lastAssistantId, "new-assistant");
	});
}

test("a saved turn baseline without an input baseline is invalid", () => {
	for (const phase of ["working", "submitting"]) {
		const record = {
			paneId: "t1",
			terminalId: "t1",
			scope: "persistent",
			activity: {
				phase,
				task: "task",
				attemptId: "attempt",
				expectedTurnAfter: 0,
				...(phase === "submitting"
					? { previous: { phase: "settled", status: "idle" } }
					: {}),
			},
		};
		assert.equal(parseMonitoredAgent(record), undefined);
		assert.equal(new MonitorState().restore([record]), 1);
	}
});

test("an extension reply can settle without starting another native turn", async (t) => {
	const f = fixture(t);
	f.native.status.state = "blocked";
	const attempt = f.state.beginWork("t1", "extension reply");
	const outcome = f.claim(attempt);
	f.reporter.observeReply(attempt, { extension: "fixture", id: "question-1" });
	f.state.acceptWork(attempt);
	f.native.status.state = "idle";
	await f.reconcile();
	assert.equal(outcome.status, "resolved");
	assert.equal(f.native.turn, 0);
});

test("blocked remains authoritative and aborting a wait does not cancel accepted work", async (t) => {
	const f = fixture(t);
	const attempt = f.begin();
	const abort = new AbortController();
	const outcome = f.claim(attempt, abort.signal);
	f.state.acceptWork(attempt);
	abort.abort(new Error("caller cancelled its wait"));
	await setImmediate();
	assert.equal(outcome.status, "rejected");
	assert.equal(outcome.error.message, "caller cancelled its wait");
	assert.equal(f.state.byTerminal("t1").activity.phase, "working");
	const replacement = f.claim(attempt);
	f.native.status.state = "blocked";
	await f.reconcile();
	assert.equal(replacement.status, "resolved");
	assert.equal(replacement.value.status, "blocked");
});

test("only a proven completed turn starts the bounded persistence failure window", async (t) => {
	const f = fixture(t);
	const attempt = f.begin();
	const outcome = f.claim(attempt);
	f.state.acceptWork(attempt);
	f.native.turn = 1;
	f.native.status.state = "done";
	await f.reconcile();
	await f.tick(8_000);
	assert.equal(outcome.status, "rejected");
	assert.match(
		outcome.error.message,
		/submitted input and reply were not persisted after 8 seconds$/,
	);
});

test("submission captures the fresh turn after session reading, not the stale target snapshot", async (t) => {
	const f = fixture(t);
	const panel = terminalPane(f.native);
	const runtime = {
		client: f.client,
		monitor: {
			list: () => f.state.list(),
			track: async () => {},
			async view() {
				f.native.turn = 4;
				return { input: { id: "previous-input", text: "old" } };
			},
			beginWork: (...args) => f.state.beginWork(...args),
			acceptWork: (attempt) => f.state.acceptWork(attempt),
			noteMessage: () => {},
			reconcileNow: () => f.reconcile(),
		},
	};
	await dispatchAgentWork(
		runtime,
		panel,
		"fresh task",
		false,
		new AbortController().signal,
		() => {},
		async () => {
			const activity = f.state.byTerminal("t1").activity;
			assert.equal(activity.expectedTurnAfter, 4);
			assert.equal(activity.expectedUserAfter, "previous-input");
		},
		{ expectUserMessage: true },
	);
	assert.equal(f.state.byTerminal("t1").activity.expectedTurnAfter, 4);
});

test("native turn zero is valid; missing, negative and inexact counters are rejected", () => {
	const native = { address: "t1", state: "live", labels: {}, turn: 0 };
	assert.equal(terminalPane(native).turn, 0);
	for (const turn of [undefined, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
		assert.throws(
			() => terminalPane({ ...native, turn }),
			/invalid terminal turn counter/,
		);
	}
});
