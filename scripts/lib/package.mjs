import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyDist } from "./artifacts.mjs";
import { extensionEntries, root } from "./modules.mjs";
import { isolatedEnvironment } from "../preview.mjs";

const isHost = (name) => name.startsWith("@earendil-works/") || name === "typebox";

/** Project the npm v3 lock's reachable runtime graph; no second resolver/lock. */
export function runtimeLock(lock, manifest) {
	if (lock.lockfileVersion !== 3) throw new Error("Expected the workspace npm v3 lock");
	const packages = { "": {
		name: manifest.name, version: manifest.version,
		dependencies: manifest.dependencies, peerDependencies: manifest.peerDependencies,
		engines: manifest.engines,
	} };
	const queue = Object.keys(manifest.dependencies).map((name) => ({ name, parent: "" }));
	const seen = new Set();
	while (queue.length) {
		const { name, parent } = queue.shift();
		if (isHost(name)) throw new Error(`Runtime graph requires a physical host: ${name}`);
		let from = parent, key, record;
		while (true) {
			key = (from ? `${from}/` : "") + `node_modules/${name}`;
			record = lock.packages[key];
			if (record) break;
			if (!from) throw new Error(`Runtime dependency is not locked: ${name} from ${parent || "root"}`);
			const index = from.lastIndexOf("/node_modules/");
			from = index >= 0 ? from.slice(0, index) : "";
		}
		if (seen.has(key)) continue;
		seen.add(key);
		if (record.link || !record.integrity || !record.resolved) throw new Error(`Runtime dependency is not an immutable registry package: ${key}`);
		const { dev, devOptional, peer, ...runtime } = record;
		packages[key] = runtime;
		for (const dependency of Object.keys({ ...record.dependencies, ...record.optionalDependencies })) {
			queue.push({ name: dependency, parent: key });
		}
	}
	return { name: manifest.name, version: manifest.version, lockfileVersion: 3,
		requires: true, packages: Object.fromEntries(Object.entries(packages).sort(([a], [b]) => a.localeCompare(b))) };
}

export async function runtimeManifest() {
	const source = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	return {
		name: source.name, version: source.version, private: true, type: "module",
		description: source.description, engines: source.engines,
		pi: { extensions: extensionEntries }, dependencies: source.dependencies,
		peerDependencies: source.peerDependencies,
	};
}

async function noPhysicalHosts(directory, dependencyRoot = directory) {
	if (!(await lstat(directory)).isDirectory()) throw new Error(`Dependency root must be a real directory, not a symlink: ${directory}`);
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.name === ".bin") {
			if (!entry.isDirectory()) throw new Error(`Runtime executable directory is a link: ${path}`);
			for (const executable of await readdir(path)) {
				const link = join(path, executable);
				const stat = await lstat(link);
				const target = stat.isSymbolicLink() ? await realpath(link) : link;
				if (!target.startsWith(dependencyRoot + sep) || !(await lstat(target)).isFile()) {
					throw new Error(`Runtime executable link escapes its dependency tree: ${link}`);
				}
			}
			continue;
		}
		if (entry.isSymbolicLink()) throw new Error(`Runtime dependency is a link: ${path}`);
		if (!entry.isDirectory()) continue;
		if (entry.name === "@earendil-works" || entry.name === "typebox") throw new Error(`Physical host dependency: ${path}`);
		await noPhysicalHosts(path, dependencyRoot);
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
	await requireRegularFile(join(directory, "package-lock.json"));
	const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
	if (manifest.private !== true || manifest.type !== "module" || manifest.devDependencies || manifest.workspaces ||
		JSON.stringify(manifest.pi) !== JSON.stringify({ extensions: extensionEntries })) {
		throw new Error("Not a six-entry runtime-only Pi package");
	}
	if (JSON.stringify(manifest.dependencies) !== JSON.stringify({ "@llamaindex/liteparse": "2.10.1" })) {
		throw new Error("Runtime dependency contract changed");
	}
	await verifyDist(join(directory, "dist"));
	await noPhysicalHosts(join(directory, "node_modules"));
	const dependency = JSON.parse(await readFile(join(directory, "node_modules/@llamaindex/liteparse/package.json"), "utf8"));
	if (dependency.version !== "2.10.1") throw new Error("LiteParse runtime must be 2.10.1");
	let lock;
	try {
		lock = JSON.parse(await readFile(join(directory, "package-lock.json"), "utf8"));
		if (JSON.stringify(canonical(runtimeLock(lock, manifest))) !== JSON.stringify(canonical(lock))) {
			throw new Error("Runtime lock contains undeclared, development or mismatched records");
		}
	} catch (error) { throw new Error(`Invalid runtime lock: ${error.message}`, { cause: error }); }
	const artifacts = JSON.parse(await readFile(join(directory, "dist/artifacts.json"), "utf8"));
	const digest = createHash("sha256").update(JSON.stringify(canonical({ manifest, lock, artifacts }))).digest("hex");
	return { manifest, digest };
}

