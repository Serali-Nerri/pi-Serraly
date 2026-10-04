import { existsSync } from "node:fs";
import { join } from "node:path";
import { discoverPackages, root } from "./lib/packages.mjs";
import { discoverTests, isolatedRun } from "./lib/workspace.mjs";
import { assertSupportedNode } from "./lib/node-version.mjs";

try {
	assertSupportedNode();
	const args = process.argv.slice(2);
	let selected, suite, list = false;
	for (let index = 0; index < args.length; index++) {
		if (args[index] === "--package" && args[index + 1]) selected = args[++index];
		else if (args[index] === "--suite" && args[index + 1]) suite = args[++index];
		else if (args[index] === "--list") list = true;
		else throw new Error("Usage: node scripts/test.mjs [--package <npm-name>] [--suite integration] [--list]");
	}
	if (suite !== undefined && suite !== "integration") throw new Error(`Unknown suite: ${suite}`);
	if (selected !== undefined && suite !== undefined) throw new Error("Choose either --package or --suite, not both");
	const packages = await discoverPackages();
	if (selected !== undefined && !packages.some((pkg) => pkg.name === selected)) throw new Error(`Unknown package: ${selected}`);
	// An explicit integration suite runs only that suite; otherwise run the
	// selected package, or every package plus the integration suite.
	const selectedPackages = selected !== undefined
		? packages.filter((pkg) => pkg.name === selected)
		: (suite === "integration" ? [] : packages);
	const groups = [];
	for (const pkg of selectedPackages) {
		const test = pkg.manifest.serraly?.test;
		if (!test) continue;
		groups.push({ pkg, cwd: pkg.directory, tests: await discoverTests(join(pkg.directory, test.directory)) });
	}
	if (selected === undefined || suite === "integration") {
		groups.push({ pkg: null, name: "integration", cwd: root, tests: await discoverTests(join(root, "test/integration")) });
	}
	if (list) {
		for (const group of groups) console.log(group.tests.join("\n"));
	} else {
		for (const group of groups) {
			const name = group.pkg?.name ?? group.name;
			console.log(`\n=== ${name} ===`);
			const test = group.pkg?.manifest.serraly?.test;
			if (test?.command) {
				// Preserve the package's framework and suite ordering under the same isolation.
				await isolatedRun("npm", ["run", test.command, "--workspace", group.pkg.relativeDirectory],
					root, { denyNetwork: test.denyNetwork === true });
				continue;
			}
			const flags = group.pkg?.name === "pi-ui" ? [] : ["--test-concurrency=1"];
			await isolatedRun(process.execPath, ["--import", "tsx", "--test", ...flags, ...group.tests], group.cwd);
		}
	}
} catch (error) { console.error(error.message); process.exitCode = 1; }
