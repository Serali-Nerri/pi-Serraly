import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { recordNotebookStatus } from "../src/adapter/notebook-status.ts";

test("a live run still reports an unavailable status", async () => {
	const entries: unknown[] = [];
	const pi: Pick<ExtensionAPI, "appendEntry"> = {
		appendEntry: (customType, data) => { entries.push({ customType, data }); },
	};
	const ctx = { signal: new AbortController().signal } as ExtensionContext;
	const recorded = await recordNotebookStatus(pi, ctx, { notebookStatusMessageId: undefined }, [], {
		notebookStatus: async () => { throw new Error("kernel offline"); },
	}, "notebook");

	assert.equal(recorded, true);
	assert.equal(entries.length, 1);
});
