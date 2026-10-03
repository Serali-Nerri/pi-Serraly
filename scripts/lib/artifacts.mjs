import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Walk a real artifact tree; links and special files are never payload. */
export async function filesIn(directory) {
	if (!(await lstat(directory)).isDirectory()) throw new Error(`Artifact root must be a real directory, not a symlink: ${directory}`);
	const paths = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isSymbolicLink()) throw new Error(`Artifact contains a symlink: ${path}`);
		if (entry.isDirectory()) paths.push(...await filesIn(path));
		else if (entry.isFile()) paths.push(path);
		else throw new Error(`Unsupported artifact: ${path}`);
	}
	return paths.sort();
}
