import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { verifyDist } from "./artifacts.mjs";
import { extensionEntries, root } from "./modules.mjs";

/** Project the runtime manifest; a release is self-contained and installs nothing. */
export async function runtimeManifest() {
	const source = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	if (source.dependencies === undefined || Object.keys(source.dependencies).length) {
		throw new Error("Runtime-only release does not support installable dependencies");
	}
	return {
		name: source.name, version: source.version, private: true, type: "module",
		description: source.description, engines: source.engines,
		pi: { extensions: extensionEntries }, dependencies: {},
		peerDependencies: source.peerDependencies,
	};
}

/**
 * A release is a pure package tree: dependency directories, links and special
 * files would let an installed tree diverge from the sealed payload.
 */
async function requireNoInstalledTree(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isSymbolicLink()) throw new Error(`Release tree must not contain symlinks: ${path}`);
		if (entry.name === "node_modules") throw new Error(`Release tree must not contain dependency directories: ${path}`);
		if (entry.isDirectory()) { await requireNoInstalledTree(path); continue; }
		if (!entry.isFile()) throw new Error(`Release tree must contain only regular files: ${path}`);
	}
}

async function isolatedPath(directory) {
	const output = resolve(directory);
	if (output === root || output.startsWith(root + sep)) throw new Error("Runtime release must be outside the development dependency tree");
	if (output.split(sep).some((part) => ["extensions", "node_modules", ".pi", ".agents"].includes(part))) {
		throw new Error("Runtime stage must be outside automatic discovery and dependency trees");
	}
	for (let current = output; ; current = dirname(current)) {
		try {
			if ((await lstat(current)).isSymbolicLink()) throw new Error(`Runtime path has a symlink ancestor: ${current}`);
		} catch (error) { if (error.code !== "ENOENT") throw error; }
		if (current === dirname(current)) break;
	}
	for (let current = dirname(output); ; current = dirname(current)) {
		for (const name of ["@earendil-works", "typebox"]) {
			const candidate = join(current, "node_modules", name);
			try { await lstat(candidate); throw new Error(`Inherited physical host dependency: ${candidate}`); }
			catch (error) { if (error.code !== "ENOENT") throw error; }
		}
		if (current === dirname(current)) break;
	}
}

function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
	}
	return value;
}

async function requireRegularFile(path) {
	if (!(await lstat(path)).isFile()) throw new Error(`Release metadata must be a regular file, not a symlink: ${path}`);
}

async function releaseData(directory) {
	await isolatedPath(directory);
	await requireRegularFile(join(directory, "package.json"));
	const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
	if (manifest.private !== true || manifest.type !== "module" || manifest.devDependencies || manifest.workspaces ||
		JSON.stringify(manifest.pi) !== JSON.stringify({ extensions: extensionEntries })) {
		throw new Error("Not a current-entry runtime-only Pi package");
	}
	if (JSON.stringify(manifest.dependencies) !== JSON.stringify({})) {
		throw new Error("Runtime-only release must not declare installable dependencies");
	}
	await verifyDist(join(directory, "dist"));
	await requireNoInstalledTree(directory);
	const artifacts = JSON.parse(await readFile(join(directory, "dist/artifacts.json"), "utf8"));
	const digest = createHash("sha256").update(JSON.stringify(canonical({ manifest, artifacts }))).digest("hex");
	return { manifest, digest };
}

export async function sealRelease(directory, { buildId } = {}) {
	await isolatedPath(directory);
	directory = await realpath(directory);
	const data = await releaseData(directory);
	buildId ??= data.digest.slice(0, 16);
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(buildId)) throw new Error("Invalid build id");
	await writeFile(join(directory, "release.json"), JSON.stringify({
		format: 1, buildId, digest: data.digest, host: "1.0.0", createdAt: new Date().toISOString(),
	}, null, 2) + "\n", { flag: "wx" });
	return { buildId, digest: data.digest };
}

export async function validateRelease(directory) {
	await isolatedPath(directory);
	directory = await realpath(directory);
	await requireRegularFile(join(directory, "release.json"));
	const data = await releaseData(directory);
	const record = JSON.parse(await readFile(join(directory, "release.json"), "utf8"));
	if (record.format !== 1 || record.host !== "1.0.0" || record.digest !== data.digest ||
		typeof record.buildId !== "string" ||
		!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(record.buildId)) {
		throw new Error("Release digest or metadata integrity mismatch");
	}
	return data.manifest;
}

async function requireExternalDestination(output) {
	if (!isAbsolute(output)) throw new Error("Release destination must be absolute");
	await isolatedPath(output);
	try { await lstat(output); throw new Error(`Release already exists: ${output}`); }
	catch (error) { if (error.code !== "ENOENT") throw error; }
}

export async function createRelease(output, { buildId } = {}) {
	output = resolve(output);
	await requireExternalDestination(output);
	await verifyDist(join(root, "dist"));
	const manifest = await runtimeManifest();
	if (buildId !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(buildId)) throw new Error("Invalid build id");
	await mkdir(dirname(output), { recursive: true });
	const stage = await mkdtemp(join(dirname(output), ".serraly-pending-"));
	try {
		await cp(join(root, "dist"), join(stage, "dist"), { recursive: true });
		await writeFile(join(stage, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
		const record = await sealRelease(stage, { buildId });
		await validateRelease(stage);
		// Destination was absent before preparation; an operator-created collision must
		// not be replaced by rename's directory semantics.
		await requireExternalDestination(output);
		await rename(stage, output);
		return { path: output, ...record };
	} finally { await rm(stage, { recursive: true, force: true }); }
}
