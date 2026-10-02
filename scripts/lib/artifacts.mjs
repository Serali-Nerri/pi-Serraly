import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { build } from "esbuild";
import { hostExternal, modules } from "./modules.mjs";

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

export async function validateDist(directory) {
	const files = (await filesIn(directory)).map((path) => resolve(path));
	const inputs = new Set(files); // Reject linked roots/children before opening executable text.
	for (const module of modules) {
		const output = join(directory, module.runtime);
		for (const path of ["index.js", ...(module.assets ?? []), ...module.licenses, ...(module.generatedLicenses ?? [])]) {
			try {
				const stat = await lstat(join(output, path));
				if (!stat.isFile() || stat.size === 0) throw new Error("Expected a nonempty regular file");
			} catch (error) { throw new Error(`Incomplete artifact: ${module.runtime}/${path}`, { cause: error }); }
		}
	}
	const externalImport = (path) => path.startsWith("node:") || path === "@llamaindex/liteparse" || hostExternal.some((pattern) =>
		pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern);
	// Analyze every emitted executable, including forked workers and lazy chunks.
	// Resolution must not read another tree and silently bundle it only in memory.
	const analyzed = await build({
		entryPoints: files.filter((path) => /\.[cm]?js$/.test(path)), outbase: resolve(directory),
		outdir: join(directory, ".validation-only"), write: false, bundle: true,
		platform: "node", format: "esm", target: "node22", metafile: true,
		external: [...hostExternal, "@llamaindex/liteparse"],
		plugins: [{
			name: "sealed-artifact-closure",
			setup(analyzer) {
				analyzer.onResolve({ filter: /.*/ }, (args) => {
					if (args.kind !== "entry-point" && /[%?#\\\u0000-\u001f\u007f]/.test(args.path)) {
						return { errors: [{ text: `Unsupported URL/escaped executable specifier: ${args.path}` }] };
					}
					if (externalImport(args.path)) return { path: args.path, external: true };
					const path = resolve(args.resolveDir, args.path);
					if ((!isAbsolute(args.path) && !args.path.startsWith(".")) || !inputs.has(path)) {
						return { errors: [{ text: `Executable input outside the sealed artifact closure: ${args.path}` }] };
					}
					return { path };
				});
				analyzer.onLoad({ filter: /.*/, namespace: "file" }, async (args) => {
					if (!inputs.has(args.path) || !(await lstat(args.path)).isFile()) {
						return { errors: [{ text: `Executable input outside the regular artifact closure: ${args.path}` }] };
					}
					return null;
				});
			},
		}],
		logLevel: "silent",
	});
	if (Object.keys(analyzed.metafile.inputs).some((path) => /node_modules[/\\](?:@earendil-works|typebox|grok-mermaid)[/\\]/.test(path))) {
		throw new Error("Artifact embeds a host package or retired UI Mermaid dependency");
	}
	for (const output of Object.values(analyzed.metafile.outputs)) {
		for (const entry of output.imports) {
			if (entry.external && !/^(?:node:|@earendil-works\/|typebox(?:\/|$)|@llamaindex\/liteparse$)/.test(entry.path)) {
				throw new Error(`Undeclared runtime import: ${entry.path}`);
			}
		}
	}
	return analyzed.metafile;
}

export async function artifactHashes(directory) {
	const hashes = {};
	for (const path of await filesIn(directory)) {
		const name = relative(directory, path).replaceAll("\\", "/");
		if (name === "artifacts.json") continue;
		hashes[name] = createHash("sha256").update(await readFile(path)).digest("hex");
	}
	return hashes;
}

export async function sealDist(directory) {
	await validateDist(directory);
	const hashes = await artifactHashes(directory);
	await writeFile(join(directory, "artifacts.json"), JSON.stringify({ format: 1, hashes }, null, 2) + "\n");
	return hashes;
}

export async function verifyDist(directory) {
	const actual = await artifactHashes(directory);
	const record = JSON.parse(await readFile(join(directory, "artifacts.json"), "utf8"));
	if (record.format !== 1 || !record.hashes || typeof record.hashes !== "object") {
		throw new Error("Invalid artifact integrity record: rebuild before publication");
	}
	const changed = [...new Set([...Object.keys(record.hashes), ...Object.keys(actual)])]
		.filter((name) => record.hashes[name] !== actual[name]).sort();
	if (changed.length) {
		throw new Error(`Artifact integrity mismatch: ${changed.join(", ")}; rebuild before publication`);
	}
	await validateDist(directory);
}
