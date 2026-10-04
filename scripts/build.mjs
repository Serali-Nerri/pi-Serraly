import { discoverPackages } from "./lib/packages.mjs";
import { buildPackages } from "./lib/build-package.mjs";
import { assertSupportedNode } from "./lib/node-version.mjs";

assertSupportedNode();

/** Build every workspace package; internal libraries are built before consumers. */
const packages = await discoverPackages();
const built = await buildPackages(packages);
console.log(`Built ${built.length} package artifacts; host packages external and licenses verified.`);
