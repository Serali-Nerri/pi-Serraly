import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildHistory } from "../src/history.ts";
import { RECAP_PROMPT } from "../src/prompt.ts";

function completedBranch(text: string) {
	const session = SessionManager.inMemory("/fixture");
	session.appendMessage({ role: "user", content: text, timestamp: 0 });
	session.appendMessage({
		role: "assistant", api: "openai-responses", provider: "fixture", model: "fixture",
		content: [{ type: "text", text: "Not yet validated." }], stopReason: "error", timestamp: 0,
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	return session.getBranch();
}

test("large pasted history keeps both ends within a bounded CPU budget", { timeout: 10_000 }, (t) => {
	const branch = completedBranch(`REQUEST_START${"x".repeat(32 * 1024 * 1024)}REQUEST_END`);
	buildHistory(branch); // Flatten the input and warm the path before measuring CPU time.
	const start = process.cpuUsage();
	const history = buildHistory(branch);
	const cpu = process.cpuUsage(start);
	const cpuMs = (cpu.user + cpu.system) / 1000;
	t.diagnostic(`32 MiB history: ${cpuMs.toFixed(1)} ms CPU`);
	assert.equal(history.completed, 1);
	assert.equal(history.empty, false);
	assert(history.text.startsWith("User: REQUEST_START"));
	assert(history.text.includes("[... excerpted ...]"));
	assert(history.text.includes("REQUEST_END"));
	assert(history.text.endsWith("Assistant: Not yet validated."));
	assert(Buffer.byteLength(RECAP_PROMPT + history.text) <= 32_768);
	// Native byte-length scans are cheap; per-code-point scans of the discarded
	// 32 MiB are not. CPU time excludes scheduler delays, with ample headroom.
	assert(cpuMs < 200, `Excerpting a large paste used ${cpuMs.toFixed(1)} ms CPU (limit: 200 ms)`);
});

test("excerpted UTF-8 history preserves complete characters within the prompt budget", () => {
	for (const character of ["x", "é", "中", "🚀", "x🚀中é"]) {
		const history = buildHistory(completedBranch(`START🚀${character.repeat(40_000)}中END`));
		assert(history.text.startsWith("User: START🚀"));
		assert(history.text.includes("[... excerpted ...]"));
		assert(history.text.includes("中END"));
		assert(history.text.endsWith("Assistant: Not yet validated."));
		assert(history.text.isWellFormed());
		assert.equal(Buffer.from(history.text).toString("utf8"), history.text);
		assert(Buffer.byteLength(RECAP_PROMPT + history.text) <= 32_768);
	}
});
