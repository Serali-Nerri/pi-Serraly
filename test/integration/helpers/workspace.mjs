import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Materialize a synthetic workspace so package discovery is exercised against
 * real files instead of a mocked manifest map.
 */
export async function workspaceFixture(t, definitions, { workspaces = ["extensions/*", "packages/*"], rootManifest = {} } = {}) {
	const base = await mkdtemp(join(tmpdir(), "serraly-workspace-"));
	t.after(async () => { await rm(base, { recursive: true, force: true }); });
	await writeFile(join(base, "package.json"), JSON.stringify({
		name: "fixture-root", version: "0.0.0", private: true, type: "module", workspaces, ...rootManifest,
	}, null, 2) + "\n");
	for (const definition of definitions) {
		const directory = join(base, definition.directory);
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "package.json"), JSON.stringify(definition.manifest, null, 2) + "\n");
		for (const [path, contents] of Object.entries(definition.files ?? {})) {
			const target = join(directory, path);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, contents);
		}
	}
	return { root: base };
}
