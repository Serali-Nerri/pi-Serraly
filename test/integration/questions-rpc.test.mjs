import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { diagnostics, releaseFixture, sandboxFixture } from "./helpers/runtime.mjs";

test("the real RPC CLI sequences question dialogs, dismisses and aborts pending input without poisoning later calls", { timeout: 60000 }, async () => {
	const stage = await releaseFixture({ packages: ["pi-ask-user-question"] });
	let sandbox;
	try {
		sandbox = await sandboxFixture(stage.release);
		const manifest = JSON.parse(await readFile(join(stage.release, "package.json"), "utf8"));
		const child = spawn(process.execPath, [stage.host.cli, "--mode", "rpc", "--offline", "--no-session",
			"--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--no-extensions",
			...manifest.pi.extensions.flatMap((entry) => ["-e", join(stage.release, entry)]),
			"-e", join(sandbox.base, "fixtures/questions-rpc-fixture.js"),
			"--provider", "serraly-questions", "--model", "fixture", "--thinking", "off"],
		{ cwd: sandbox.cwd, env: sandbox.env, stdio: "pipe" });
		let stderr = "";
		child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
		const closed = new Promise((done, reject) => {
			child.once("error", reject);
			child.once("close", (code, signal) => done({ code, signal }));
		});
		void closed.catch(() => {});
		const deadline = setTimeout(() => child.kill("SIGKILL"), 30000);
		// Strict LF framing: unlike readline, U+2028 within an answer is data.
		async function* jsonLines() {
			let buffer = "";
			child.stdout.setEncoding("utf8");
			for await (const chunk of child.stdout) {
				buffer += chunk;
				while (buffer.includes("\n")) {
					const index = buffer.indexOf("\n");
					const line = buffer.slice(0, index);
					buffer = buffer.slice(index + 1);
					yield JSON.parse(line);
				}
			}
			assert.equal(buffer, "", "RPC stdout ends at an LF boundary");
		}
		const lines = jsonLines(), records = [], ids = new Set();
		const send = (record) => child.stdin.write(JSON.stringify(record) + "\n");
		async function waitFor(predicate, after = 0) {
			for (;;) {
				const prior = records.slice(after).find(predicate);
				if (prior) return prior;
				const next = await lines.next();
				assert.equal(next.done, false, `RPC closed before expected event: ${stderr}`);
				records.push(next.value);
			}
		}
		async function request(id, type, extra = {}) {
			send({ id, type, ...extra });
			const response = await waitFor((record) => record.type === "response" && record.id === id);
			assert.equal(response.success, true, JSON.stringify(response));
			return response.data;
		}
		async function dialog(after, method, title) {
			const record = await waitFor((value) => value.type === "extension_ui_request" &&
				(value.method === "select" || value.method === "input"), after);
			assert.equal(record.method, method);
			assert.ok(record.title.includes(title), record.title);
			assert.equal(typeof record.id, "string");
			assert.ok(record.id.length > 0);
			assert.ok(!ids.has(record.id), "each native dialog has its own response id");
			ids.add(record.id);
			return record;
		}
		const answer = (record, value) => send({ type: "extension_ui_response", id: record.id, value });
		const ended = (id, after) => waitFor((record) => record.type === "tool_execution_end" && record.toolCallId === id, after);
		try {
			const state = await request("state", "get_state");
			assert.equal(state.sessionFile, undefined);

			let start = records.length;
			await request("siblings", "prompt", { message: "siblings" });
			let active = await dialog(start, "select", "Where should it run?");
			assert.ok(active.title.includes("Keep the data nearby."));
			answer(active, active.options[0]);
			start = records.length;
			active = await dialog(start, "select", "What is the custom value?");
			answer(active, active.options.at(-1));
			start = records.length;
			active = await dialog(start, "input", "What is the custom value?");
			answer(active, "custom\u2028answer");
			const first = await ended("rpc-first", start);
			assert.equal(first.isError, false);
			assert.deepEqual(first.result.details, { answers: [
				{ questionIndex: 0, question: "Where should it run?", kind: "option", answer: "Local", preview: "Keep the data nearby." },
				{ questionIndex: 1, question: "What is the custom value?", kind: "custom", answer: "custom\u2028answer" },
			], cancelled: false });
			active = await dialog(records.indexOf(first) + 1, "input", "Which locations are allowed?");
			answer(active, "2,1,2");
			const second = await ended("rpc-second", records.indexOf(first) + 1);
			assert.deepEqual(second.result.details, { answers: [
				{ questionIndex: 0, question: "Which locations are allowed?", kind: "multi", answer: null, selected: ["Remote", "Local"] },
			], cancelled: false });
			await waitFor((record) => record.type === "agent_settled", records.indexOf(second));
			assert.deepEqual(records.filter((record) => record.type === "tool_execution_start").map((record) => record.toolCallId),
				["rpc-first", "rpc-second"]);
			assert.ok(records.findIndex((record) => record.type === "tool_execution_start" && record.toolCallId === "rpc-second") >
				records.indexOf(first), "a sibling call starts only after the first questionnaire finishes");

			start = records.length;
			await request("dismiss", "prompt", { message: "dismiss" });
			active = await dialog(start, "select", "Keep this answer?");
			answer(active, active.options[0]);
			start = records.length;
			active = await dialog(start, "select", "Continue the questionnaire?");
			send({ type: "extension_ui_response", id: active.id, cancelled: true });
			const dismissed = await ended("rpc-dismiss", start);
			assert.deepEqual(dismissed.result.details, { answers: [
				{ questionIndex: 0, question: "Keep this answer?", kind: "option", answer: "Local", preview: "Keep the data nearby." },
			], cancelled: true });
			assert.equal(dismissed.result.content[0].text, "User declined to answer questions");
			await waitFor((record) => record.type === "agent_settled", records.indexOf(dismissed));

			start = records.length;
			await request("abort-prompt", "prompt", { message: "abort" });
			active = await dialog(start, "select", "Abort the pending custom answer?");
			answer(active, active.options.at(-1));
			start = records.length;
			const abortedDialog = await dialog(start, "input", "Abort the pending custom answer?");
			await request("abort", "abort");
			const aborted = await ended("rpc-abort", start);
			assert.deepEqual(aborted.result.details, { answers: [], cancelled: true });
			assert.equal(aborted.result.content[0].text, "User declined to answer questions");
			const settled = await waitFor((record) => record.type === "agent_settled", records.indexOf(aborted));
			assert.equal(settled.aborted, true);
			assert.equal((await request("idle", "get_state")).isStreaming, false);

			start = records.length;
			await request("recovery", "prompt", { message: "recovery" });
			active = await dialog(start, "select", "Can another questionnaire run?");
			answer(abortedDialog, "a stale dialog response");
			answer(active, active.options[1]);
			const recovered = await ended("rpc-recovery", start);
			assert.deepEqual(recovered.result.details, { answers: [
				{ questionIndex: 0, question: "Can another questionnaire run?", kind: "option", answer: "Remote" },
			], cancelled: false });
			await waitFor((record) => record.type === "agent_settled", records.indexOf(recovered));
			const messages = (await request("messages", "get_messages")).messages.filter((message) => message.role === "toolResult");
			assert.deepEqual(messages.map((message) => message.details), [first, second, dismissed, aborted, recovered].map((event) => event.result.details));

			child.stdin.end();
			while (!(await lines.next()).done) { /* Drain final LF-framed output before checking shutdown. */ }
			assert.deepEqual(await closed, { code: 0, signal: null }, stderr);
			assert.equal(stderr, "");
			const reports = await diagnostics(sandbox);
			assert.ok(reports.some((record) => record.phase === "questions-rpc-mode" && record.mode === "rpc" && record.hasUI));
			assert.ok(!reports.some((record) => record.phase === "network-denied" || record.phase === "fixture-error"), JSON.stringify(reports));
		} finally {
			clearTimeout(deadline);
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await closed.catch(() => {});
		}
	} finally {
		await sandbox?.cleanup();
		await stage.cleanup();
	}
});
