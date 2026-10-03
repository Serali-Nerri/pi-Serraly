import { after, before, test } from "node:test";
import { releaseFixture, sdkScenario } from "./helpers/runtime.mjs";

let stage;
before(async () => { stage = await releaseFixture(); }, { timeout: 180000 });
after(async () => { await stage?.cleanup(); });

// Exercises the actual SettingsManager/PackageManager/SDK loader after an
// operator-style settings backup, source replacement and exact restoration.
// The historical directory migration protocol is deliberately not involved.
test("sandbox settings cutover loads compiled subagents once and rollback restores the legacy source", { timeout: 60000 }, async () => {
	await sdkScenario(stage, "cutover", {}, 55000);
});
