import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

/** Repository root; discovery only ever reads this project's own layout. */
export const root = resolve(import.meta.dirname, "../..");

const WORKSPACE_KINDS = { extensions: "extension", packages: "library" };
// Internal libraries are unscoped `pi-*` workspaces; anything else is external tooling.
export const INTERNAL_PACKAGE_NAME = /^pi-[a-z0-9-]+$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function reject(message) { throw new Error(message); }

function relativeEntry(name, directory, value, label) {
	if (typeof value !== "string" || !value.startsWith("./")) reject(`${name}: ${label} must be a package-relative ./ path: ${value}`);
	const parts = value.replace(/\/+$/, "").split("/");
	if (isAbsolute(value) || parts.includes("..") || parts.includes("")) reject(`${name}: ${label} escapes the package: ${value}`);
	const absolute = resolve(directory, value);
	if (absolute !== directory && !absolute.startsWith(directory + sep)) reject(`${name}: ${label} escapes the package: ${value}`);
	return value;
}

function assertManifestShape(name, manifest, directory, kind) {
	if (typeof name !== "string" || !name) reject(`${directory}: package name must be a non-empty string`);
	if (typeof manifest.version !== "string" || !SEMVER.test(manifest.version)) reject(`${name}: version must be a concrete semantic version`);
	if (manifest.private !== true) reject(`${name}: workspace packages must stay private`);
	if (manifest.type !== "module") reject(`${name}: package must be an ESM module`);
	if (manifest.engines?.node !== ">=22.19.0") reject(`${name}: engines.node must declare the supported Node baseline`);
	if (!Array.isArray(manifest.files) || manifest.files.length === 0) reject(`${name}: files must declare a non-empty packed allowlist`);
	for (const entry of manifest.files) relativeEntry(name, directory, entry.startsWith("./") ? entry : `./${entry}`, "files entry");
	if (!manifest.files.some((entry) => entry.replace(/\/$/, "") === "dist")) reject(`${name}: files must ship the built dist payload`);
	if (manifest.dependencies !== undefined && Object.keys(manifest.dependencies).length) {
		reject(`${name}: installable runtime dependencies are not supported; bundle them as devDependencies`);
	}
	const metadata = manifest.serraly;
	if (!metadata || typeof metadata !== "object") reject(`${name}: missing serraly metadata`);
	if (!Array.isArray(metadata.licenses) || metadata.licenses.length === 0) reject(`${name}: serraly.licenses must declare inherited license texts`);
	for (const license of metadata.licenses) relativeEntry(name, directory, `./${license}`, "license");
	const recipe = metadata.build;
	if (!recipe || typeof recipe !== "object") reject(`${name}: missing serraly build recipe`);
	if (recipe.kind === "bundle") {
		relativeEntry(name, directory, recipe.entry, "bundle entry");
		if (recipe.cjsRequire !== undefined && typeof recipe.cjsRequire !== "boolean") reject(`${name}: cjsRequire must be a boolean`);
	} else if (recipe.kind === "tsc") {
		relativeEntry(name, directory, recipe.project, "tsc project");
	} else if (recipe.kind === "script") {
		relativeEntry(name, directory, recipe.script, "build script");
		for (const [source, bundle] of Object.entries(recipe.bundles ?? {})) {
			relativeEntry(name, directory, `./${source}`, "bundled source");
			if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) reject(`${name}: bundle ${source} must declare its output`);
			relativeEntry(name, directory, `./${bundle.output}`, "bundled output");
			if (!Array.isArray(bundle.packages) || bundle.packages.length === 0) reject(`${name}: bundle ${source} must declare the bundled packages`);
			for (const bundled of bundle.packages) {
				if (typeof bundled !== "string" || !INTERNAL_PACKAGE_NAME.test(bundled)) reject(`${name}: bundle ${source} declares a non-workspace package ${bundled}`);
				if (manifest.devDependencies?.[bundled] === undefined) reject(`${name}: bundle ${source} package ${bundled} must be a devDependency`);
			}
		}
		if (recipe.verifyArtifact !== undefined) relativeEntry(name, directory, `./${recipe.verifyArtifact}`, "artifact verifier");
	} else {
		reject(`${name}: unsupported build recipe ${JSON.stringify(recipe.kind)}`);
	}
	if (metadata.test !== undefined) {
		if (!["test", "tests"].includes(metadata.test.directory)) reject(`${name}: serraly.test.directory must be test or tests`);
	}
	if (kind === "extension") {
		const entries = manifest.pi?.extensions;
		if (!Array.isArray(entries) || entries.length === 0) reject(`${name}: pi.extensions must declare at least one entry`);
		for (const entry of entries) {
			if (typeof entry !== "string" || !entry.startsWith("./dist/") || !entry.endsWith(".js")) {
				reject(`${name}: pi.extensions entry must be a built ./dist/*.js path: ${entry}`);
			}
			relativeEntry(name, directory, entry, "pi entry");
		}
	}
}

