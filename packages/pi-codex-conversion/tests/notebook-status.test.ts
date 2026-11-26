import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { recordBindingStatus } from "../src/adapter/binding-status.ts";

test("a live run still reports an unavailable status", async () => {
	const entries: unknown[] = [];
	const pi: Pick<ExtensionAPI, "appendEntry"> = {
		appendEntry: (customType, data) => {
			entries.push({ customType, data });
		},
	};
	const ctx = { signal: new AbortController().signal } as ExtensionContext;
	const recorded = await recordBindingStatus(
		pi,
		ctx,
		{ bindingStatus: undefined },
		"ts",
		[],
		{
			notebookStatus: async () => {
				throw new Error("kernel offline");
			},
			vmBindingStatus: async () => {
				throw new Error("vm offline");
			},
		},
	);

	assert.equal(recorded, true);
	assert.equal(entries.length, 1);
});

test("an aborted run discards notebook startup status failures", async () => {
	const entries: unknown[] = [];
	const pi: Pick<ExtensionAPI, "appendEntry"> = {
		appendEntry: (customType, data) => {
			entries.push({ customType, data });
		},
	};
	const controller = new AbortController();
	const recorded = await recordBindingStatus(
		pi,
		{ signal: controller.signal } as ExtensionContext,
		{ bindingStatus: undefined },
		"ts",
		[],
		{
			notebookStatus: async () => {
				controller.abort(new Error("This operation was aborted"));
				throw controller.signal.reason;
			},
			vmBindingStatus: async () => {
				throw new Error("vm offline");
			},
		},
	);

	assert.equal(recorded, false);
	assert.equal(entries.length, 0);
});
