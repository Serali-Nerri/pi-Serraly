import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	registerCodexContextBriefing,
	recordCodexContextBriefings,
} from "../src/context-briefings.ts";

test("an aborted run discards briefing failures", async () => {
	const abort = new AbortController();
	abort.abort();
	const pi = eventBus();
	registerCodexContextBriefing(pi, async () => {
		abort.signal.throwIfAborted();
	});

	await assert.doesNotReject(
		recordCodexContextBriefings(pi, context(abort.signal), undefined, []),
	);
});

test("a briefing failure from an aborted run stays silent", async () => {
	const abort = new AbortController();
	abort.abort();
	const pi = eventBus();
	registerCodexContextBriefing(pi, async () => {
		throw new Error("stale context");
	});

	await assert.doesNotReject(
		recordCodexContextBriefings(pi, context(abort.signal), undefined, []),
	);
});

test("briefing failures surface while the run is live", async () => {
	const pi = eventBus();
	registerCodexContextBriefing(pi, async () => {
		throw new Error("briefing failed");
	});

	await assert.rejects(
		recordCodexContextBriefings(
			pi,
			context(new AbortController().signal),
			undefined,
			[],
		),
		/briefing failed/,
	);
});

function eventBus(): ExtensionAPI {
	const handlers = new Map<string, ((value: unknown) => void)[]>();
	return {
		events: {
			emit(channel: string, value: unknown) {
				for (const handler of handlers.get(channel) ?? []) handler(value);
			},
			on(channel: string, handler: (value: unknown) => void) {
				handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
				return () =>
					handlers.set(
						channel,
						(handlers.get(channel) ?? []).filter(
							(candidate) => candidate !== handler,
						),
					);
			},
		},
	} as unknown as ExtensionAPI;
}

function context(signal: AbortSignal): ExtensionContext {
	return { signal } as unknown as ExtensionContext;
}
