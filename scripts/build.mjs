import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { sealDist } from "./lib/artifacts.mjs";
import { extensionEntries, hostExternal, modules, root } from "./lib/modules.mjs";

const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (JSON.stringify(manifest.pi) !== JSON.stringify({ extensions: extensionEntries })) {
	throw new Error("Root manifest must declare exactly the six independent extension entries");
}
const stageRoot = join(root, ".stage");
await mkdir(stageRoot, { recursive: true });
const stage = await mkdtemp(join(stageRoot, "package-"));
const retired = join(stageRoot, `retired-${stage.split("/").at(-1)}`);
let hasRetired = false;
try {
	for (const module of modules) {
		const source = join(root, "modules", module.directory);
		const output = join(stage, module.runtime);
		await mkdir(output, { recursive: true });
		if (module.compile) {
			const compiled = spawnSync(process.execPath, [
				createRequire(import.meta.url).resolve("typescript/bin/tsc"),
				"--project", join(source, "tsconfig.build.json"), "--outDir", output,
			], { cwd: source, encoding: "utf8" });
			if (compiled.status !== 0) throw new Error(compiled.stderr || compiled.stdout || "Background compilation failed");
			await writeFile(join(output, "index.js"), 'export { default } from "./extensions/background-tasks.js";\n');
		} else {
			const result = await build({
				entryPoints: [join(source, module.entry)], outfile: join(output, "index.js"),
				bundle: true, platform: "node", format: "esm", target: "node22",
				external: [...hostExternal, "@llamaindex/liteparse"],
				legalComments: "eof", metafile: true,
			});
			if (Object.keys(result.metafile.inputs).some((path) => /node_modules[/\\](?:@earendil-works|typebox|grok-mermaid)[/\\]/.test(path))) {
				throw new Error(`${module.runtime} bundled a host or retired Mermaid dependency`);
			}
		}
		await writeFile(join(output, "package.json"), '{"type":"module"}\n');
		for (const asset of module.assets ?? []) {
			await cp(join(source, dirname(module.entry), asset), join(output, asset));
		}
		for (const license of module.licenses) {
			await mkdir(join(output, dirname(license)), { recursive: true });
			await cp(join(source, license), join(output, license), { recursive: true });
		}
	}
	const require = createRequire(import.meta.url);
	await mkdir(join(stage, "pi-tools/licenses"), { recursive: true });
	await cp(join(dirname(require.resolve("diff/package.json")), "LICENSE"), join(stage, "pi-tools/licenses/diff-BSD.txt"));
	await sealDist(stage);
	// Development dist is never a live runtime. Publish only a validated complete
	// tree, retaining the last build if the final rename fails.
	try { await rename(join(root, "dist"), retired); hasRetired = true; }
	catch (error) { if (error.code !== "ENOENT") throw error; }
	try { await rename(stage, join(root, "dist")); }
	catch (error) { if (hasRetired) await rename(retired, join(root, "dist")); throw error; }
	await rm(retired, { recursive: true, force: true });
	console.log("Built six independent entries; host packages external, worker/lazy closure and licenses verified.");
} finally {
	await rm(stage, { recursive: true, force: true });
}
