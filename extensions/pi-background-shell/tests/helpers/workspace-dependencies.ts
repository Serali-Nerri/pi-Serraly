import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve the actual ESM dependency, whether local or npm-workspace hoisted. */
export function installedPackageDirectory(name: string): string {
	let directory = dirname(fileURLToPath(import.meta.resolve(name)));
	while (true) {
		const manifest = join(directory, "package.json");
		if (existsSync(manifest)) {
			const value: unknown = JSON.parse(readFileSync(manifest, "utf8"));
			if (typeof value === "object" && value !== null && Reflect.get(value, "name") === name) return directory;
		}
		const parent = dirname(directory);
		if (parent === directory) throw new Error(`Cannot locate installed package ${name}`);
		directory = parent;
	}
}
