#!/usr/bin/env node
import { runPayloadCheck } from './docs/lib.mjs';

if (process.argv.length !== 2) {
  console.error(`payload-check: unknown argument ${process.argv[2]}`);
  process.exit(2);
}

try {
  // Uses isolated npm config/home/cache and --ignore-scripts: no recursive prepack.
  const files = runPayloadCheck();
  console.log(`payload-check: ${String(files.length)} packed files satisfy runtime/docs closure; one shell entry, no orphan artifacts or bundled host peers.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
