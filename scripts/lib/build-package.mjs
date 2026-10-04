import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { build } from "esbuild";
import { INTERNAL_PACKAGE_NAME, buildOrder } from "./packages.mjs";
import { sealPackageArtifact, verifySourcePackage } from "./package-artifacts.mjs";

// esbuild's CJS interop keeps a lexical `require`; native ESM guarantees no such
// binding, so a bundled CJS closure needs an explicit bridge.
const cjsRequireBridge =
	'import { createRequire as __piSerralyCreateRequire } from "node:module";\n' +
	"const require = __piSerralyCreateRequire(import.meta.url);\n";

const HOST_PATH = /node_modules[/\\](?:@earendil-works|typebox)(?:[/\\]|$)/;
const RETIRED_PATH = /node_modules[/\\]grok-mermaid(?:[/\\]|$)/;

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

/** Locate a dependency the way Node resolves it, without an exports subpath. */
function packageDirectory(from, name) {
	for (let directory = from; ; directory = dirname(directory)) {
		const candidate = join(directory, "node_modules", name);
		const manifest = join(candidate, "package.json");
		if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === name) return candidate;
		if (dirname(directory) === directory) throw new Error(`Cannot locate package directory: ${name} from ${from}`);
	}
}

function internalDependencies(pkg) {
	const resolved = new Map();
	for (const name of Object.keys(pkg.manifest.devDependencies ?? {})) {
		if (!INTERNAL_PACKAGE_NAME.test(name)) continue;
		try { resolved.set(name, realpathSync(packageDirectory(pkg.directory, name))); }
		catch { /* esbuild reports the unresolved internal dependency */ }
	}
	return resolved;
}

function classifyInput(pkg, libraries, path) {
	const real = realpathSync(path);
	if (real === pkg.directory || real.startsWith(pkg.directory + sep)) return { kind: "self" };
	if (HOST_PATH.test(real)) return { kind: "host" };
	if (RETIRED_PATH.test(real)) return { kind: "retired" };
	for (const [name, directory] of libraries) {
		if (real === directory || real.startsWith(directory + sep)) {
			return real.startsWith(join(directory, "dist") + sep) ? { kind: "library", name } : { kind: "library-private", name };
		}
	}
	if (real.includes(`${sep}node_modules${sep}`)) return { kind: "third-party" };
	return { kind: "foreign" };
}

/**
 * Bundle one entry into a candidate dist. Input ownership is checked against the
 * real resolution of every emitted input, not just the declared manifest.
 */
export async function bundleEntry(pkg, { entry, outfile, cjsRequire = false, sourcemap = false }) {
	const libraries = internalDependencies(pkg);
	const result = await build({
		entryPoints: [entry], outfile,
		bundle: true, platform: "node", format: "esm", target: "node22",
		external: (pkg.manifest.peerDependencies ? Object.keys(pkg.manifest.peerDependencies) : [])
			.flatMap((name) => [name, `${name}/*`]),
		legalComments: "eof", metafile: true, logLevel: "silent",
		...(cjsRequire ? { banner: { js: cjsRequireBridge } } : {}),
		// `linked` writes the map file and the sourceMappingURL reference the gates require.
		...(sourcemap ? { sourcemap: "linked", sourcesContent: true } : {}),
	});
	const bundled = new Set();
	for (const path of Object.keys(result.metafile.inputs)) {
		const input = classifyInput(pkg, libraries, path);
		if (input.kind === "host") throw new Error(`${pkg.name}: bundled host package input ${relative(pkg.directory, path)}`);
		if (input.kind === "retired") throw new Error(`${pkg.name}: bundled retired dependency ${relative(pkg.directory, path)}`);
		if (input.kind === "library-private") throw new Error(`${pkg.name}: bundled ${input.name} private source instead of its exports`);
		if (input.kind === "foreign") throw new Error(`${pkg.name}: bundled input outside the package: ${path}`);
		if (input.kind === "library") bundled.add(input.name);
	}
	return { metafile: result.metafile, libraries: bundled };
}

async function copyLicenses(pkg, dist) {
	for (const license of pkg.manifest.serraly?.licenses ?? []) {
		const target = join(dist, license);
		await mkdir(dirname(target), { recursive: true });
		await cp(join(pkg.directory, license), target);
	}
	for (const bundled of pkg.manifest.serraly?.bundledLicenses ?? []) {
		const importer = bundled.from ? packageDirectory(pkg.directory, bundled.from) : pkg.directory;
		const source = packageDirectory(importer, bundled.package);
		const target = join(dist, bundled.to);
		await mkdir(dirname(target), { recursive: true });
		await cp(join(source, bundled.file), target);
	}
}

