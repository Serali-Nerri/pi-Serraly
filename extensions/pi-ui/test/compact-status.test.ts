import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { messageStopStatus } from "../src/compat/compact-mode.ts";
import { harness, strip } from "./harness.ts";

for (const stopReason of ["length", "aborted", "error"] as const) {
	for (const hiddenThinking of [true, false]) {
		for (const hasTools of [true, false]) {
			test(`compact ${stopReason} status appears once (${hiddenThinking ? "hidden" : "visible"} thinking, ${hasTools ? "tools" : "thinking only"})`, async () => {
				const h = await harness({ mode: "compact" });
				try {
					const message: any = {
						role: "assistant", timestamp: 100, api: "openai-responses", provider: "openai", model: "test",
						stopReason, errorMessage: stopReason === "error" ? "Fixture failure" : undefined,
						content: [{ type: "thinking", thinking: "Inspect the file." },
							...(hasTools ? [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/index.ts" } }] : [])],
					};
					const assistant = new AssistantMessageComponent(message, hiddenThinking) as any;
					h.root.addChild(assistant);
					if (hasTools) h.tool("read", "read-1", { path: "src/index.ts" }, { content: [{ type: "text", text: "ok" }], isError: false });
					for (const expanded of [false, true, false]) {
						assistant.setExpanded(expanded);
						h.render();
						const lines = h.root.render(100).map(strip);
						assert.equal(lines.filter((line) => line.includes(messageStopStatus(message)!)).length, 1,
							`one external status in ${expanded ? "expanded" : "collapsed"} round`);
						assert.ok(!lines.some((line) => line.includes("maximum output token limit")), "no duplicate native truncation status");
						assert.equal(assistant.lastMessage, message, "presentation does not replace the original message");
						assert.equal(message.stopReason, stopReason);
					}
				} finally {
					await h.close();
				}
			});
		}
	}
}
