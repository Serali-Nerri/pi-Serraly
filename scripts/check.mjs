import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { modules, root } from "./lib/modules.mjs";
import { isolatedRun } from "./lib/workspace.mjs";
import { filesIn } from "./lib/artifacts.mjs";

try {
	for (const { directory } of modules) {
		const pkg = JSON.parse(await readFile(join(root, "modules", directory, "package.json"), "utf8"));
		const command = pkg.scripts?.check ? "check" : "typecheck";
		await isolatedRun("npm", ["run", command, "--workspace", `modules/${directory}`]);
	}
	for (const path of await filesIn(join(root, "scripts"))) {
		if (path.endsWith(".mjs")) await isolatedRun(process.execPath, ["--check", path]);
	}
} catch (error) { console.error(error.message); process.exitCode = 1; }
