import test from "node:test";
import { runIsolated } from "../../scripts/lib/workspace.mjs";

const normalTools = ["apply_patch", "exec_command", "view_image", "write_stdin"];

for (const mode of ["normal", "code", "ts", "js"]) {
	test(`${mode} tree navigation keeps never-enabled optional tools inactive`, {
		timeout: 120_000,
	}, async () => {
		const expected = mode === "normal" ? normalTools : mode === "code" ? ["exec", "wait"] : ["exec", "notebook", "wait"];
		// Native tools restored by Pi remain available; /tree must not discard history.
		const expectedAfter = [...new Set([...normalTools, ...expected])].sort();
		await runIsolated(process.execPath, ["test/integration/fixtures/codex-tools.mjs", mode,
			JSON.stringify({ expected, expectedAfter })], { timeoutMs: 90_000 });
	});
}

test("tree navigation restores tools explicitly enabled at the historical node", {
	timeout: 120_000,
}, async () => {
	await runIsolated(process.execPath, ["test/integration/fixtures/codex-tools.mjs", "normal", JSON.stringify({
		config: { tools: { autoReasoning: true } },
		expected: ["apply_patch", "change_reasoning", "exec_command", "view_image", "write_stdin"],
		switchConfig: { tools: { autoReasoning: false } },
		expectedAfterConfig: normalTools,
	})], { timeoutMs: 90_000 });
});
