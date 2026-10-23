import { build } from "bun";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dist = new URL("./dist/", import.meta.url);
await rm(dist, { recursive: true, force: true });
const result = await build({
	entrypoints: [fileURLToPath(new URL("./src/index.ts", import.meta.url))],
	outdir: fileURLToPath(dist),
	// Pi must bind its own classes: keep its TS loader path and no internal imports.
	naming: "index.ts",
	target: "node",
	packages: "external",
});
if (!result.success) throw new AggregateError(result.logs, "pi-ui build failed");