async function readPackage(directory, relativeDirectory, kind) {
	const manifestPath = join(directory, "package.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	const name = manifest.name;
	assertManifestShape(name, manifest, directory, kind);
	return { name, directory, relativeDirectory, kind, manifest };
}

function internalDependencies(pkg, byName) {
	const names = new Set();
	for (const source of ["devDependencies", "peerDependencies"]) {
		for (const name of Object.keys(pkg.manifest[source] ?? {})) {
			if (byName.has(name)) names.add(name);
		}
	}
	return [...names].sort();
}

function validateGraph(packages) {
	const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
	for (const pkg of packages) {
		for (const [source, entries] of [["devDependencies", pkg.manifest.devDependencies], ["peerDependencies", pkg.manifest.peerDependencies]]) {
			for (const [name, range] of Object.entries(entries ?? {})) {
				const dependency = byName.get(name);
				if (!dependency) {
					if (INTERNAL_PACKAGE_NAME.test(name)) reject(`${pkg.name}: dependency ${name} is not part of the workspace`);
					continue;
				}
				if (source === "peerDependencies") reject(`${pkg.name}: bundled library ${name} must be a devDependency, not a peer`);
				if (range !== dependency.manifest.version) reject(`${pkg.name}: internal dependency ${name} must use the exact version ${dependency.manifest.version}`);
				if (pkg.kind === "extension" && dependency.kind === "extension") reject(`${pkg.name}: extension cannot depend on extension ${name}`);
			}
		}
	}
	const visiting = new Set(), visited = new Set();
	const visit = (pkg) => {
		if (visited.has(pkg.name)) return;
		if (visiting.has(pkg.name)) reject(`Internal dependency cycle at ${pkg.name}`);
		visiting.add(pkg.name);
		for (const name of internalDependencies(pkg, byName)) visit(byName.get(name));
		visiting.delete(pkg.name);
		visited.add(pkg.name);
	};
	for (const pkg of packages) visit(pkg);
	return byName;
}

async function readWorkspaceChildren(parent, kind) {
	let entries;
	try { entries = await readdir(parent, { withFileTypes: true }); }
	catch (error) { if (error.code === "ENOENT") return []; throw error; }
	const packages = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name.startsWith(".")) continue;
		const directory = join(parent, entry.name);
		if (!entry.isDirectory()) {
			if (entry.isSymbolicLink()) reject(`Workspace package must be a real directory, not a symlink: ${directory}`);
			continue;
		}
		packages.push(await readPackage(directory, `${kind === "extension" ? "extensions" : "packages"}/${entry.name}`, kind));
	}
	return packages;
}

/**
 * Discover workspace packages from the root manifest's own top-level globs.
 * Unmatched globs are empty; every other contract violation fails closed.
 */
export async function discoverPackages(repositoryRoot = root) {
	const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
	const workspaces = manifest.workspaces;
	if (!Array.isArray(workspaces) || workspaces.length === 0) reject("Root manifest must declare workspace globs");
	const packages = [];
	const seen = new Set();
	for (const pattern of workspaces) {
		const match = /^([a-z-]+)\/\*$/.exec(pattern);
		if (!match || !WORKSPACE_KINDS[match[1]]) reject(`Unsupported workspace pattern: ${pattern}`);
		for (const pkg of await readWorkspaceChildren(join(repositoryRoot, match[1]), WORKSPACE_KINDS[match[1]])) {
			if (seen.has(pkg.name)) reject(`Duplicate package name in the workspace: ${pkg.name}`);
			seen.add(pkg.name);
			packages.push(pkg);
		}
	}
	validateGraph(packages);
	return packages.sort((a, b) => a.name.localeCompare(b.name));
}

function requireSelection(all, names) {
	const byName = new Map(all.map((pkg) => [pkg.name, pkg]));
	const seen = new Set();
	return names.map((name) => {
		if (typeof name !== "string" || !name) reject("Package selection requires non-empty names");
		if (seen.has(name)) reject(`Duplicate package selection: ${name}`);
		seen.add(name);
		const pkg = byName.get(name);
		if (!pkg) reject(`Unknown package: ${name}`);
		return pkg;
	});
}

/** Internal dependencies before their consumers; stable for independent packages. */
export function buildOrder(all, names) {
	const byName = new Map(all.map((pkg) => [pkg.name, pkg]));
	const selected = names === undefined ? [...all] : requireSelection(all, names);
	const ordered = [], visiting = new Set(), visited = new Set();
	const visit = (pkg) => {
		if (visited.has(pkg.name)) return;
		if (visiting.has(pkg.name)) reject(`Internal dependency cycle at ${pkg.name}`);
		visiting.add(pkg.name);
		for (const name of internalDependencies(pkg, byName)) visit(byName.get(name));
		visiting.delete(pkg.name);
		visited.add(pkg.name);
		ordered.push(pkg);
	};
	for (const pkg of [...selected].sort((a, b) => a.name.localeCompare(b.name))) visit(pkg);
	return ordered;
}

/** Release membership is extensions only; a library name is never a valid choice. */
export function selectExtensions(all, names) {
	const extensions = all.filter((pkg) => pkg.kind === "extension");
	if (names === undefined) return extensions;
	return requireSelection(all, names).map((pkg) => {
		if (pkg.kind !== "extension") reject(`${pkg.name} is a library, not a release extension`);
		return pkg;
	});
}