/** A bundled internal library ships its declared license texts with the consumer. */
async function copyLibraryLicenses(pkg, dist, libraries) {
	for (const name of libraries) {
		const directory = packageDirectory(pkg.directory, name);
		const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
		for (const license of manifest.serraly?.licenses ?? []) {
			const target = join(dist, "licenses", name, license);
			await mkdir(dirname(target), { recursive: true });
			await cp(join(directory, license), target);
		}
	}
}

function distEntryPath(pkg) {
	const entry = pkg.manifest.pi?.extensions?.[0];
	if (!entry) throw new Error(`${pkg.name}: bundle recipes must declare a single pi.extensions entry`);
	return entry.replace(/^\.\/dist\//, "");
}

async function runRecipe(pkg, dist) {
	const recipe = pkg.manifest.serraly.build;
	if (recipe.kind === "bundle") {
		const { libraries } = await bundleEntry(pkg, {
			entry: resolve(pkg.directory, recipe.entry), outfile: join(dist, distEntryPath(pkg)), cjsRequire: recipe.cjsRequire === true,
		});
		await copyLibraryLicenses(pkg, dist, libraries);
	} else if (recipe.kind === "tsc") {
		const compiled = await run(process.execPath, [createRequire(import.meta.url).resolve("typescript/bin/tsc"),
			"--project", resolve(pkg.directory, recipe.project), "--outDir", dist], { cwd: pkg.directory });
		if (compiled.code !== 0) throw new Error(`${pkg.name}: compilation failed: ${compiled.stderr || compiled.stdout}`);
	} else if (recipe.kind === "script") {
		const built = await run(process.execPath, [resolve(pkg.directory, recipe.script), "--out-dir", dist], { cwd: pkg.directory });
		if (built.code !== 0) throw new Error(`${pkg.name}: build script failed: ${built.stderr || built.stdout}`);
		// A declared leaf is bundled after the script compiled the rest one-to-one,
		// so a multi-file runtime can inline a shared library without giving up its
		// own source maps.
		for (const [source, bundle] of Object.entries(recipe.bundles ?? {})) {
			const relativeOutput = relative(pkg.directory, resolve(pkg.directory, bundle.output));
			if (!relativeOutput.startsWith("dist/")) throw new Error(`${pkg.name}: bundled output must live under dist: ${bundle.output}`);
			const outfile = join(dist, relativeOutput.slice("dist/".length));
			const { libraries } = await bundleEntry(pkg, { entry: resolve(pkg.directory, source), outfile, sourcemap: true });
			await copyLibraryLicenses(pkg, dist, libraries);
		}
	} else {
		throw new Error(`${pkg.name}: unsupported build recipe ${JSON.stringify(recipe.kind)}`);
	}
	await copyLicenses(pkg, dist);
}

async function runArtifactVerifier(pkg, payload) {
	const script = pkg.manifest.serraly?.verifyArtifact;
	if (!script) return;
	const verified = await run(process.execPath, [resolve(pkg.directory, script), "--artifact-root", payload], { cwd: pkg.directory });
	if (verified.code !== 0) throw new Error(`${pkg.name}: artifact verifier failed: ${verified.stderr || verified.stdout}`);
}

/**
 * Swap the candidate dist into place, restoring the previous complete dist if
 * anything fails. The candidate is a sibling of the live dist so that emitted
 * source maps keep resolving to the package sources after the rename.
 */
async function withReplacedDist(directory, candidate, work) {
	const dist = join(directory, "dist");
	const retired = `${candidate}-retired`;
	let hasRetired = false;
	try { await rename(dist, retired); hasRetired = true; }
	catch (error) { if (error.code !== "ENOENT") throw error; }
	try {
		await rename(candidate, dist);
		await work();
	} catch (error) {
		await rm(dist, { recursive: true, force: true });
		if (hasRetired) await rename(retired, dist);
		throw error;
	}
	await rm(retired, { recursive: true, force: true });
}

/**
 * Build one package into its own dist. The candidate is compiled in a
 * `.build-dist-*` sibling, then sealed and verified in place; a failed build,
 * seal or verification restores the previous complete dist.
 */
export async function buildPackage(pkg) {
	const candidate = await mkdtemp(join(pkg.directory, ".build-dist-"));
	try {
		await runRecipe(pkg, candidate);
		let seal;
		await withReplacedDist(pkg.directory, candidate, async () => {
			seal = await sealPackageArtifact(pkg);
			await runArtifactVerifier(pkg, pkg.directory);
			await verifySourcePackage(pkg.directory);
		});
		return seal;
	} finally { await rm(candidate, { recursive: true, force: true }); }
}

/** Build the named packages (or all) with their internal dependencies first. */
export async function buildPackages(all, names) {
	const built = [];
	for (const pkg of buildOrder(all, names)) {
		await buildPackage(pkg);
		built.push(pkg.name);
	}
	return built;
}
