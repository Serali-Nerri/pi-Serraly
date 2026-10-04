import { discoverPackages } from "./lib/packages.mjs";
import { verifySourcePackage } from "./lib/package-artifacts.mjs";
import { assertSupportedNode } from "./lib/node-version.mjs";

/** Verify every existing artifact without rebuilding it. */
try {
	assertSupportedNode();
	for (const pkg of await discoverPackages()) {
		await verifySourcePackage(pkg.directory);
		console.log(`Verified ${pkg.name}@${pkg.manifest.version}`);
	}
} catch (error) { console.error(error.message); process.exitCode = 1; }
