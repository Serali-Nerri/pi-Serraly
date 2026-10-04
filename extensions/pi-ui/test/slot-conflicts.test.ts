import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { harness } from "./harness.ts";
import {
	COMPACT_MODE_PATCH_KEY, COMPACT_THINKING_OWNER, GLOBAL_TOOL_RENDER_PATCH, isOwnedPatch,
	MESSAGE_DISPLAY_PATCH, TOOL_EXPANDED_BACKGROUND_PATCH, TOOL_GROUPING_PATCH_KEY,
	UI_LIFECYCLE_OWNER, NATIVE_MOUSE_OWNER, TRANSCRIPT_OWNER,
} from "../src/compat/patch-keys.ts";
import { METHOD_PIPELINE_KEY } from "../src/compat/method-pipeline.ts";

/** Every slot this module owns; a foreign value in any of them must be preserved. */
const ownershipSlots: ReadonlyArray<readonly [string, symbol]> = [
	["compact-mode", COMPACT_MODE_PATCH_KEY],
	["compact-thinking", COMPACT_THINKING_OWNER],
	["tool-render", GLOBAL_TOOL_RENDER_PATCH],
	["tool-expanded-background", TOOL_EXPANDED_BACKGROUND_PATCH],
	["message-display", MESSAGE_DISPLAY_PATCH],
	["tool-grouping", TOOL_GROUPING_PATCH_KEY],
	["lifecycle", UI_LIFECYCLE_OWNER],
	["native-mouse", NATIVE_MOUSE_OWNER],
	["transcript", TRANSCRIPT_OWNER],
];

const globalSlot = (key: symbol) => (globalThis as Record<PropertyKey, unknown>)[key];

for (const [label, key] of ownershipSlots) {
	test(`a foreign ${label} owner is never adopted, replaced or disposed`, async () => {
		let disposed = 0;
		const foreign = {
			version: 2,
			active: true,
			dispose() { disposed++; },
			shutdown() { disposed++; },
			stop() { disposed++; },
			prototype: ToolExecutionComponent.prototype,
			installed: {},
			downstream: {},
		};
		const previous = globalSlot(key);
		let h: Awaited<ReturnType<typeof harness>> | undefined;
		try {
			(globalThis as Record<PropertyKey, unknown>)[key] = foreign;
			h = await harness();
			assert.equal(h.notices.length, 1, "one notification per session");
			assert.equal(h.notices[0]!.level, "warning");
			assert.match(h.notices[0]!.message, new RegExp(key.description ?? String(key)));
			assert.equal(globalSlot(key), foreign, "the foreign slot keeps its value after startup");
			assert.equal(disposed, 0, "no foreign disposer runs");
			await h.close();
			h = undefined;
			assert.equal(globalSlot(key), foreign, "the foreign slot keeps its value after shutdown");
			assert.equal(disposed, 0, "shutdown never calls a foreign disposer");
		} finally {
			await h?.close();
			if (previous === undefined) delete (globalThis as Record<PropertyKey, unknown>)[key];
			else (globalThis as Record<PropertyKey, unknown>)[key] = previous;
		}
	});
}

test("malformed slot values are reported by name and left untouched", async () => {
	const key = GLOBAL_TOOL_RENDER_PATCH;
	const previous = globalSlot(key);
	const callRenderer = (ToolExecutionComponent.prototype as any).getCallRenderer;
	let h: Awaited<ReturnType<typeof harness>> | undefined;
	try {
		(globalThis as Record<PropertyKey, unknown>)[key] = "not-a-patch";
		h = await harness();
		assert.equal(h.notices.length, 1);
		assert.match(h.notices[0]!.message, /global-tool-render-patch/);
		assert.equal(globalSlot(key), "not-a-patch");
		assert.equal((ToolExecutionComponent.prototype as any).getCallRenderer, callRenderer, "the tool domain stays native");
		assert.equal(isOwnedPatch(globalSlot(key)), false);
	} finally {
		await h?.close();
		if (previous === undefined) delete (globalThis as Record<PropertyKey, unknown>)[key];
		else (globalThis as Record<PropertyKey, unknown>)[key] = previous;
	}
});