async function nativeProbe(directory) {
	const base = await mkdtemp(join(tmpdir(), "serraly-native-probe-"));
	try {
		const env = isolatedEnvironment(base);
		await mkdir(env.HOME, { recursive: true });
		const stream = "BT /F1 12 Tf 20 100 Td (pi-Serraly native probe) Tj ET";
		const objects = [
			"<< /Type /Catalog /Pages 2 0 R >>",
			"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
			"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
			"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
			`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		];
		let pdf = "%PDF-1.4\n";
		const offsets = [0];
		for (let i = 0; i < objects.length; i++) {
			offsets.push(Buffer.byteLength(pdf));
			pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
		}
		const xref = Buffer.byteLength(pdf);
		pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
		pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
		await writeFile(join(base, "probe.pdf"), pdf);
		const worker = pathToFileURL(join(directory, "dist/pi-docparser/native-worker.mjs")).href;
		const source = `
import { createRequire, syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs"; import { dirname, join } from "node:path";
import net from "node:net"; import http from "node:http"; import https from "node:https";
const reject = () => { throw new Error("Native qualification forbids networking"); };
globalThis.fetch = reject; net.Socket.prototype.connect = reject;
http.request = http.get = https.request = https.get = reject; syncBuiltinESMExports();
const require = createRequire(${JSON.stringify(worker)});
const metadataPath = require.resolve("@llamaindex/liteparse/package.json");
const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
const resolved = join(dirname(metadataPath), metadata.exports["."].import);
if (!resolved.startsWith(${JSON.stringify(join(directory, "node_modules") + sep)})) throw new Error("LiteParse resolved outside the runtime tree");
const { LiteParse } = await import(pathToFileURL(resolved).href);
const parser = new LiteParse({ ocrEnabled: false, quiet: true, numWorkers: 1 });
const parsed = await parser.parse(${JSON.stringify(join(base, "probe.pdf"))});
if (parsed.pages.length !== 1 || !parsed.text.includes("pi-Serraly native probe")) throw new Error("Native PDF probe returned invalid content");
for (const path of Object.keys(require.cache)) {
	if (path.endsWith(".node") && !path.startsWith(${JSON.stringify(directory + sep)})) throw new Error("Native binding resolved outside the runtime tree");
}
`;
		const child = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd: base, env, stdio: ["ignore", "pipe", "pipe"] });
		let diagnostics = "";
		child.stdout.on("data", (data) => { diagnostics += data; });
		child.stderr.on("data", (data) => { diagnostics += data; });
		const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
		try {
			const code = await new Promise((done, reject) => { child.once("error", reject); child.once("close", done); });
			if (code !== 0) throw new Error(`LiteParse native qualification failed (${code}): ${diagnostics.slice(-6000)}`);
		} finally { clearTimeout(timer); }
	} finally { await rm(base, { recursive: true, force: true }); }
}

export async function sealRelease(directory, { buildId } = {}) {
	await isolatedPath(directory);
	directory = await realpath(directory);
	const data = await releaseData(directory);
	await nativeProbe(directory);
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
	await nativeProbe(directory);
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
	const workspaceLock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
	const lock = runtimeLock(workspaceLock, manifest);
	if (buildId !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(buildId)) throw new Error("Invalid build id");
	await mkdir(dirname(output), { recursive: true });
	const stage = await mkdtemp(join(dirname(output), ".serraly-pending-"));
	try {
		await cp(join(root, "dist"), join(stage, "dist"), { recursive: true });
		await writeFile(join(stage, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
		await writeFile(join(stage, "package-lock.json"), JSON.stringify(lock, null, 2) + "\n");
		const sandbox = join(stage, ".install-sandbox");
		const env = isolatedEnvironment(sandbox);
		await mkdir(env.HOME, { recursive: true });
		const child = spawn("npm", ["ci", "--omit=dev", "--legacy-peer-deps", "--include=optional", "--ignore-scripts", "--no-audit", "--no-fund"],
			{ cwd: stage, env, stdio: ["ignore", "pipe", "pipe"] });
		let outputLog = "";
		child.stdout.on("data", (data) => { outputLog += data; });
		child.stderr.on("data", (data) => { outputLog += data; });
		const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
		try {
			const code = await new Promise((done, reject) => {
				child.once("error", reject); child.once("close", done);
			});
			if (code !== 0) throw new Error(`Runtime npm ci failed (${code}): ${outputLog}`);
		} finally { clearTimeout(timer); }
		await rm(sandbox, { recursive: true, force: true });
		const record = await sealRelease(stage, { buildId });
		await validateRelease(stage);
		// Destination was absent before install; an operator-created collision must
		// not be replaced by rename's directory semantics.
		await requireExternalDestination(output);
		await rename(stage, output);
		return { path: output, ...record };
	} finally { await rm(stage, { recursive: true, force: true }); }
}
