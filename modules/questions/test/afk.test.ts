import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createAskUserQuestionDialog } from "../src/dialog.ts";
import type { DialogOutcome } from "../src/result.ts";
import { fakeTui, keys, testQuestion, testQuestions, testTheme } from "./helpers.ts";

/** Use the documented external names, never names derived from production constants. */
function openWithAfk(t: TestContext, questions = [testQuestion()]) {
	t.mock.timers.enable({ apis: ["setInterval"], now: 0 });
	const clockSetInterval = globalThis.setInterval;
	const clockClearInterval = globalThis.clearInterval;
	const ownedIntervals = new Set<Parameters<typeof clearInterval>[0]>();
	// Forward to the deterministic clock while observing the dialog's resource ownership.
	// A finished guard can suppress callbacks without actually removing a leaked interval.
	t.mock.method(globalThis, "setInterval", (...args: Parameters<typeof setInterval>) => {
		const interval = clockSetInterval(...args);
		ownedIntervals.add(interval);
		return interval;
	});
	t.mock.method(globalThis, "clearInterval", (interval: Parameters<typeof clearInterval>[0]) => {
		ownedIntervals.delete(interval);
		clockClearInterval(interval);
	});

	const envNames = ["PI_ASK_USER_QUESTION_AFK_MS", "PI_ASK_USER_QUESTION_AFK_COUNTDOWN_MS"];
	const saved = envNames.map((name) => process.env[name]);
	process.env.PI_ASK_USER_QUESTION_AFK_MS = "3000";
	process.env.PI_ASK_USER_QUESTION_AFK_COUNTDOWN_MS = "2000";
	t.after(() => {
		for (const [index, name] of envNames.entries()) {
			if (saved[index] === undefined) delete process.env[name];
			else process.env[name] = saved[index];
		}
	});
	const outcomes: DialogOutcome[] = [];
	const dialog = createAskUserQuestionDialog({
		questions,
		tui: fakeTui(),
		theme: testTheme(),
		done: (outcome) => outcomes.push(outcome),
	});
	t.after(() => dialog.dispose());
	return {
		dialog,
		outcomes,
		tick: (ms: number) => t.mock.timers.tick(ms),
		ownedIntervalCount: () => ownedIntervals.size,
	};
}

// Breaks if the documented timeout name stops working, payload collection is lost,
// or finish leaves an interval registered even though it suppresses further outcomes.
test("AFK preserves already answered questions and selected previews at timeout", (t) => {
	const questions = testQuestions();
	questions[0]!.options[0]!.preview = "SELECT 1;";
	const { dialog, outcomes, tick, ownedIntervalCount } = openWithAfk(t, questions);
	dialog.handleInput(keys.enter); // first answered, second still unanswered
	tick(2000);
	assert.equal(outcomes.length, 0);
	assert.match(dialog.render(80).join("\n"), /auto-continue in 1s/);
	tick(1000);
	assert.equal(ownedIntervalCount(), 0, "AFK completion must release its interval immediately");
	assert.deepEqual(outcomes, [{
		kind: "afk", afkTimeoutMs: 3000,
		records: [{ labels: ["SQLite (Recommended)"], custom: undefined, preview: "SELECT 1;" }, { labels: [] }],
		answers: { "Which database should we use?": "SQLite (Recommended)" },
		annotations: { "Which database should we use?": { preview: "SELECT 1;" } },
	}]);
	tick(10_000);
	assert.equal(outcomes.length, 1);
});

// Renaming/ignoring the documented countdown variable would use the 30s default
// and show the countdown too early; ignoring the threshold would show it too late.
test("PI_ASK_USER_QUESTION_AFK_COUNTDOWN_MS controls when the countdown appears", (t) => {
	const { dialog, outcomes, tick } = openWithAfk(t);
	assert.doesNotMatch(dialog.render(80).join("\n"), /auto-continue/);
	tick(1000);
	assert.match(dialog.render(80).join("\n"), /auto-continue in 2s/);
	assert.deepEqual(outcomes, []);
});

test("any key restarts the AFK countdown", (t) => {
	const { dialog, outcomes, tick } = openWithAfk(t);
	tick(2000);
	dialog.handleInput(keys.down);
	tick(2000);
	assert.equal(outcomes.length, 0);
	tick(1000);
	assert.equal(outcomes[0]?.kind, "afk");
});

test("manual submission releases the AFK interval immediately", (t) => {
	const { dialog, outcomes, tick, ownedIntervalCount } = openWithAfk(t);
	assert.equal(ownedIntervalCount(), 1, "an AFK interval must be registered before submission");
	dialog.handleInput(keys.enter);
	assert.equal(ownedIntervalCount(), 0, "submission must not rely on the finished guard or later disposal");
	assert.deepEqual(outcomes, [{
		kind: "submitted",
		records: [{ labels: ["SQLite (Recommended)"], custom: undefined, preview: undefined }],
		answers: { "Which database should we use?": "SQLite (Recommended)" },
	}]);
	tick(10_000);
	assert.equal(outcomes.length, 1);
});

test("disposal stops AFK auto-continue without synthesizing an answer", (t) => {
	const { dialog, outcomes, tick, ownedIntervalCount } = openWithAfk(t);
	assert.equal(ownedIntervalCount(), 1, "an AFK interval must be registered before disposal");
	dialog.dispose();
	assert.equal(ownedIntervalCount(), 0, "disposal must release its interval immediately");
	dialog.dispose();
	tick(10_000);
	assert.deepEqual(outcomes, []);
});

test("cancellation completes only once even when the AFK deadline passes", (t) => {
	const { dialog, outcomes, tick, ownedIntervalCount } = openWithAfk(t);
	assert.equal(ownedIntervalCount(), 1, "an AFK interval must be registered before cancellation");
	dialog.handleInput(keys.escape);
	assert.equal(ownedIntervalCount(), 0, "cancellation must release its interval immediately");
	assert.deepEqual(outcomes, [{ kind: "cancelled" }]);
	tick(10_000);
	assert.deepEqual(outcomes, [{ kind: "cancelled" }]);
});
