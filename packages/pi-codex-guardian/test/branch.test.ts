import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { hasOnlyResultAppends } from "../src/branch.js";

const assistant: AssistantMessage = {
	role: "assistant",
	api: "openai-codex-responses",
	provider: "fixture",
	model: "fixture",
	content: [{ type: "text", text: "Waiting for the yielded tool." }],
	stopReason: "stop",
	timestamp: 0,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};

function branch() {
	const manager = SessionManager.inMemory(process.cwd());
	const user = manager.appendMessage({
		role: "user",
		content: "Apply the patch.",
		timestamp: 0,
	});
	const leaf = manager.appendMessage(assistant);
	return { manager, user, leaf };
}

test("ordinary yielded results and non-model metadata preserve authorization", () => {
	const { manager, leaf } = branch();
	assert.equal(hasOnlyResultAppends(manager, leaf), true);
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "exec-1",
		toolName: "exec",
		content: [{ type: "text", text: "yielded" }],
		isError: false,
		timestamp: 0,
	});
	manager.appendMessage(assistant);
	manager.appendCustomEntry("display-state", { expanded: true });
	manager.appendSessionInfo("Renamed session");
	manager.appendLabelChange(leaf, "checkpoint");
	assert.equal(hasOnlyResultAppends(manager, leaf), true);
});

test("same-branch edits, summaries and authorization messages are not result appends", () => {
	const changes: ((state: ReturnType<typeof branch>) => void)[] = [
		({ manager, user }) => {
			manager.appendContextEdit(user, { content: "Do not apply the patch." });
		},
		({ manager, leaf }) => {
			manager.appendCompaction("New context", leaf, 100);
		},
		({ manager }) => {
			manager.appendCustomMessageEntry("new-instructions", "Stop", false);
		},
		({ manager, user }) => {
			manager.branchWithSummary(user, "Different branch");
		},
		({ manager }) => {
			manager.appendMessage({ role: "user", content: "Stop", timestamp: 0 });
		},
		({ manager }) => {
			manager.appendMessage({
				role: "system",
				content: "New constraints",
				timestamp: 0,
			});
		},
		({ manager }) => {
			manager.appendModelChange("fixture", "different");
		},
	];
	for (const change of changes) {
		const state = branch();
		change(state);
		assert.equal(hasOnlyResultAppends(state.manager, state.leaf), false);
	}
});

test("leaving the original path cannot reuse its authorization", () => {
	const { manager, user, leaf } = branch();
	manager.branch(user);
	assert.equal(hasOnlyResultAppends(manager, leaf), false);
	manager.appendMessage(assistant);
	assert.equal(hasOnlyResultAppends(manager, leaf), false);
	manager.resetLeaf();
	assert.equal(hasOnlyResultAppends(manager, leaf), false);
});
