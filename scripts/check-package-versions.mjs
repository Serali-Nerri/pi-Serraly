#!/usr/bin/env node
/**
 * Independent release-identity gate. Compares each workspace package with the
 * same package in a baseline Git tree: a changed release surface needs a higher
 * version, and a bundled library bump needs its consumers to move too.
 *
 * Only Git identity is read from the baseline, so old commits do not need the
 * current `serraly` schema. Remote branches and the registry are never queried.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { discoverPackages, root as repositoryRoot } from "./lib/packages.mjs";

const PACKAGE_MANIFEST = /^(?:modules|extensions|packages)\/[^/]+\/package\.json$/;
const GENERATED = /^(?:dist|\.build-dist-[^/]+)\//;

const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** Compare concrete semantic versions; returns > 0 when `left` is newer. */
export function compareVersions(left, right) {
	const parse = (value) => value.split("-")[0].split(".").map((part) => Number(part));
	const a = parse(left), b = parse(right);
	for (let index = 0; index < 3; index++) {
		if (a[index] !== b[index]) return a[index] - b[index];
	}
	return 0;
}

async function identityAt(root, ref) {
	const packages = new Map();
	for (const path of git(root, ["ls-tree", "-r", "--name-only", ref]).split("\n")) {
		if (!PACKAGE_MANIFEST.test(path)) continue;
		const manifest = JSON.parse(git(root, ["show", `${ref}:${path}`]));
		if (typeof manifest.name !== "string" || typeof manifest.version !== "string") continue;
		packages.set(manifest.name, { version: manifest.version, directory: path.slice(0, -"/package.json".length),
			test: manifest.serraly?.test,
			dependencies: { ...manifest.devDependencies, ...manifest.peerDependencies } });
	}
	return packages;
}

function isReleaseSurface(entry, path) {
	if (!path.startsWith(`${entry.directory}/`)) return false;
	const within = path.slice(entry.directory.length + 1);
	if (GENERATED.test(within)) return false;
	const testDirectory = entry.test?.directory ?? "test";
	return within !== testDirectory && !within.startsWith(`${testDirectory}/`);
}

/**
 * Report packages whose release identity is inconsistent with the baseline.
 * An empty result means every changed release surface carries a higher version.
 */
export async function checkPackageVersions({ root = repositoryRoot, base, head } = {}) {
	if (!base) throw new Error("checkPackageVersions requires a baseline Git ref");
	const basePackages = await identityAt(root, base);
	const headPackages = head === undefined
		? new Map((await discoverPackages(root)).map((pkg) => [pkg.name, {
			version: pkg.manifest.version,
			directory: pkg.relativeDirectory,
			test: pkg.manifest.serraly?.test,
			dependencies: { ...pkg.manifest.devDependencies, ...pkg.manifest.peerDependencies },
		}]))
		: new Map([...await identityAt(root, head)]);
	const changed = git(root, ["diff", "--name-only", ...(head === undefined ? [base] : [base, head])])
		.split("\n").filter(Boolean);
	const offenders = [];
	for (const [name, entry] of headPackages) {
		const surface = changed.filter((path) => isReleaseSurface(entry, path));
		if (surface.length === 0) continue;
		const baseline = basePackages.get(name);
		if (!baseline) continue; // A newly added package has no version to increase.
		if (compareVersions(entry.version, baseline.version) > 0) continue;
		// A bundled library bump invalidates the consumer's sealed payload, so name
		// it in the same diagnostic instead of reporting the package twice.
		const moved = Object.keys(entry.dependencies ?? {}).filter((dependency) => {
			const before = basePackages.get(dependency), after = headPackages.get(dependency);
			return before && after && before.version !== after.version;
		});
		offenders.push({ name, reason: `release surface changed (${surface.length} file(s)) but version stayed ${entry.version} (baseline ${baseline.version})`
			+ (moved.length ? `; bundled library ${moved.join(", ")} also moved` : "") });
	}
	return offenders;
}

/**
 * Whether the given ref resolves to a commit in this clone. Only a genuinely
 * unavailable baseline (a shallow clone or an all-zero event SHA) skips the diff
 * gate; a resolvable ref such as `HEAD~1`, a branch or a tag is always checked.
 */
async function baseIsAvailable(ref) {
	if (typeof ref !== "string" || ref === "" || /^0+$/.test(ref)) return false;
	try {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		await promisify(execFile)("git", ["-C", repositoryRoot, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
		return true;
	} catch { return false; }
}

function usage() {
	return "Usage: node scripts/check-package-versions.mjs --base <git-ref> [--head <git-ref>]";
}

async function main() {
	const args = process.argv.slice(2);
	let base, head;
	for (let index = 0; index < args.length; index++) {
		if (args[index] === "--base" && args[index + 1]) base = args[++index];
		else if (args[index] === "--head" && args[index + 1]) head = args[++index];
		else throw new Error(usage());
	}
	if (!base) throw new Error(usage());
	// CI passes the event's base/before SHA. A shallow clone or an all-zero SHA on a
	// new branch has no such commit, so the diff gate is skipped explicitly instead
	// of failing the run; the caller still executes the full verification.
	if (!(await baseIsAvailable(base))) {
		console.log(`check-package-versions: baseline ${base} is not available in this clone; skipping the diff gate (run the full verification instead)`);
		return;
	}
	const offenders = await checkPackageVersions({ root: resolve(repositoryRoot), base, head });
	if (offenders.length === 0) {
		console.log(`check-package-versions: no release-identity drift against ${base}${head ? `..${head}` : ""}`);
		return;
	}
	for (const offender of offenders) console.error(`${offender.name}: ${offender.reason}`);
	process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
	main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