test("an accessor slot is detected from its descriptor without executing the getter", async () => {
	const key = MESSAGE_DISPLAY_PATCH;
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
	let getterCalls = 0;
	let h: Awaited<ReturnType<typeof harness>> | undefined;
	try {
		Object.defineProperty(globalThis, key, {
			configurable: true,
			get() { getterCalls++; return undefined; },
		});
		h = await harness();
		assert.equal(h.notices.length, 1);
		assert.match(h.notices[0]!.message, /message-display-patch/);
		assert.equal(getterCalls, 0, "the preflight never executes an external getter");
	} finally {
		await h?.close();
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else delete (globalThis as Record<PropertyKey, unknown>)[key];
	}
});

test("a foreign prototype pipeline slot is preserved and refuses that domain", async () => {
	const proto = ToolExecutionComponent.prototype as any;
	const foreign = new Map();
	const previousDescriptor = Object.getOwnPropertyDescriptor(proto, METHOD_PIPELINE_KEY);
	const render = proto.render, updateDisplay = proto.updateDisplay;
	let h: Awaited<ReturnType<typeof harness>> | undefined;
	try {
		Object.defineProperty(proto, METHOD_PIPELINE_KEY, { value: foreign, configurable: true });
		h = await harness();
		assert.equal(h.notices.length, 1);
		assert.match(h.notices[0]!.message, /method-pipelines/);
		assert.equal(proto[METHOD_PIPELINE_KEY], foreign, "the foreign pipeline map is never replaced");
		assert.equal(proto.render, render, "no method is patched around a foreign pipeline");
		assert.equal(proto.updateDisplay, updateDisplay);
	} finally {
		await h?.close();
		if (previousDescriptor) Object.defineProperty(proto, METHOD_PIPELINE_KEY, previousDescriptor);
		else delete proto[METHOD_PIPELINE_KEY];
	}
});

test("two foreign slots still produce a single notification", async () => {
	const slots = [GLOBAL_TOOL_RENDER_PATCH, TOOL_GROUPING_PATCH_KEY];
	const previous = slots.map(globalSlot);
	let h: Awaited<ReturnType<typeof harness>> | undefined;
	try {
		for (const key of slots) (globalThis as Record<PropertyKey, unknown>)[key] = { dispose() {} };
		h = await harness();
		assert.equal(h.notices.length, 1, "conflicts are reported once per session");
	} finally {
		await h?.close();
		slots.forEach((key, index) => {
			if (previous[index] === undefined) delete (globalThis as Record<PropertyKey, unknown>)[key];
			else (globalThis as Record<PropertyKey, unknown>)[key] = previous[index];
		});
	}
});

test("own patches are branded, hand over between generations and are removed on shutdown", async () => {
	const key = GLOBAL_TOOL_RENDER_PATCH;
	const first = await harness();
	try {
		assert.equal(isOwnedPatch(globalSlot(key)), true, "an installed owner carries the brand");
		assert.equal(isOwnedPatch(globalSlot(COMPACT_MODE_PATCH_KEY)), true);
		assert.equal(isOwnedPatch((AssistantMessageComponent.prototype as any)[METHOD_PIPELINE_KEY]), true);
	} finally { await first.close(); }
	assert.equal(globalSlot(key), undefined, "shutdown removes its own slot");
	const second = await harness();
	try {
		assert.equal(isOwnedPatch(globalSlot(key)), true, "a new generation installs its own owner");
	} finally { await second.close(); }
});

test("an externally replaced wrapper or slot survives shutdown", async () => {
	const key = GLOBAL_TOOL_RENDER_PATCH;
	const proto = ToolExecutionComponent.prototype as any;
	const h = await harness();
	const native = proto.getCallRenderer;
	let foreignDisposed = 0;
	try {
		const foreign = () => "foreign";
		const foreignSlot = { dispose() { foreignDisposed++; } };
		proto.getCallRenderer = foreign;
		(globalThis as Record<PropertyKey, unknown>)[key] = foreignSlot;
		await h.close();
		assert.equal(proto.getCallRenderer, foreign, "an external wrapper is not unwound");
		assert.equal(globalSlot(key), foreignSlot, "the external slot value stays");
		assert.equal(foreignDisposed, 0, "an external disposer is never called");
	} finally {
		delete (globalThis as Record<PropertyKey, unknown>)[key];
		proto.getCallRenderer = native;
	}
});
