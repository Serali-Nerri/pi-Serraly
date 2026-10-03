import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { existsSync } from "node:fs";
import { build } from "esbuild";
import { filesIn } from "./artifacts.mjs";

export const SEAL_PATH = "dist/artifacts.json";

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

function relativePath(directory, path) {
	return relative(directory, path).split(sep).join("/");
}

/** Host packages stay external; every other bare import must resolve inside the payload. */
export function hostExternals(manifest) {
	const externals = [];
	for (const name of Object.keys(manifest.peerDependencies ?? {})) {
		externals.push(name, `${name}/*`);
	}
	return externals;
}

function isHostPath(path) {
	return /node_modules[/\\](?:@earendil-works|typebox)(?:[/\\]|$)/.test(path);
}

const matchesExternal = (path, patterns) => patterns.some((pattern) =>
	pattern.endsWith("/*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern);

export function npmCliPath() {
	const candidates = [process.env.npm_execpath,
		resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
		resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")].filter(Boolean);
	const found = candidates.find((path) => existsSync(path));
	if (!found) throw new Error("Cannot resolve npm-cli.js for pack inspection");
	return found;
}

async function isolatedNpmEnvironment(base) {
	for (const path of ["home", "tmp", "cache", "config"]) await mkdir(join(base, path), { recursive: true });
	for (const file of ["user.npmrc", "global.npmrc"]) await writeFile(join(base, "config", file), "");
	return {
		PATH: process.env.PATH ?? "",
		...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}),
		HOME: join(base, "home"), USERPROFILE: join(base, "home"), PI_CODING_AGENT_DIR: join(base, "home/agent"),
		XDG_CONFIG_HOME: join(base, "config"), TMPDIR: join(base, "tmp"), TMP: join(base, "tmp"), TEMP: join(base, "tmp"),
		npm_config_cache: join(base, "cache"), npm_config_userconfig: join(base, "config/user.npmrc"),
		npm_config_globalconfig: join(base, "config/global.npmrc"), npm_config_registry: "http://127.0.0.1.invalid/",
		GIT_ALLOW_PROTOCOL: "file", CI: "1",
	};
}

function run(command, args, options) {
	return new Promise((done, reject) => {
		const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		child.stdout.on("data", (data) => { stdout += data; });
		child.stderr.on("data", (data) => { stderr += data; });
		child.once("error", reject);
		child.once("close", (code) => done({ code, stdout, stderr }));
	});
}

/**
 * Ask npm for the payload it would actually ship. Isolated HOME/config/cache and
 * `--ignore-scripts` keep this read-only and free of user credentials.
 */
export async function packFiles(directory) {
	const scratch = await mkdtemp(join(tmpdir(), "serraly-pack-"));
	try {
		const project = join(scratch, "project");
		await mkdir(project);
		await writeFile(join(project, "package.json"), '{"name":"pack-probe","private":true}\n');
		const env = await isolatedNpmEnvironment(scratch);
		const result = await run(process.execPath, [npmCliPath(), "pack", "--dry-run", "--ignore-scripts", "--offline", "--json", directory],
			{ cwd: project, env });
		if (result.code !== 0) throw new Error(`npm pack dry-run failed: ${result.stderr || result.stdout}`);
		let entries;
		try { entries = JSON.parse(result.stdout); }
		catch { throw new Error("npm pack did not return valid JSON"); }
		if (!Array.isArray(entries) || entries.length !== 1 || !Array.isArray(entries[0].files)) {
			throw new Error("npm pack must report exactly one package listing");
		}
		return entries[0].files.map((file) => file.path).sort();
	} finally { await rm(scratch, { recursive: true, force: true }); }
}

async function hashListedFiles(directory, files, skip) {
	const hashes = {};
	for (const path of files) {
		if (path === skip) continue;
		if (isAbsolute(path) || path.split("/").includes("..")) throw new Error(`Payload listing escapes the package: ${path}`);
		const absolute = join(directory, path);
		const stat = await lstat(absolute);
		if (stat.isSymbolicLink()) throw new Error(`Payload must not contain symlinks: ${path}`);
		if (!stat.isFile()) throw new Error(`Payload must contain only regular files: ${path}`);
		hashes[path] = sha256(await readFile(absolute));
	}
	return hashes;
}

async function hashPhysicalTree(directory) {
	const hashes = {};
	for (const path of await filesIn(directory)) {
		const name = relativePath(directory, path);
		if (name === SEAL_PATH) continue;
		hashes[name] = sha256(await readFile(path));
	}
	return hashes;
}

function sealedClosurePlugin(directory, inputs) {
	return {
		name: "sealed-artifact-closure",
		setup(analyzer) {
			analyzer.onResolve({ filter: /.*/ }, (args) => {
				if (args.kind !== "entry-point" && /[%?#\\\u0000-\u001f\u007f]/.test(args.path)) {
					return { errors: [{ text: `Unsupported URL/escaped executable specifier: ${args.path}` }] };
				}
				if (args.path.startsWith("node:")) return { path: args.path, external: true };
				if (!isAbsolute(args.path) && !args.path.startsWith(".")) return { path: args.path, external: true };
				const path = resolve(args.resolveDir, args.path);
				if (!inputs.has(path)) return { errors: [{ text: `Executable input outside the sealed artifact closure: ${args.path}` }] };
				return { path };
			});
			analyzer.onLoad({ filter: /.*/, namespace: "file" }, async (args) => {
				if (!inputs.has(args.path) || !(await lstat(args.path)).isFile()) {
					return { errors: [{ text: `Executable input outside the regular artifact closure: ${args.path}` }] };
				}
				return null;
			});
		},
	};
}

/**
 * Analyze every emitted executable in a sealed payload. Nothing may be resolved
 * from outside the payload, and only declared host peers may stay external.
 */
export async function analyzePayload(directory, files, manifest) {
	const inputs = new Set(files.filter((path) => /\.[cm]?js$/.test(path)).map((path) => resolve(directory, path)));
	const external = hostExternals(manifest);
	const analyzed = await build({
		entryPoints: [...inputs], outbase: directory, outdir: join(directory, ".validation-only"), write: false,
		bundle: true, platform: "node", format: "esm", target: "node22", metafile: true,
		external, plugins: [sealedClosurePlugin(directory, inputs)], logLevel: "silent",
	});
	if (Object.keys(analyzed.metafile.inputs).some((path) => isHostPath(path) || /node_modules[/\\]grok-mermaid[/\\]/.test(path))) {
		throw new Error(`${manifest.name}: artifact embeds a host package or retired dependency`);
	}
	for (const output of Object.values(analyzed.metafile.outputs)) {
		for (const entry of output.imports) {
			if (entry.external && !entry.path.startsWith("node:") && !matchesExternal(entry.path, external)) {
				throw new Error(`${manifest.name}: undeclared runtime import: ${entry.path}`);
			}
		}
	}
	return analyzed.metafile;
}

/** Seal a candidate payload: the record covers every packed file except itself. */
export async function sealPackageArtifact(pkg) {
	const sealPath = join(pkg.directory, SEAL_PATH);
	await mkdir(dirname(sealPath), { recursive: true });
	await writeFile(sealPath, "{}\n");
	const files = await packFiles(pkg.directory);
	if (!files.includes(SEAL_PATH)) throw new Error(`${pkg.name}: the packed payload must include ${SEAL_PATH}`);
	const seal = { format: 1, name: pkg.name, version: pkg.manifest.version,
		hashes: await hashListedFiles(pkg.directory, files, SEAL_PATH) };
	await writeFile(sealPath, JSON.stringify(seal, null, 2) + "\n");
	return seal;
}

/**
 * Verify a sealed payload. `sourceFiles` is the fresh pack listing of the build
 * side; without it the whole physical tree is compared, which rejects extra
 * files, symlinks and non-regular entries for deployment.
 */
export async function verifyPackageArtifact(directory, sourceFiles) {
	const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
	const seal = JSON.parse(await readFile(join(directory, SEAL_PATH), "utf8"));
	if (seal.format !== 1 || !seal.hashes || typeof seal.hashes !== "object") {
		throw new Error(`${manifest.name}: invalid package seal; rebuild before publication`);
	}
	if (seal.name !== manifest.name || seal.version !== manifest.version) {
		throw new Error(`${manifest.name}: package seal identity mismatch; rebuild before publication`);
	}
	const actual = sourceFiles ? await hashListedFiles(directory, sourceFiles, SEAL_PATH) : await hashPhysicalTree(directory);
	const changed = [...new Set([...Object.keys(seal.hashes), ...Object.keys(actual)])]
		.filter((path) => seal.hashes[path] !== actual[path]).sort();
	if (changed.length) throw new Error(`${manifest.name}: artifact integrity mismatch: ${changed.join(", ")}; rebuild before publication`);
	await analyzePayload(directory, Object.keys(actual).sort(), manifest);
	return seal;
}

/** Verify a source tree: compare the fresh pack listing instead of the whole tree. */
export async function verifySourcePackage(directory) {
	return verifyPackageArtifact(directory, await packFiles(directory));
}

/** Copy the packed payload to a deployment location, verifying both sides. */
export async function copyPackageArtifact(pkg, target) {
	const files = await packFiles(pkg.directory);
	await verifyPackageArtifact(pkg.directory, files);
	for (const path of files) {
		const destination = join(target, path);
		await mkdir(dirname(destination), { recursive: true });
		await cp(join(pkg.directory, path), destination);
	}
	return verifyPackageArtifact(target);
}
