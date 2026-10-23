import { spawn } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const memberCount = 8;
const commandTimeoutMs = 120_000;
const emptyPiResources = ["extensions", "skills", "prompts", "themes"];
const installArgs = [
	"install", "--offline", "--production", "--omit", "peer", "--frozen-lockfile",
	"--ignore-scripts", "--backend", "copyfile", "--linker", "hoisted",
];

const exists = async (path) => {
	try { await lstat(path); return true; }
	catch (error) { if (error.code === "ENOENT") return false; throw error; }
};

async function readJson(path, label) {
	try { return JSON.parse(await readFile(path, "utf8")); }
	catch (error) { throw new Error(`${label} is not valid JSON at ${path}: ${error.message}`, { cause: error }); }
}

function killProcessGroup(child) {
	if (!child.pid) return;
	try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); }
	catch (error) { if (error.code !== "ESRCH") throw error; }
}

function run(command, args, { cwd, env }) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "", stderr = "", settled = false, timedOut = false;
		let timer;
		const finish = (callback, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			callback(value);
		};
		timer = setTimeout(() => {
			timedOut = true;
			killProcessGroup(child);
		}, commandTimeoutMs);
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.once("error", (error) => finish(reject, error));
		child.once("close", (code, signal) => {
			killProcessGroup(child);
			if (timedOut) {
				finish(reject, new Error(`${command} ${args.join(" ")} timed out after ${commandTimeoutMs}ms`));
				return;
			}
			const detail = [stderr, stdout].filter(Boolean).join("\n").trim();
			if (code !== 0) {
				finish(reject, new Error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : `: ${code ?? signal}`}`));
				return;
			}
			finish(resolve, { stdout, stderr });
		});
	});
}

function assertEmptyRootResources(manifest) {
	for (const key of emptyPiResources) {
		if (!Array.isArray(manifest.pi?.[key]) || manifest.pi[key].length !== 0) {
			throw new Error(`Release root package.json must declare an empty pi.${key} array`);
		}
	}
}

function validateManifest(manifest, directory) {
	const label = `packages/${directory}/package.json`;
	if (!manifest.name || typeof manifest.name !== "string") throw new Error(`${label} has no package name`);
	if (!manifest.version || typeof manifest.version !== "string") throw new Error(`${label} has no package version`);
	if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
		throw new Error(`${label} must have a files allowlist for npm pack`);
	}
	if (!Array.isArray(manifest.pi?.extensions) || manifest.pi.extensions.length === 0 ||
		!manifest.pi.extensions.every((entry) => typeof entry === "string" && entry.startsWith("./"))) {
		throw new Error(`${label} must register at least one ./extension entry`);
	}
}

async function discoverMembers(root) {
	const packagesDirectory = join(root, "packages");
	const entries = await readdir(packagesDirectory, { withFileTypes: true });
	const members = [];
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (entry.name.startsWith(".")) continue;
		if (!entry.isDirectory()) throw new Error(`Release package entry is not a directory: ${join(packagesDirectory, entry.name)}`);
		const directory = entry.name;
		const directoryPath = join(packagesDirectory, directory);
		const manifest = await readJson(join(directoryPath, "package.json"), `packages/${directory}/package.json`);
		validateManifest(manifest, directory);
		members.push({ directory, directoryPath, path: `packages/${directory}`, name: manifest.name, version: manifest.version, manifest });
	}
	if (members.length !== memberCount) {
		throw new Error(`Release requires exactly ${memberCount} packages; found ${members.length}`);
	}
	const names = new Set();
	for (const member of members) {
		if (names.has(member.name)) throw new Error(`Duplicate release package name: ${member.name}`);
		names.add(member.name);
	}
	return members.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

function sourceCacheDirectory(env) {
	if (env.BUN_INSTALL_CACHE_DIR) return resolve(env.BUN_INSTALL_CACHE_DIR);
	if (env.BUN_INSTALL) return join(resolve(env.BUN_INSTALL), "install", "cache");
	return join(homedir(), ".bun/install/cache");
}

async function commandEnvironments(env, work) {
	const home = join(work, "home");
	const tmp = join(work, "tmp");
	await mkdir(home, { recursive: true });
	await mkdir(tmp, { recursive: true });
	const common = { HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp, LANG: "C.UTF-8" };
	for (const key of ["PATH", "SYSTEMROOT", "COMSPEC", "NODE_OPTIONS", "PI_SERRALY_NETWORK_LOG"]) {
		if (env[key]) common[key] = env[key];
	}
	return {
		common,
		npm: {
			...common,
			npm_config_cache: join(work, "npm-cache"),
			npm_config_userconfig: join(work, "npmrc"),
			npm_config_globalconfig: join(work, "npmrc-global"),
			npm_config_offline: "true",
			npm_config_ignore_scripts: "true",
			npm_config_audit: "false",
			npm_config_fund: "false",
			npm_config_update_notifier: "false",
			npm_config_loglevel: "error",
		},
		bun: { ...common, BUN_INSTALL_CACHE_DIR: sourceCacheDirectory(env) },
	};
}

async function copyWorkspaceInputs(root, stage, rootManifest) {
	await writeFile(join(stage, "package.json"), `${JSON.stringify(rootManifest, null, 2)}\n`);
	if (!(await exists(join(root, "bun.lock")))) {
		throw new Error("Release requires a frozen Bun lockfile (bun.lock) in the source workspace");
	}
	await copyFile(join(root, "bun.lock"), join(stage, "bun.lock"));
}

async function packMember(member, work, stage, environments) {
	const tarballDirectory = join(work, "tarballs", member.directory);
	await mkdir(tarballDirectory, { recursive: true });
	const { stdout } = await run("npm", [
		"pack", "--json", "--ignore-scripts", "--offline", "--pack-destination", tarballDirectory,
	], { cwd: member.directoryPath, env: environments.npm });
	let packed;
	try { packed = JSON.parse(stdout); }
	catch (error) { throw new Error(`npm pack for ${member.name} did not return JSON: ${error.message}`, { cause: error }); }
	if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0]?.filename !== "string") {
		throw new Error(`npm pack for ${member.name} did not report exactly one tarball`);
	}
	if (packed[0].name !== member.name || packed[0].version !== member.version) {
		throw new Error(`npm pack for ${member.name} reported ${packed[0].name}@${packed[0].version}`);
	}
	if (basename(packed[0].filename) !== packed[0].filename) {
		throw new Error(`npm pack for ${member.name} returned an unsafe filename: ${packed[0].filename}`);
	}
	const packageDirectory = join(stage, member.path);
	await mkdir(packageDirectory, { recursive: true });
	await run("tar", [
		"-xzf", join(tarballDirectory, packed[0].filename), "--strip-components=1", "-C", packageDirectory,
	], { cwd: work, env: environments.common });
	const packedManifest = await readJson(join(packageDirectory, "package.json"), `packed ${member.name} manifest`);
	if (packedManifest.name !== member.name || packedManifest.version !== member.version) {
		throw new Error(`Packed payload for ${member.name} has the wrong identity`);
	}
	for (const extension of member.manifest.pi.extensions) {
		const relativePath = extension.slice(2);
		const entry = join(packageDirectory, relativePath);
		if (!(await exists(entry)) || !(await lstat(entry)).isFile()) {
			throw new Error(`Packed ${member.name} is missing extension entry ${extension}; build artifacts first`);
		}
	}
	const topLevel = await readdir(packageDirectory);
	if (!topLevel.some((name) => /^licen[cs]e(?:[.-].*)?$/i.test(name))) {
		throw new Error(`Packed ${member.name} does not contain its license`);
	}
}

function runtimeDependencies(rootManifest, members) {
	const production = new Set(Object.keys(rootManifest.dependencies ?? {}));
	const memberNames = new Set(members.map((member) => member.name));
	for (const member of members) {
		for (const dependency of Object.keys(member.manifest.dependencies ?? {})) production.add(dependency);
		for (const dependency of Object.keys(member.manifest.optionalDependencies ?? {})) production.add(dependency);
		// Supplied peers are runtime integrations, not external host installations.
		for (const peer of Object.keys(member.manifest.peerDependencies ?? {})) {
			if (memberNames.has(peer)) production.add(peer);
		}
	}
	return production;
}

function excludedPackages(rootManifest, members) {
	const production = runtimeDependencies(rootManifest, members);
	const excluded = new Set(Object.keys(rootManifest.devDependencies ?? {}));
	for (const member of members) {
		for (const dependency of Object.keys(member.manifest.devDependencies ?? {})) excluded.add(dependency);
		for (const dependency of Object.keys(member.manifest.peerDependencies ?? {})) excluded.add(dependency);
	}
	return [...excluded].filter((name) => !production.has(name)).sort();
}

async function installRuntime(stage, environments) {
	await run("bun", installArgs, { cwd: stage, env: environments.bun });
}

async function pruneWorkspaceLinks(stage, members, production) {
	const memberLinks = new Map();
	for (const member of members) memberLinks.set(await realpath(join(stage, member.path)), member);
	const walk = async (directory) => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			const stats = await lstat(path);
			if (stats.isSymbolicLink()) {
				let target;
				try { target = await realpath(path); }
				catch (error) {
					if (error.code === "ENOENT") continue;
					throw error;
				}
				const member = memberLinks.get(target);
				if (member && !production.has(member.name)) await unlink(path);
			} else if (stats.isDirectory()) await walk(path);
		}
	};
	await walk(stage);
}

async function restoreMemberBins(stage, members) {
	for (const member of members) {
		const declared = member.manifest.bin;
		if (declared === undefined) continue;
		const entries = typeof declared === "string"
			? [[basename(member.name), declared]]
			: Object.entries(declared);
		const memberDirectory = resolve(stage, member.path);
		for (const [name, target] of entries) {
			if (typeof target !== "string" || target.length === 0) {
				throw new Error(`Release member ${member.name} has an invalid bin target for ${name}`);
			}
			if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
				throw new Error(`Release member ${member.name} has an invalid bin name: ${name}`);
			}
			const binTarget = resolve(memberDirectory, target);
			if (binTarget !== memberDirectory && !binTarget.startsWith(`${memberDirectory}${sep}`)) {
				throw new Error(`Release member ${member.name} bin ${name} points outside its payload: ${target}`);
			}
			const link = join(stage, "node_modules", ".bin", name);
			let existing;
			try { existing = await realpath(link); }
			catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
			if (existing) continue;
			try { await lstat(binTarget); }
			catch (error) {
				if (error.code === "ENOENT") {
					throw new Error(`Release member ${member.name} declares missing bin ${name}: ${target}`, { cause: error });
				}
				throw error;
			}
			await mkdir(dirname(link), { recursive: true });
			try { await unlink(link); }
			catch (error) { if (error.code !== "ENOENT") throw error; }
			await symlink(relative(dirname(link), binTarget), link);
		}
	}
}

async function writeReleaseRecord(stage, rootManifest, members) {
	const record = {
		version: rootManifest.version,
		members: Object.fromEntries(members.map((member) => [member.name, { version: member.version, path: member.path }])),
	};
	await writeFile(join(stage, "release.json"), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
	return record;
}

async function verifyRuntimeTree(stage, members, excluded) {
	const root = await realpath(stage);
	const nodeModules = [];
	const extensionEntries = [];
	const links = [];
	const walk = async (directory) => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			const stats = await lstat(path);
			if (stats.isSymbolicLink()) {
				const link = await readlink(path);
				if (isAbsolute(link)) throw new Error(`Release link must be relative for relocation: ${path} -> ${link}`);
				let target;
				try { target = await realpath(path); }
				catch (error) { throw new Error(`Release contains a broken link: ${path}: ${error.message}`, { cause: error }); }
				if (target !== root && !target.startsWith(`${root}${sep}`)) {
					throw new Error(`Release link points outside the release: ${path} -> ${target}`);
				}
				links.push({ path, link, target });
				if (relative(root, path).startsWith(`packages${sep}`)) extensionEntries.push({ path, target });
			} else if (stats.isDirectory()) {
				if (entry.name === "node_modules") nodeModules.push(path);
				await walk(path);
			} else if (!stats.isFile()) {
				throw new Error(`Release contains an unsupported filesystem entry: ${path}`);
			}
		}
	};
	await walk(stage);
	for (const directory of nodeModules) {
		for (const name of excluded) {
			if (await exists(join(directory, ...name.split("/")))) {
				throw new Error(`Release installed excluded package ${name} below ${directory}`);
			}
		}
	}
	for (const member of members) {
		if (!(await lstat(join(stage, member.path))).isDirectory()) {
			throw new Error(`Release is missing package directory ${member.path}`);
		}
	}
	const seen = new Set();
	const memberByName = new Map(members.map((member) => [member.name, member]));
	const visit = async (packageDirectory, manifest) => {
		const key = await realpath(packageDirectory);
		if (seen.has(key)) return;
		seen.add(key);
		const dependencies = new Set(Object.keys(manifest.dependencies ?? {}));
		for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
			if (memberByName.has(peer)) dependencies.add(peer);
		}
		for (const dependency of dependencies) {
			let directory = packageDirectory;
			let found;
			while (!found) {
				const candidate = join(directory, "node_modules", ...dependency.split("/"));
				if (await exists(join(candidate, "package.json"))) found = candidate;
				else if (directory === stage) break;
				else directory = dirname(directory);
			}
			if (!found) throw new Error(`Release is missing production dependency ${dependency} of ${manifest.name}`);
			const target = await realpath(found);
			if (target !== root && !target.startsWith(`${root}${sep}`)) {
				throw new Error(`Release dependency ${dependency} resolves outside the release: ${target}`);
			}
			const dependencyManifest = await readJson(join(found, "package.json"), `installed ${dependency} manifest`);
			if (dependencyManifest.name !== dependency) throw new Error(`Release dependency ${dependency} resolved to ${dependencyManifest.name}`);
			const member = memberByName.get(dependency);
			if (member) {
				const packed = await realpath(join(stage, member.path));
				if (target !== packed) throw new Error(`Release dependency ${dependency} must resolve to its packed workspace member, not ${target}`);
			}
			await visit(found, dependencyManifest);
		}
	};
	const rootManifest = await readJson(join(stage, "package.json"), "staged root package.json");
	await visit(stage, rootManifest);
	for (const member of members) await visit(join(stage, member.path), member.manifest);
	return { root, nodeModules, extensionEntries, links };
}

async function assertExternalDestination(output, root) {
	if (!isAbsolute(output)) throw new Error("Release output must be an absolute path");
	const target = resolve(output);
	const source = await realpath(root);
	const inside = (candidate) => candidate === source || candidate.startsWith(`${source}${sep}`);
	if (inside(target)) throw new Error(`Release output must be outside the development tree: ${target}`);
	await mkdir(dirname(target), { recursive: true });
	const parent = await realpath(dirname(target));
	if (inside(parent)) throw new Error(`Release output must be outside the development tree: ${target}`);
	if (await exists(target)) throw new Error(`Release output already exists; releases are immutable: ${target}`);
	return target;
}

/**
 * Build an immutable, offline runtime release. The destination is reserved
 * with an atomic mkdir and published with rename after every check has passed;
 * an existing path is never replaced.
 */
export async function createRelease(output, { root = resolve(import.meta.dirname, "../.."), env = process.env } = {}) {
	const source = resolve(root);
	const target = await assertExternalDestination(output, source);
	const rootManifest = await readJson(join(source, "package.json"), "root package.json");
	if (rootManifest.private !== true) throw new Error("Release root package.json must be private");
	if (!rootManifest.version || typeof rootManifest.version !== "string") throw new Error("Release root package.json has no version");
	assertEmptyRootResources(rootManifest);
	if (!Array.isArray(rootManifest.workspaces) || !rootManifest.workspaces.includes("packages/*")) {
		throw new Error("Release root package.json must include packages/* as a workspace glob");
	}
	const members = await discoverMembers(source);
	const excluded = excludedPackages(rootManifest, members);
	const production = runtimeDependencies(rootManifest, members);
	const work = await mkdtemp(join(dirname(target), ".pi-serraly-release-"));
	const stage = join(work, "release");
	let reserved = false;
	try {
		await mkdir(stage, { recursive: true });
		const environments = await commandEnvironments(env, work);
		await copyWorkspaceInputs(source, stage, rootManifest);
		for (const member of members) await packMember(member, work, stage, environments);
		await installRuntime(stage, environments);
		await pruneWorkspaceLinks(stage, members, production);
		await restoreMemberBins(stage, members);
		const record = await writeReleaseRecord(stage, rootManifest, members);
		const verified = await verifyRuntimeTree(stage, members, excluded);
		await assertExternalDestination(target, source);
		try { await mkdir(target); }
		catch (error) {
			if (error.code === "EEXIST") {
				throw new Error(`Release output already exists; releases are immutable: ${target}`, { cause: error });
			}
			throw error;
		}
		reserved = true;
		await rename(stage, target);
		reserved = false;
		return { path: target, version: record.version, members: record.members, links: verified.extensionEntries };
	} finally {
		if (reserved) await rmdir(target).catch(() => {});
		await rm(work, { recursive: true, force: true });
	}
}
