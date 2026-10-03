import { discoverPackages } from "./lib/packages.mjs";
import { verifySourcePackage } from "./lib/package-artifacts.mjs";

/** Verify every existing artifact without rebuilding it. */
try {
	for (const pkg of await discoverPackages()) {
		await verifySourcePackage(pkg.directory);
		console.log(`Verified ${pkg.name}@${pkg.manifest.version}`);
	}
} catch (error) { console.error(error.message); process.exitCode = 1; }
