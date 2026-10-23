import test from "node:test";
import { runIsolated } from "../../scripts/lib/workspace.mjs";

test("bundled Pi loads the compiled UI, renders Thinking and releases old frames and context", async () => {
	await runIsolated(process.execPath, ["--expose-gc", "test/integration/fixtures/ui-lifetime.mjs"]);
});
