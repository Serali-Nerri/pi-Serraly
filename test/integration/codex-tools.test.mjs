import test from "node:test";
import { runIsolated } from "../../scripts/lib/workspace.mjs";

test("plain tree navigation keeps disabled PCC tools out of Code model requests", {
	timeout: 120_000,
}, async () => {
	await runIsolated(process.execPath, ["test/integration/fixtures/codex-tools.mjs", "code"], {
		timeoutMs: 90_000,
	});
});

test("Code tree navigation preserves eligible nested notes and respects disabled window requests", {
	timeout: 120_000,
}, async () => {
	await runIsolated(process.execPath, ["test/integration/fixtures/codex-tools.mjs", "code", JSON.stringify({
		config: { compaction: { continuity: "notes", newWindowRequests: "off" } },
		expected: ["exec", "history", "notes", "wait"],
	})], { timeoutMs: 90_000 });
});

test("Code integrations cannot admit disabled PCC tools or discard unrelated tools", {
	timeout: 120_000,
}, async () => {
	await runIsolated(process.execPath, ["test/integration/fixtures/codex-tools.mjs", "code", JSON.stringify({
		integration: true,
		expectedActive: ["exec", "fixture_lookup", "wait"],
	})], { timeoutMs: 90_000 });
});

test("Code tree navigation respects external Notes ownership and its disabled window requests", {
	timeout: 120_000,
}, async () => {
	await runIsolated(process.execPath, ["test/integration/fixtures/codex-tools.mjs", "code", JSON.stringify({
		externalNotes: true,
		expected: ["exec", "history", "notes", "wait"],
	})], { timeoutMs: 90_000 });
});

test("unchanged Code sync does not force a manually hidden allowed tool back on", {
	timeout: 120_000,
}, async () => {
	await runIsolated(process.execPath, ["test/integration/fixtures/codex-tools.mjs", "code", JSON.stringify({
		config: { compaction: { continuity: "notes" } },
		hide: "new_context", skipNavigation: true,
		expected: ["exec", "history", "notes", "wait"],
	})], { timeoutMs: 90_000 });
});

test("disabled auto reasoning is removed from previously admitted model declarations", {
	timeout: 120_000,
}, async () => {
	await runIsolated(process.execPath, ["test/integration/fixtures/codex-tools.mjs", "normal", JSON.stringify({
		config: { tools: { autoReasoning: true } },
		expected: ["apply_patch", "change_reasoning", "exec_command", "view_image", "write_stdin"],
		switchConfig: { tools: { autoReasoning: false } },
		expectedAfter: ["apply_patch", "exec_command", "view_image", "write_stdin"],
	})], { timeoutMs: 90_000 });
});
