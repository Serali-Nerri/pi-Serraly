import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	cacheExactNpmImport,
	resolveNpmCommand,
} from "../src/tools/code-mode/npm-cache.ts";
import { verifyTsrsBinary } from "../src/tools/ts-mode/runtime.ts";

test("resolveNpmCommand uses Node + npm-cli.js on Windows instead of bare npm", async () => {
	const root = await mkdtemp(join(tmpdir(), "pcc-win-npm-"));
	try {
		const nodeDir = join(root, "nodejs");
		const execPath = join(nodeDir, "node.exe");
		const bundledCli = join(
			nodeDir,
			"node_modules",
			"npm",
			"bin",
			"npm-cli.js",
		);
		await mkdir(join(nodeDir, "node_modules", "npm", "bin"), {
			recursive: true,
		});
		await writeFile(bundledCli, "// npm-cli");

		const resolved = resolveNpmCommand(["install", "--ignore-scripts"], {
			platform: "win32",
			execPath,
			appData: join(root, "appdata"),
		});
		assert.deepEqual(resolved, {
			file: execPath,
			args: [bundledCli, "install", "--ignore-scripts"],
		});

		const posix = resolveNpmCommand(["install"], {
			platform: "darwin",
			execPath: "/usr/local/bin/node",
		});
		assert.deepEqual(posix, {
			file: "npm",
			args: ["install"],
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("cacheExactNpmImport self-heals a stale tsrs cache missing its platform binary and refuses to mark partial installs complete", async () => {
	const cacheDir = await mkdtemp(join(tmpdir(), "pcc-tsrs-cache-"));
	try {
		const version = "7.1.0-beta.tsrs4";
		const identity = `tsrs@${version}`;
		const entryDir = join(
			cacheDir,
			createHash("sha256").update(identity).digest("hex"),
		);
		const tsrsDir = join(entryDir, "node_modules", "tsrs");
		await mkdir(join(entryDir, "node_modules", "@tsrs"), { recursive: true });
		await mkdir(tsrsDir, { recursive: true });
		await writeFile(
			join(tsrsDir, "package.json"),
			JSON.stringify({ name: "tsrs", version }),
		);
		await writeFile(join(entryDir, ".installed"), identity);

		const verifyWinX64 = (manifestPath: string) =>
			verifyTsrsBinary(
				{ resolve: createRequire(manifestPath).resolve },
				"win32",
				"x64",
			);

		let installAttempts = 0;
		// First reinstall simulates npm exiting 0 while skipping failed optionalDependencies.
		await assert.rejects(
			() =>
				cacheExactNpmImport(`npm:${identity}`, cacheDir, undefined, true, {
					verify: verifyWinX64,
					runCommand: async (_file, _args, { cwd }) => {
						installAttempts++;
						await mkdir(join(cwd, "node_modules", "tsrs"), { recursive: true });
						await writeFile(
							join(cwd, "node_modules", "tsrs", "package.json"),
							JSON.stringify({ name: "tsrs", version }),
						);
					},
				}),
			/Missing tsrs binary for win32-x64/,
		);
		assert.equal(installAttempts, 1);
		await assert.rejects(() => readFile(join(entryDir, ".installed"), "utf8"), {
			code: "ENOENT",
		});

		// Second reinstall populates @tsrs/win32-x64/tsrs.exe and marks .installed.
		const winPkgDir = join(entryDir, "node_modules", "@tsrs", "win32-x64");
		await cacheExactNpmImport(`npm:${identity}`, cacheDir, undefined, true, {
			verify: verifyWinX64,
			runCommand: async (_file, _args, { cwd }) => {
				installAttempts++;
				await mkdir(join(cwd, "node_modules", "tsrs"), { recursive: true });
				await writeFile(
					join(cwd, "node_modules", "tsrs", "package.json"),
					JSON.stringify({ name: "tsrs", version }),
				);
				await mkdir(winPkgDir, { recursive: true });
				await writeFile(
					join(winPkgDir, "package.json"),
					JSON.stringify({ name: "@tsrs/win32-x64", version }),
				);
				await writeFile(join(winPkgDir, "tsrs.exe"), "stub-exe");
			},
		});
		assert.equal(installAttempts, 2);
		assert.equal(
			await readFile(join(entryDir, ".installed"), "utf8"),
			identity,
		);
	} finally {
		await rm(cacheDir, { recursive: true, force: true });
	}
});
