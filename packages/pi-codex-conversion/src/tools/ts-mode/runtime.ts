import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import manifest from "../../../package.json" with { type: "json" };
import { runtimePackage } from "./runtime-package.ts";

export interface TsRuntime {
	api: typeof import("tsrs/async");
	ast: typeof import("tsrs/ast");
	fs: typeof import("tsrs/fs");
	typeRoots: string[];
	launcher: string;
}

export function verifyTsrsBinary(
	pkg: { resolve: (id: string) => string },
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): void {
	const override = process.env["TSRS_BINARY"];
	if (override && existsSync(override)) return;
	const candidates =
		platform === "linux"
			? [`@tsrs/linux-${arch}-gnu`, `@tsrs/linux-${arch}-musl`]
			: [`@tsrs/${platform}-${arch}`];
	const binary = platform === "win32" ? "tsrs.exe" : "tsrs";
	for (const candidate of candidates) {
		let resolved: string | undefined;
		try {
			resolved = pkg.resolve(`${candidate}/package.json`);
		} catch {
			continue;
		}
		if (existsSync(join(dirname(resolved), binary))) return;
	}
	throw new Error(`Missing tsrs binary for ${platform}-${arch}`);
}

export async function loadTsRuntime(
	agentDir: string,
	signal?: AbortSignal,
): Promise<TsRuntime> {
	const compiler = await runtimePackage(
		"tsrs",
		manifest.devDependencies.tsrs,
		agentDir,
		"TS",
		signal,
		verifyTsrsBinary,
	);
	const node = await runtimePackage(
		"@types/node",
		manifest.devDependencies["@types/node"],
		agentDir,
		"TS",
		signal,
	);
	const [api, ast, fs]: [TsRuntime["api"], TsRuntime["ast"], TsRuntime["fs"]] =
		await Promise.all([
			import(pathToFileURL(compiler.resolve("tsrs/async")).href),
			import(pathToFileURL(compiler.resolve("tsrs/ast")).href),
			import(pathToFileURL(compiler.resolve("tsrs/fs")).href),
		]);
	return {
		api,
		ast,
		fs,
		typeRoots: [dirname(dirname(node.resolve("@types/node/package.json")))],
		launcher: join(dirname(compiler.manifest), "bin", "tsrs"),
	};
}
