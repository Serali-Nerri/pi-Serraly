#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { applyPatchPlatforms as platforms } from "./build-apply-patch-binary.mjs";

const { values, positionals } = parseArgs({
	options: { target: { type: "string" } },
	allowPositionals: true,
});
if (positionals.length > 2)
	throw new Error("Expected at most a native tool package and binary name");
const packageName = positionals[0] ?? "codex-view-image";
const binName = positionals[1] ?? "view_image";
const toolDirs = { exec_bridge: "exec", view_image: "view-image" };
const sourceRoot = resolve(process.env.CODEX_TOOLS_SOURCE_DIR ?? "src/tools");
const target =
	values.target ?? platforms[`${process.platform}-${process.arch}`];
const platformArch = Object.keys(platforms).find(
	(platform) => platforms[platform] === target,
);
if (!platformArch)
	throw new Error(
		`Unsupported native tool build target: ${target ?? `${process.platform}-${process.arch}`}`,
	);
const exe = platformArch.startsWith("win32-") ? `${binName}.exe` : binName;
const outDir = resolve(
	"src",
	"tools",
	toolDirs[binName] ?? binName,
	"bin",
	platformArch,
);
const targetDir = resolve(sourceRoot, process.env.CARGO_TARGET_DIR ?? "target");
const source = join(targetDir, target, "release", exe);

const cargo = spawnSync(
	"cargo",
	[
		"build",
		"--release",
		"--locked",
		"--target",
		target,
		"--target-dir",
		targetDir,
		"-p",
		packageName,
	],
	{ cwd: sourceRoot, stdio: "inherit", env: process.env },
);
if (cargo.status !== 0) process.exit(cargo.status ?? 1);
if (!existsSync(source)) {
	console.error(`Expected ${source} after cargo build`);
	process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const dest = join(outDir, basename(source));
copyFileSync(source, dest);
if (!platformArch.startsWith("win32-")) chmodSync(dest, 0o755);
console.log(`Wrote ${dest}`);
