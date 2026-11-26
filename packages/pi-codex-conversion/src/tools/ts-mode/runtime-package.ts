import { readFile, realpath } from "node:fs/promises";
import { createRequire, findPackageJSON } from "node:module";
import { join } from "node:path";
import { cacheExactNpmImport } from "./npm-cache.ts";

interface RuntimePackage {
	resolve: NodeJS.RequireResolve;
	manifest: string;
}
export class RuntimeInstallError extends Error {}

/** Reuse an exact installed payload when available, otherwise install on demand. */
export async function runtimePackage(
	name: string,
	version: string,
	agentDir: string,
	mode: string,
	signal?: AbortSignal,
	verify?: (pkg: RuntimePackage) => Promise<void> | void,
): Promise<RuntimePackage> {
	signal?.throwIfAborted();
	try {
		const manifest = findPackageJSON(name, import.meta.url);
		if (manifest) {
			const value: unknown = JSON.parse(await readFile(manifest, "utf8"));
			if (
				value &&
				typeof value === "object" &&
				"name" in value &&
				value.name === name &&
				"version" in value &&
				value.version === version
			) {
				// Resolve workspace symlinks (Bun/pnpm) so optionalDependencies resolve beside the real package.
				const resolvedManifest = await realpath(manifest);
				const candidate: RuntimePackage = {
					resolve: createRequire(resolvedManifest).resolve,
					manifest: resolvedManifest,
				};
				const valid = verify
					? await Promise.resolve()
							.then(() => verify(candidate))
							.then(
								() => true,
								() => false,
							)
					: true;
				if (valid) return candidate;
			}
		}
	} catch (error) {
		if (
			!(
				error instanceof Error &&
				"code" in error &&
				(error.code === "ERR_MODULE_NOT_FOUND" || error.code === "ENOENT")
			)
		)
			throw error;
	}
	try {
		const location = await cacheExactNpmImport(
			`npm:${name}@${version}`,
			join(agentDir, "cache", "pi-codex-conversion", "runtimes"),
			signal,
			true,
			verify
				? {
						verify: (manifest) =>
							verify({ resolve: createRequire(manifest).resolve, manifest }),
					}
				: undefined,
		);
		const manifest = join(location.cwd, "node_modules", name, "package.json");
		return { resolve: createRequire(manifest).resolve, manifest };
	} catch (cause) {
		signal?.throwIfAborted();
		throw new RuntimeInstallError(
			`${mode} runtime install failed. Check npm and registry access before retrying. Other modes remain available.`,
			{ cause },
		);
	}
}
