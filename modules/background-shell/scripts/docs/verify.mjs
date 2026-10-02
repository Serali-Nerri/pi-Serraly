#!/usr/bin/env node
import { verify } from './lib.mjs';
if (process.argv.length !== 2) {
  console.error(`docs-verify: unknown argument ${process.argv[2]}`);
  process.exit(2);
}
try {
  const result = await verify();
  console.log(`docs-verify: ${result.codeFacts.public_surface_ids.length} surfaces, ${result.codeFacts.governed_sources.length} sources; deterministic schema/docs generation OK.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
