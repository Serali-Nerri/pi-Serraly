import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import {
	cacheExactNpmImport,
	resolveWindowsNpmCli,
} from "../src/tools/ts-mode/npm-cache.ts";
import { verifyTsrsBinary } from "../src/tools/ts-mode/runtime.ts";

test("resolveWindowsNpmCli locates npm-cli.js from npm_execpath, execPath, PATH and APPDATA", async () => {
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

		assert.equal(await resolveWindowsNpmCli({ execPath, env: {} }), bundledCli);

		const explicitCli = join(root, "explicit", "npm-cli.js");
		await mkdir(join(root, "explicit"), { recursive: true });
		await writeFile(explicitCli, "// explicit");
		assert.equal(
			await resolveWindowsNpmCli({
				execPath,
				env: { npm_execpath: explicitCli },
			}),
			explicitCli,
		);

		const pathDir = join(root, "on-path");
		const pathCli = join(pathDir, "node_modules", "npm", "bin", "npm-cli.js");
		await mkdir(join(pathDir, "node_modules", "npm", "bin"), {
			recursive: true,
		});
		await writeFile(pathCli, "// path");
		assert.equal(
			await resolveWindowsNpmCli({
				execPath: join(root, "missing", "node.exe"),
				env: { PATH: `"${pathDir}"${delimiter}relative` },
			}),
			pathCli,
		);

		const appData = join(root, "appdata");
		const appDataCli = join(
			appData,
			"npm",
			"node_modules",
			"npm",
			"bin",
			"npm-cli.js",
		);
		await mkdir(join(appData, "npm", "node_modules", "npm", "bin"), {
			recursive: true,
		});
		await writeFile(appDataCli, "// appdata");
		assert.equal(
			await resolveWindowsNpmCli({
				execPath: join(root, "missing", "node.exe"),
				env: { APPDATA: appData },
			}),
			appDataCli,
		);

		await assert.rejects(
			() =>
				resolveWindowsNpmCli({
					execPath: join(root, "missing", "node.exe"),
					env: {},
				}),
			/npm not found/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("cacheExactNpmImport self-heals a stale tsrs cache missing its platform binary and refuses to mark partial installs complete", async () => {
	const cacheDir = await mkdtemp(join(tmpdir(), "pcc-tsrs-cache-"));
	try {
		const version = "7.1.0-beta.tsrs5";
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
