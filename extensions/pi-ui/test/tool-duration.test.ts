// Native bash/PowerShell cards report the recorded execution duration; taking over
// those cards must not drop information the user had before.
import assert from "node:assert/strict";
import test from "node:test";
import { setConfig } from "../src/config/config.ts";
import { createCcstyleTool } from "../src/transcript/tool-renderers.ts";
import { harness, strip } from "./harness.ts";

const theme = { fg: (_color: string, text: string) => text } as any;
const result = { content: [{ type: "text", text: "command output" }], isError: false } as any;

function renderResult(name: string, args: any, options: any, durationMs: number | undefined): string {
	setConfig({ mode: "on" });
	const renderer = createCcstyleTool({ name, label: name, parameters: {} } as any, "generic");
	const context = {
		args, cwd: "/tmp", expanded: false, isPartial: false, executionStarted: true,
		isError: false, toolCallId: "duration", outputPad: 1, durationMs,
	};
	return renderer.renderResult(result, options, theme, context).render(100).map(strip).join("\n");
}

test("shell cards show the recorded duration once the call has settled", () => {
	assert.match(
		renderResult("bash", { command: "local check" }, { isPartial: false }, 65_000),
		/Took 1m 5s/,
		"a settled bash card reports the recorded duration",
	);
	assert.match(
		renderResult("powershell", { command: "Get-Item" }, { isPartial: false }, 2_400),
		/Took 2s/,
		"PowerShell uses the same shell treatment as bash",
	);
});

test("cards omit the duration when it is unknown or still running", () => {
	assert.doesNotMatch(
		renderResult("bash", { command: "local check" }, { isPartial: true }, 65_000),
		/Took|Elapsed/,
		"a running call has no recorded duration to show",
	);
	assert.doesNotMatch(
		renderResult("bash", { command: "local check" }, { isPartial: false }, undefined),
		/Took|Elapsed/,
		"a result stored without a duration does not invent one",
	);
});

test("tools without a native duration line do not gain one", () => {
	assert.doesNotMatch(
		renderResult("read", { path: "source.ts" }, { isPartial: false }, 65_000),
		/Took/,
		"only the shell cards that show the line natively gain it",
	);
});

test("collapsed grouped shell rows retain their individual recorded durations without duplicates", async () => {
	const h = await harness();
	try {
		h.tool("bash", "group-duration-bash", { command: "BASH_DURATION" }, { ...result, durationMs: 65_000 });
		h.tool("bash", "group-duration-short", { command: "SHORT_DURATION" }, { ...result, durationMs: 2_400 });
		h.tool("bash", "group-duration-unknown", { command: "UNKNOWN_DURATION" }, result);
		const lines = h.render();
		assert.match(lines.find((line) => line.includes("BASH_DURATION")) ?? "", /Took 1m 5s/);
		assert.match(lines.find((line) => line.includes("SHORT_DURATION")) ?? "", /Took 2s/);
		assert.doesNotMatch(lines.find((line) => line.includes("UNKNOWN_DURATION")) ?? "", /Took/);
		assert.equal(lines.join("\n").match(/Took/g)?.length, 2, "each recorded duration appears only on its own row");
		assert.doesNotMatch(lines.join("\n"), /1m 7s/, "parallel durations are not summed");
	} finally { await h.close(); }
});
