import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hostPackage } from "../../scripts/lib/host.mjs";

function installation(t) {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "serraly-host-")));
	const keys = ["PI_UI_HOST_PACKAGE", "PI_MANAGED_INSTALL_ROOT"];
	const previous = new Map(keys.map((key) => [key, process.env[key]]));
	for (const key of keys) delete process.env[key];
	t.after(() => {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(base, { recursive: true, force: true });
	});
	return base;
}

function writeHost(directory) {
	mkdirSync(join(directory, "dist/bundle"), { recursive: true });
	writeFileSync(join(directory, "package.json"), JSON.stringify({
		name: "@earendil-works/pi-coding-agent", version: "1.1.0",
		bin: { pi: "dist/bundle/cli.js" },
	}));
	writeFileSync(join(directory, "dist/bundle/cli.js"), "// Fixture code; never launched.\n");
	return directory;
}

test("an explicit host override takes precedence over managed discovery and resolves its code location", (t) => {
	const base = installation(t);
	const directory = writeHost(join(base, "qualified-host"));
	const alias = join(base, "host-alias");
	symlinkSync(directory, alias);
	process.env.PI_UI_HOST_PACKAGE = alias;
	process.env.PI_MANAGED_INSTALL_ROOT = join(base, "missing-install");
	assert.deepEqual(hostPackage(), { directory, cli: join(directory, "dist/bundle/cli.js") });
});

test("host resolution uses the managed release independently of the Node installation", (t) => {
	const base = installation(t);
	const managedRoot = join(base, "install");
	const directory = writeHost(join(managedRoot, "releases/1.1.0/node_modules/@earendil-works/pi-coding-agent"));
	writeFileSync(join(managedRoot, "current-version"), "1.1.0\n");
	process.env.PI_MANAGED_INSTALL_ROOT = managedRoot;
	assert.deepEqual(hostPackage(), { directory, cli: join(directory, "dist/bundle/cli.js") });
});

test("an empty explicit host override cannot fall back to a managed release", (t) => {
	const managedRoot = join(installation(t), "install");
	writeHost(join(managedRoot, "releases/1.1.0/node_modules/@earendil-works/pi-coding-agent"));
	writeFileSync(join(managedRoot, "current-version"), "1.1.0\n");
	process.env.PI_MANAGED_INSTALL_ROOT = managedRoot;
	process.env.PI_UI_HOST_PACKAGE = "";
	assert.throws(() => hostPackage(), /PI_UI_HOST_PACKAGE/);
});

test("an empty configured managed root cannot select a host from the working directory", (t) => {
	const managedRoot = join(installation(t), "install");
	writeHost(join(managedRoot, "releases/1.1.0/node_modules/@earendil-works/pi-coding-agent"));
	writeFileSync(join(managedRoot, "current-version"), "1.1.0\n");
	process.env.PI_MANAGED_INSTALL_ROOT = "";
	const cwd = process.cwd();
	try {
		process.chdir(managedRoot);
		assert.throws(() => hostPackage(), /PI_MANAGED_INSTALL_ROOT/);
	} finally { process.chdir(cwd); }
});

test("an incomplete managed installation fails at its selected path without global fallback", async (t) => {
	for (const markerPresent of [false, true]) {
		await t.test(markerPresent ? "missing release" : "missing current-version", (t) => {
			const managedRoot = join(installation(t), "install");
			mkdirSync(managedRoot);
			if (markerPresent) writeFileSync(join(managedRoot, "current-version"), "1.1.0\n");
			process.env.PI_MANAGED_INSTALL_ROOT = managedRoot;
			assert.throws(() => hostPackage(), (error) => error.code === "ENOENT" && error.path.startsWith(managedRoot + "/"));
		});
	}
});

test("managed host resolution rejects empty or unsafe release pointers", async (t) => {
	for (const [version, packagePath] of [
		["\n", "releases/node_modules/@earendil-works/pi-coding-agent"],
		["../outside", "outside/node_modules/@earendil-works/pi-coding-agent"],
		["1.1.0/nested", "releases/1.1.0/nested/node_modules/@earendil-works/pi-coding-agent"],
	]) {
		await t.test(JSON.stringify(version), (t) => {
			const managedRoot = join(installation(t), "install");
			writeHost(join(managedRoot, packagePath));
			writeFileSync(join(managedRoot, "current-version"), version);
			process.env.PI_MANAGED_INSTALL_ROOT = managedRoot;
			assert.throws(() => hostPackage(), /current-version/);
		});
	}
});
