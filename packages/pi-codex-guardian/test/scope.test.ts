import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter, getEventListeners } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { type Decision, RuleMatcher } from "../src/scope.js";

type Policy = Parameters<RuleMatcher["decide"]>[2];
const CONDITIONAL_REVIEW: Policy = {
	defaultAction: "pass",
	rules: [{ tool: "run", args: { command: "." }, action: "review" }],
};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

// Only the OS process boundary is substituted; rule selection and scheduling
// continue through the public matcher API.
class MatchProcess extends EventEmitter {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly kills: (NodeJS.Signals | number | undefined)[] = [];
	input = "";
	closed = false;

	constructor() {
		super();
		this.stdin.on("data", (chunk: Buffer) => {
			this.input += chunk.toString("utf8");
		});
	}

	kill(signal?: NodeJS.Signals | number): boolean {
		this.kills.push(signal);
		return true;
	}

	close(output = "review", code: number | null = 0): void {
		if (this.closed) return;
		this.closed = true;
		this.stdout.write(output);
		this.emit("close", code, null);
		this.stdin.destroy();
		this.stdout.destroy();
	}
}

function mockProcesses(t: TestContext) {
	const children: MatchProcess[] = [];
	const controllers: AbortController[] = [];
	const state = {
		active: 0,
		peak: 0,
		spawnError: undefined as Error | undefined,
	};
	t.mock.method(childProcess, "spawn", (() => {
		if (state.spawnError) {
			const error = state.spawnError;
			state.spawnError = undefined;
			throw error;
		}
		const child = new MatchProcess();
		children.push(child);
		state.active++;
		state.peak = Math.max(state.peak, state.active);
		child.once("close", () => state.active--);
		return child as unknown as ReturnType<typeof childProcess.spawn>;
	}) as typeof childProcess.spawn);
	syncBuiltinESMExports();
	t.after(async () => {
		for (const controller of controllers) controller.abort();
		for (const child of children) child.close("", null);
		await flush();
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	return {
		children,
		state,
		call(
			matcher: RuleMatcher,
			command = "run",
			controller = new AbortController(),
		): Promise<Decision> {
			controllers.push(controller);
			return Promise.resolve(
				matcher.decide(
					"run",
					{ command },
					CONDITIONAL_REVIEW,
					controller.signal,
				),
			);
		},
	};
}

test("known review prunes redundant regexes and their argument budget", async () => {
	for (const defaultAction of ["review", "pass"] as const) {
		const policy: Policy = {
			defaultAction,
			rules: [
				{ tool: "run", args: { text: "(a+)+$" }, action: "review" },
				{
					tool: "run",
					args: { text: ".", absent: "." },
					action: "block",
				},
				{ tool: "other", args: { text: "." }, action: "block" },
				...(defaultAction === "pass"
					? [{ tool: "run", args: {}, action: "review" as const }]
					: []),
			],
		};
		const result = new RuleMatcher().decide(
			"run",
			{ text: `${"a".repeat(2 * 1024 * 1024)}!` },
			policy,
			new AbortController().signal,
		);
		assert.equal(await result, "review");
		assert.equal(typeof result, "string", "no regex process is needed");
	}
});

test("unconditional block wins before regex matching or argument limits", () => {
	assert.equal(
		new RuleMatcher().decide(
			"run",
			{ command: `${"a".repeat(2 * 1024 * 1024)}!` },
			{
				defaultAction: "review",
				rules: [
					{ tool: "run", args: { command: "(a+)+$" }, action: "block" },
					{ tool: "run", args: {}, action: "review" },
					{ tool: "run", args: {}, action: "block" },
				],
			},
			new AbortController().signal,
		),
		"block",
	);
});

test("known review still evaluates conditional blocks and budgets only live candidates", async () => {
	for (const defaultAction of ["review", "pass"] as const) {
		const matcher = new RuleMatcher();
		const policy: Policy = {
			defaultAction,
			rules: [
				{ tool: "run", args: { text: "(a+)+$" }, action: "review" },
				{ tool: "run", args: { command: "^deny$" }, action: "block" },
				...(defaultAction === "pass"
					? [{ tool: "run", args: {}, action: "review" as const }]
					: []),
			],
		};
		for (const [command, expected] of [
			["deny", "block"],
			["allow", "review"],
		]) {
			assert.equal(
				await matcher.decide(
					"run",
					{ command, text: `${"a".repeat(2 * 1024 * 1024)}!` },
					policy,
					new AbortController().signal,
				),
				expected,
			);
		}
		assert.throws(
			() =>
				matcher.decide(
					"run",
					{ command: "x".repeat(1024 * 1024 + 1) },
					policy,
					new AbortController().signal,
				),
			/exceeds 1 MiB/,
		);
	}
});

test("rules-only conditional review matches strings and passes unmatched calls", async () => {
	const matcher = new RuleMatcher();
	const policy: Policy = {
		defaultAction: "pass",
		rules: [{ tool: "run", args: { command: "^review$" }, action: "review" }],
	};
	for (const [tool, input, expected] of [
		["run", { command: "review" }, "review"],
		["run", { command: "pass" }, "pass"],
		["other", { command: "review" }, "pass"],
		["run", { command: 123 }, "pass"],
		["run", Object.create({ command: "review" }) as unknown, "pass"],
		["run", undefined, "pass"],
	] as const) {
		assert.equal(
			await matcher.decide(tool, input, policy, new AbortController().signal),
			expected,
		);
	}
});

test("blocks run before reviews and the first matching review stops evaluation", async () => {
	const matcher = new RuleMatcher();
	const input = { command: `${"a".repeat(64)}!`, tag: "match" };
	const slowReview = {
		tool: "run",
		args: { command: "(a+)+$" },
		action: "review" as const,
	};
	assert.equal(
		await matcher.decide(
			"run",
			input,
			{
				defaultAction: "pass",
				rules: [
					slowReview,
					{ tool: "run", args: { tag: "^match$" }, action: "block" },
				],
			},
			new AbortController().signal,
		),
		"block",
	);
	assert.equal(
		await matcher.decide(
			"run",
			input,
			{
				defaultAction: "pass",
				rules: [
					{ tool: "run", args: { tag: "^match$" }, action: "review" },
					slowReview,
				],
			},
			new AbortController().signal,
		),
		"review",
	);
});

test(
	"necessary pathological regexes time out in isolation and leave the matcher usable",
	{
		timeout: 5000,
	},
	async () => {
		const matcher = new RuleMatcher();
		await assert.rejects(
			Promise.resolve(
				matcher.decide(
					"run",
					{ command: `${"a".repeat(64)}!` },
					{
						defaultAction: "review",
						rules: [
							{ tool: "run", args: { command: "(a+)+$" }, action: "block" },
						],
					},
					new AbortController().signal,
				),
			),
			/Argument matching timed out/,
		);
		assert.equal(
			await matcher.decide(
				"run",
				{ command: "ok" },
				CONDITIONAL_REVIEW,
				new AbortController().signal,
			),
			"review",
		);
	},
);

test(
	"64 concurrent requests use at most two processes and start in FIFO order",
	{
		timeout: 5000,
	},
	async (t) => {
		const processes = mockProcesses(t);
		const matcher = new RuleMatcher();
		const requests = Array.from({ length: 64 }, (_, index) =>
			processes.call(matcher, `request-${index}`),
		);
		assert.equal(processes.children.length, 2);
		for (let index = 0; index < requests.length; index++) {
			const child = processes.children[index];
			assert(child);
			const payload = JSON.parse(child.input) as {
				rules: { args: [string, string][] }[];
			};
			assert.equal(payload.rules[0]?.args[0]?.[1], `request-${index}`);
			child.close();
			await flush();
		}
		assert.deepEqual(
			await Promise.all(requests),
			Array<Decision>(64).fill("review"),
		);
		assert.equal(processes.state.peak, 2);
		assert.equal(processes.state.active, 0);
	},
);

test("the two-process limit belongs to each matcher instance", async (t) => {
	const processes = mockProcesses(t);
	const matchers = [new RuleMatcher(), new RuleMatcher()];
	const requests = matchers.flatMap((matcher) => [
		processes.call(matcher),
		processes.call(matcher),
	]);
	assert.equal(processes.children.length, 4);
	for (const child of processes.children) child.close();
	assert.deepEqual(await Promise.all(requests), [
		"review",
		"review",
		"review",
		"review",
	]);
});

test("queue waiting does not consume the one-second execution budget", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const processes = mockProcesses(t);
	const matcher = new RuleMatcher();
	const first = assert.rejects(processes.call(matcher), /timed out/);
	const second = assert.rejects(processes.call(matcher), /timed out/);
	const queued = processes.call(matcher);
	t.mock.timers.tick(1200);
	assert.equal(
		processes.children.length,
		2,
		"kill alone must not release a slot",
	);
	for (const child of processes.children)
		assert.deepEqual(child.kills, ["SIGKILL"]);
	processes.children[0]?.close("", null);
	await first;
	const next = processes.children[2];
	assert(next);
	t.mock.timers.tick(999);
	assert.deepEqual(
		next.kills,
		[],
		"queued request gets a fresh execution budget",
	);
	next.close();
	assert.equal(await queued, "review");
	processes.children[1]?.close("", null);
	await second;
	t.mock.timers.tick(2000);
	assert.deepEqual(next.kills, [], "successful close clears the deadline");
});

test("queued cancellation never spawns; active cancellation holds its slot until close", async (t) => {
	const processes = mockProcesses(t);
	const matcher = new RuleMatcher();
	const controllers = Array.from({ length: 4 }, () => new AbortController());
	const first = assert.rejects(
		processes.call(matcher, "first", controllers[0]),
		/cancelled/,
	);
	const second = processes.call(matcher, "second", controllers[1]);
	const cancelled = assert.rejects(
		processes.call(matcher, "cancelled", controllers[2]),
		/cancelled/,
	);
	const next = processes.call(matcher, "next", controllers[3]);
	controllers[2]?.abort();
	await cancelled;
	controllers[0]?.abort();
	assert.equal(processes.children.length, 2);
	assert.deepEqual(processes.children[0]?.kills, ["SIGKILL"]);
	processes.children[0]?.close("", null);
	await first;
	assert.equal(processes.children.length, 3);
	assert(processes.children[2]?.input.includes("next"));
	for (const child of processes.children) child.close();
	assert.deepEqual(await Promise.all([second, next]), ["review", "review"]);
	for (const controller of controllers)
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	const before = processes.children.length;
	assert.throws(
		() =>
			matcher.decide(
				"run",
				{ command: "run" },
				CONDITIONAL_REVIEW,
				controllers[0]!.signal,
			),
		{ name: "AbortError" },
	);
	assert.equal(processes.children.length, before);
});

test("process and stream failures release slots only on close", async (t) => {
	const processes = mockProcesses(t);
	const failures: {
		fail: (child: MatchProcess) => void;
		output: string;
		code: number | null;
		error: RegExp;
	}[] = [
		{
			fail: (child) => child.emit("error", new Error("spawn failure")),
			output: "",
			code: null,
			error: /Node argument matcher unavailable/,
		},
		{
			fail: (child) => child.stdin.emit("error", new Error("write failure")),
			output: "",
			code: null,
			error: /Argument matching failed/,
		},
		{
			fail: (child) => child.stdout.emit("error", new Error("read failure")),
			output: "",
			code: null,
			error: /Argument matching failed/,
		},
		{
			fail: (child) => child.stdout.write("x".repeat(17)),
			output: "",
			code: null,
			error: /Argument matching failed/,
		},
		{
			fail: () => {},
			output: "invalid",
			code: 0,
			error: /Argument matching failed/,
		},
		{
			fail: () => {},
			output: "review",
			code: 1,
			error: /Argument matching failed/,
		},
	];
	for (const failure of failures) {
		const matcher = new RuleMatcher();
		const offset = processes.children.length;
		const failed = assert.rejects(processes.call(matcher), failure.error);
		const second = processes.call(matcher);
		const queued = processes.call(matcher);
		const child = processes.children[offset];
		assert(child);
		failure.fail(child);
		await flush();
		assert.equal(processes.children.length, offset + 2);
		child.close(failure.output, failure.code);
		await failed;
		assert.equal(processes.children.length, offset + 3);
		processes.children[offset + 1]?.close();
		processes.children[offset + 2]?.close();
		assert.deepEqual(await Promise.all([second, queued]), ["review", "review"]);
		assert.equal(processes.state.active, 0);
	}
});

test("synchronous spawn failure does not strand queued work", async (t) => {
	const processes = mockProcesses(t);
	const matcher = new RuleMatcher();
	processes.state.spawnError = new Error("spawn failed synchronously");
	const failed = assert.rejects(
		processes.call(matcher),
		/spawn failed synchronously/,
	);
	const requests = [
		processes.call(matcher),
		processes.call(matcher),
		processes.call(matcher),
	];
	await failed;
	assert.equal(processes.children.length, 2);
	processes.children[0]?.close();
	await flush();
	assert.equal(processes.children.length, 3);
	for (const child of processes.children) child.close();
	assert.deepEqual(await Promise.all(requests), ["review", "review", "review"]);
	assert.equal(processes.state.peak, 2);
});
