import assert from "node:assert/strict";
import test from "node:test";
import { UiScheduler } from "../src/scheduler.ts";

test("one UI scheduler coalesces keyed jobs, repeats at separate rates and stops", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100 });
	const scheduler = new UiScheduler();
	const calls: string[] = [];
	const renders: boolean[] = [];
	scheduler.start((force) => renders.push(Boolean(force)));
	scheduler.schedule("thinking", 10, () => calls.push("thinking"), true);
	scheduler.schedule("footer", 25, () => calls.push("footer"), true);
	scheduler.schedule("rebuild", 0, () => calls.push("stale"));
	scheduler.schedule("rebuild", 0, () => calls.push("rebuild"));
	t.mock.timers.tick(0);
	assert.deepEqual(calls, ["rebuild"]);
	t.mock.timers.tick(10);
	assert.deepEqual(calls, ["rebuild", "thinking"]);
	t.mock.timers.tick(15);
	assert.ok(calls.includes("footer"));
	scheduler.request(true);
	assert.deepEqual(renders, [true]);
	scheduler.dispose();
	const count = calls.length;
	t.mock.timers.tick(1000);
	assert.equal(calls.length, count);
	assert.equal(scheduler.pendingJobs, 0);
	scheduler.schedule("headless", 1, () => calls.push("bad"));
	t.mock.timers.tick(1);
	assert.equal(calls.length, count);
});

test("stale cancellation cannot delete a replacement and callback failure is isolated", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	const scheduler = new UiScheduler();
	const errors: unknown[] = [];
	const calls: string[] = [];
	scheduler.start(() => {}, (error) => errors.push(error));
	const staleCancel = scheduler.schedule("job", 1, () => calls.push("stale"));
	scheduler.schedule("job", 1, () => calls.push("new"));
	staleCancel();
	scheduler.schedule("failure", 0, () => { throw new Error("expected"); });
	t.mock.timers.tick(0);
	t.mock.timers.tick(1);
	assert.deepEqual(calls, ["new"]);
	assert.equal(errors.length, 1);
	assert.equal(scheduler.pendingJobs, 0);
	scheduler.dispose();
});
