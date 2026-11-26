import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CODEX_CONVERSION_CONFIG } from "../src/adapter/activation/config.ts";
import { resolveAdapterRuntimePlan } from "../src/adapter/activation/runtime-plan.ts";

test("Codex and configured keeps eligible models on the full adapter", () => {
	const config = structuredClone(DEFAULT_CODEX_CONVERSION_CONFIG);
	config.executionMode = "ts";
	config.scope.allProviders = "off";
	config.scope.additionalProviders = ["configured-proxy"];

	for (const model of [
		modelDescriptor("openai-codex", "openai-codex-responses", "gpt-6.2-sol"),
		modelDescriptor("configured-proxy", "openai-responses", "gpt-4.1"),
	]) {
		const plan = resolveAdapterRuntimePlan({ model }, config);
		assert.deepEqual(
			{ kind: plan.kind, toolNames: plan.toolNames },
			{ kind: "ts", toolNames: ["exec", "wait", "notebook"] },
		);
	}

	const ordinaryPlan = resolveAdapterRuntimePlan(
		{
			model: modelDescriptor(
				"anthropic",
				"anthropic-messages",
				"claude-sonnet",
			),
		},
		config,
	);
	assert.deepEqual(
		{ kind: ordinaryPlan.kind, toolNames: ordinaryPlan.toolNames },
		{ kind: "inactive", toolNames: [] },
	);
});

function modelDescriptor(
	provider: string,
	api: string,
	id: string,
): ExtensionContext["model"] {
	return {
		provider,
		api,
		id,
		baseUrl: "https://example.test",
	} as unknown as ExtensionContext["model"];
}
