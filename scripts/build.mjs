import { build } from "esbuild";
import { cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const stageRoot = join(root, ".stage");
await mkdir(stageRoot, { recursive: true });
const stage = await mkdtemp(join(stageRoot, "ui-"));
try {
  const output = join(stage, "pi-ui");
  await mkdir(output, { recursive: true });
  const result = await build({
    entryPoints: [join(root, "modules/ui/src/index.ts")],
    outfile: join(output, "index.js"),
    bundle: true, platform: "node", format: "esm", target: "node22",
    external: ["@earendil-works/*", "typebox", "typebox/*"],
    legalComments: "eof", metafile: true,
  });
  const included = Object.keys(result.metafile.inputs);
  if (included.some((file) => /node_modules\/(?:@earendil-works|typebox|grok-mermaid)\//.test(file))) {
    throw new Error("UI bundle contains a host or removed Mermaid dependency");
  }
  await writeFile(join(output, "package.json"), JSON.stringify({ type: "module" }) + "\n");
  await cp(join(root, "modules/ui/licenses"), join(output, "licenses"), { recursive: true });
  await writeFile(join(stage, "metafile.json"), JSON.stringify(result.metafile, null, 2) + "\n");
  // No global installation uses this development dist during stage one.
  await rm(join(root, "dist"), { recursive: true, force: true });
  await rename(stage, join(root, "dist"));
  console.log("Built dist/pi-ui/index.js (host packages external; no custom Mermaid)");
} finally {
  await rm(stage, { recursive: true, force: true });
}
