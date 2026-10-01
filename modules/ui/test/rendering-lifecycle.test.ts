import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { getToolMouseTui } from "../src/overlays/mouse-state.ts";
import { harness } from "./harness.ts";

for (const mode of ["on", "compact", "off"] as const) {
	test(`full ${mode} lifecycle restores the assistant prototype across replacements`, async () => {
		const prototype = AssistantMessageComponent.prototype;
		const original = prototype.updateContent;
		try {
			for (let cycle = 0; cycle < 3; cycle++) {
				const h = await harness({ mode });
				try {
					assert.notEqual(prototype.updateContent, original);
				} finally {
					await h.close();
				}
				assert.equal(prototype.updateContent, original, `shutdown ${cycle + 1} restores the native method`);
			}
		} finally {
			prototype.updateContent = original;
		}
	});
}

test("replacement owner disposes outer rendering before replacing thinking", async () => {
	const prototype = AssistantMessageComponent.prototype;
	const original = prototype.updateContent;
	const first = await harness();
	let second: Awaited<ReturnType<typeof harness>> | undefined;
	try {
		second = await harness({ mode: "compact" });
		const replacement = prototype.updateContent;
		await first.close();
		assert.equal(prototype.updateContent, replacement, "late old shutdown preserves the new owner");
		await second.close();
		assert.equal(prototype.updateContent, original, "replacement never captures the old thinking wrapper");
	} finally {
		await second?.close();
		await first.close();
		prototype.updateContent = original;
	}
});

test("shutdown preserves foreign wrappers and makes captured rendering patches inert", async () => {
	const prototype = AssistantMessageComponent.prototype;
	const original = prototype.updateContent;
	const calls: unknown[][] = [];
	prototype.updateContent = function (...args: unknown[]) { calls.push(args); };
	const h = await harness({ mode: "compact" });
	try {
		const captured = prototype.updateContent;
		const foreign = function (this: any, ...args: Parameters<typeof captured>) { return captured.apply(this, args); };
		prototype.updateContent = foreign;
		await h.close();
		assert.equal(prototype.updateContent, foreign);
		const message: AssistantMessage = {
			timestamp: 1, content: [], role: "assistant", api: "openai-responses", provider: "openai", model: "test",
			stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		const component = { hideThinkingBlock: true };
		prototype.updateContent.call(component, message, false);
		assert.deepEqual(calls, [[message, false]], "stopped thinking delegates without accessing cleared state");
		assert.deepEqual(component, { hideThinkingBlock: true }, "stopped wrappers do not retain or mutate components");
	} finally {
		await h.close();
		prototype.updateContent = original;
	}
});

test("obsolete bridge renders cannot read stale TUI state or replace the current reference", async () => {
	const first = await harness();
	const oldBridge = first.widgets.get("pi-ui-bridge")!;
	const second = await harness();
	try {
		Object.defineProperty(first.tui, "mode", { configurable: true, get() { throw new Error("stale TUI"); } });
		assert.doesNotThrow(() => oldBridge.render(80));
		assert.equal(getToolMouseTui(), second.tui);
	} finally {
		delete first.tui.mode;
		await first.close();
		await second.close();
	}
});
