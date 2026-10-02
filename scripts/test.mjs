import { existsSync } from "node:fs";
import { join } from "node:path";
import { modules, root } from "./lib/modules.mjs";
import { discoverTests, isolatedRun } from "./lib/workspace.mjs";

try {
	const args = process.argv.slice(2);
	let selected, list = false;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--module" && args[i + 1]) selected = args[++i];
		else if (args[i] === "--list") list = true;
		else throw new Error("Usage: node scripts/test.mjs [--module <name|integration>] [--list]");
	}
	if (selected && selected !== "integration" && !modules.some(({ directory }) => directory === selected)) {
		throw new Error(`Unknown module: ${selected}`);
	}
	const groups = [];
	for (const module of modules) {
		if (selected && selected !== module.directory) continue;
		const cwd = join(root, "modules", module.directory);
		const testsRoot = join(cwd, existsSync(join(cwd, "test")) ? "test" : "tests");
		const tests = (await discoverTests(testsRoot)).filter((path) =>
			module.directory !== "background-shell" || !path.includes("/tests/windows/"));
		groups.push({ name: module.directory, cwd, tests });
	}
	if (!selected || selected === "integration") {
		groups.push({ name: "integration", cwd: root, tests: await discoverTests(join(root, "test/integration")) });
	}
	if (list) {
		for (const group of groups) console.log(group.tests.join("\n"));
	} else {
		// npm test is self-contained: integration never loads stale dist.
		await isolatedRun(process.execPath, [join(root, "scripts/build.mjs")]);
		for (const group of groups) {
			console.log(`\n=== ${group.name} ===`);
			if (group.name === "background-shell") {
				// Its package tests intentionally delete module-local dist. Preserve
				// upstream suite ordering and rebuild boundaries before compiled SDK
				// tests instead of concatenating every file into one sorted run.
				await isolatedRun("npm", ["run", "test:full", "--workspace", "modules/background-shell"]);
				continue;
			}
			const flags = group.name === "ui" ? [] : ["--test-concurrency=1"];
			await isolatedRun(process.execPath, ["--import", "tsx", "--test", ...flags, ...group.tests], group.cwd);
		}
	}
} catch (error) { console.error(error.message); process.exitCode = 1; }
