import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedEnvironment } from "../../../scripts/lib/environment.mjs";
import { hostPackage } from "../../../scripts/lib/host.mjs";
import { npmCliPath } from "../../../scripts/lib/package-artifacts.mjs";
import { discoverPackages } from "../../../scripts/lib/packages.mjs";

/**
 * Pack one workspace package and install the real tarball into a consumer tree
 * outside the development workspace. The consumer owns its HOME/config/cache and
 * installs offline, so a package can only resolve what it actually bundles.
 */
export async function packedFixture(t, packageName) {
	const packages = await discoverPackages();
	const pkg = packages.find((candidate) => candidate.name === packageName);
	if (!pkg) throw new Error(`Unknown package: ${packageName}`);
	const base = await mkdtemp(join(tmpdir(), "serraly-packed-"));
	t.after(async () => { await rm(base, { recursive: true, force: true }); });
	const scratch = join(base, "scratch");
	const consumer = join(base, "consumer");
	await mkdir(scratch, { recursive: true });
	await mkdir(consumer, { recursive: true });
	const env = isolatedEnvironment(base);
	for (const path of [env.HOME, env.PI_CODING_AGENT_DIR, join(base, "cache"), join(base, "config")]) {
		await mkdir(path, { recursive: true });
	}
	const packed = spawnSync(process.execPath, [npmCliPath(), "pack", "--ignore-scripts", "--pack-destination", scratch, pkg.directory],
		{ cwd: scratch, env, encoding: "utf8", timeout: 120000 });
	if (packed.status !== 0) throw new Error(`npm pack failed for ${packageName}: ${packed.stderr || packed.stdout}`);
	const tarball = join(scratch, packed.stdout.trim().split("\n").at(-1));
	await writeFile(join(consumer, "package.json"), '{"name":"serraly-consumer","private":true,"type":"module"}\n');
	const installed = spawnSync(process.execPath, [npmCliPath(), "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
		"--legacy-peer-deps", tarball], { cwd: consumer, env, encoding: "utf8", timeout: 180000 });
	const directory = join(consumer, "node_modules", packageName);
	const host = hostPackage();
	if (installed.status !== 0) return { base, consumer, directory, env, installed, tarball, host, entry: undefined };
	const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
	return { base, consumer, directory, env, installed, tarball, host, entry: join(directory, manifest.pi.extensions[0].slice(2)) };
}
