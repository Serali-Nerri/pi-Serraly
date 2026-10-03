#!/usr/bin/env node
import { resolve } from 'node:path';
import { PACKAGE_ROOT, runPayloadCheck } from './docs/lib.mjs';
import { verifyPackageArtifact } from '../../../scripts/lib/package-artifacts.mjs';

const args = process.argv.slice(2);
let artifactRoot = PACKAGE_ROOT;
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--artifact-root' && args[index + 1]) artifactRoot = resolve(args[++index]);
  else { console.error(`payload-check: unknown argument ${args[index]}`); process.exit(2); }
}

try {
  // Uses isolated npm config/home/cache and --ignore-scripts: no recursive prepack.
  const files = runPayloadCheck({ packageRoot: PACKAGE_ROOT, artifactRoot });
  await verifyPackageArtifact(artifactRoot, files);
  console.log(`payload-check: ${String(files.length)} packed files satisfy runtime/docs closure and the package seal; one shell entry, no orphan artifacts or bundled host peers.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
