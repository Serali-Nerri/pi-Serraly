import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { recordNotebookStatus } from "../src/adapter/notebook-status.ts";

test("an aborted run records no notebook status", async () => {
	const abort = new AbortController();
	abort.abort();
	const { pi, entries } = recording();
	const recorded = await recordNotebookStatus(pi, context(abort.signal), { notebookStatusMessageId: undefined }, [], {
		notebookStatus: async () => { abort.signal.throwIfAborted(); throw new Error("unreachable"); },
	}, "notebook");

	assert.equal(recorded, false);
	assert.deepEqual(entries, []);
});

test("a live run still reports an unavailable status", async () => {
	const { pi, entries } = recording();
	const recorded = await recordNotebookStatus(pi, context(new AbortController().signal), { notebookStatusMessageId: undefined }, [], {
		notebookStatus: async () => { throw new Error("kernel offline"); },
	}, "notebook");

	assert.equal(recorded, true);
	assert.equal(entries.length, 1);
});

function recording(): { pi: Pick<ExtensionAPI, "appendEntry">; entries: unknown[] } {
	const entries: unknown[] = [];
	return {
		pi: { appendEntry: (customType: string, data?: unknown) => { entries.push({ customType, data }); } },
		entries,
	};
}

function context(signal: AbortSignal): ExtensionContext {
	return { signal } as unknown as ExtensionContext;
}
