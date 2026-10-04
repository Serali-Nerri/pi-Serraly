import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { discoverPackages, root, selectExtensions } from "./packages.mjs";
import { SEAL_PATH, copyPackageArtifact, verifyPackageArtifact } from "./package-artifacts.mjs";

/** Acceptance is pinned to the qualified host; an explicit override must match. */
export const expectedHostVersion = "1.0.0";

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const byName = (a, b) => a.name.localeCompare(b.name);
const posix = (path) => path.split(sep).join("/");

function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
	}
	return value;
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

async function requireRegularFile(path) {
	if (!(await lstat(path)).isFile()) throw new Error(`Release metadata must be a regular file, not a symlink: ${path}`);
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

/** The aggregate manifest: release-relative entries, host peers, no install. */
export function runtimeManifest(packages, { version }) {
	const peers = {};
	for (const pkg of packages) {
		for (const [name, range] of Object.entries(pkg.manifest.peerDependencies ?? {})) peers[name] = range;
	}
	if (Object.keys(peers).length === 0) throw new Error("A release must declare its host peer dependencies");
	return {
		name: "pi-serraly", version, private: true, type: "module",
		description: "Independently selectable private Pi extensions.",
		engines: { node: ">=22.19.0" },
		pi: { extensions: [...packages].sort(byName).map((pkg) => `./${pkg.relativeDirectory}/${pkg.manifest.pi.extensions[0].slice(2)}`) },
		dependencies: {},
		peerDependencies: peers,
	};
}

async function releaseData(directory) {
	await isolatedPath(directory);
	await requireRegularFile(join(directory, "package.json"));
	const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
	if (manifest.private !== true || manifest.type !== "module" || manifest.devDependencies || manifest.workspaces) {
		throw new Error("Not a runtime-only Pi release manifest");
	}
	if (JSON.stringify(manifest.dependencies) !== JSON.stringify({})) {
		throw new Error("Runtime-only release must not declare installable dependencies");
	}
	const entries = manifest.pi?.extensions;
	if (!Array.isArray(entries) || entries.length === 0) throw new Error("Release manifest must declare its extension entries");
	const members = {};
	for (const entry of entries) {
		if (typeof entry !== "string" || !entry.startsWith("./extensions/") || !entry.endsWith(".js")) {
			throw new Error(`Release entry must be a release-relative ./extensions/*.js path: ${entry}`);
		}
		const parts = entry.slice(2).split("/");
		if (parts.length < 3 || parts[0] !== "extensions") throw new Error(`Release entry must live in a member directory: ${entry}`);
		const path = `${parts[0]}/${parts[1]}`;
		const packageRoot = join(directory, path);
		const expected = `./${parts.slice(2).join("/")}`;
		const memberManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
		if (JSON.stringify(memberManifest.pi?.extensions) !== JSON.stringify([expected])) {
			throw new Error(`${memberManifest.name}: release entry does not match the member manifest`);
		}
		if (members[memberManifest.name]) throw new Error(`Duplicate release member: ${memberManifest.name}`);
		await verifyPackageArtifact(packageRoot);
		members[memberManifest.name] = { version: memberManifest.version, path,
			digest: sha256(await readFile(join(packageRoot, SEAL_PATH))) };
	}
	const declared = new Set(Object.values(members).map((member) => member.path));
	for (const entry of await readdir(join(directory, "extensions"), { withFileTypes: true })) {
		if (!entry.isDirectory()) throw new Error(`Release extensions/ must contain member directories only: ${entry.name}`);
		if (!declared.has(`extensions/${entry.name}`)) throw new Error(`Undeclared release member directory: extensions/${entry.name}`);
	}
	await requireNoInstalledTree(directory);
	const digest = sha256(JSON.stringify(canonical({ manifest, packages: members })));
	return { manifest, members, digest };
}

export async function sealRelease(directory, { buildId, members } = {}) {
	await isolatedPath(directory);
	directory = await realpath(directory);
	const data = await releaseData(directory);
	buildId ??= data.digest.slice(0, 16);
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(buildId)) throw new Error("Invalid build id");
	await writeFile(join(directory, "release.json"), JSON.stringify({
		format: 1, buildId, digest: data.digest, host: expectedHostVersion, createdAt: new Date().toISOString(),
		packages: members ?? data.members,
	}, null, 2) + "\n", { flag: "wx" });
	return { buildId, digest: data.digest };
}

export async function validateRelease(directory) {
	await isolatedPath(directory);
	directory = await realpath(directory);
	await requireRegularFile(join(directory, "release.json"));
	const data = await releaseData(directory);
	const record = JSON.parse(await readFile(join(directory, "release.json"), "utf8"));
	if (record.format !== 1 || record.host !== expectedHostVersion || record.digest !== data.digest ||
		typeof record.buildId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(record.buildId)) {
		throw new Error("Release digest or metadata integrity mismatch");
	}
	if (JSON.stringify(canonical(record.packages)) !== JSON.stringify(canonical(data.members))) {
		throw new Error("Release member identity mismatch");
	}
	return data.manifest;
}

async function requireExternalDestination(output) {
	if (!isAbsolute(output)) throw new Error("Release destination must be absolute");
	await isolatedPath(output);
	try { await lstat(output); throw new Error(`Release already exists: ${output}`); }
	catch (error) { if (error.code !== "ENOENT") throw error; }
}

/**
 * Assemble an immutable release from already-built artifacts. Validation must
 * report a missing or corrupt payload, never repair it by invoking a builder.
 */
export async function createRelease(output, { buildId, packages: names } = {}) {
	output = resolve(output);
	await requireExternalDestination(output);
	const all = await discoverPackages();
	const selected = selectExtensions(all, names);
	if (buildId !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(buildId)) throw new Error("Invalid build id");
	const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
	await mkdir(dirname(output), { recursive: true });
	const stage = await mkdtemp(join(dirname(output), ".serraly-pending-"));
	try {
		const members = {};
		for (const pkg of [...selected].sort(byName)) {
			await copyPackageArtifact(pkg, join(stage, pkg.relativeDirectory));
			members[pkg.name] = { version: pkg.manifest.version, path: pkg.relativeDirectory,
				digest: sha256(await readFile(join(stage, pkg.relativeDirectory, SEAL_PATH))) };
		}
		await writeFile(join(stage, "package.json"), JSON.stringify(runtimeManifest(selected, { version }), null, 2) + "\n");
		const record = await sealRelease(stage, { buildId, members });
		await validateRelease(stage);
		// Destination was absent before preparation; an operator-created collision
		// must not be replaced by rename's directory semantics.
		await requireExternalDestination(output);
		await rename(stage, output);
		return { path: output, ...record };
	} finally { await rm(stage, { recursive: true, force: true }); }
}
