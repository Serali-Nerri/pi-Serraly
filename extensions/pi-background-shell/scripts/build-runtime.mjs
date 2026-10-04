#!/usr/bin/env node
/**
 * Compile the multi-file shell runtime into a candidate directory inside this
 * package. `--out-dir` is required and must be new or empty: the shared package
 * builder owns the live `dist`, its atomic replacement and its cleanup, so this
 * script never removes a directory it did not create.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertRuntimeClosure, PACKAGE_ROOT } from './docs/lib.mjs';

const args = process.argv.slice(2);
let outDirectory;
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--out-dir' && args[index + 1]) outDirectory = args[++index];
  else { console.error(`build-runtime: unknown argument ${args[index]}`); process.exit(2); }
}
if (outDirectory === undefined) {
  console.error('build-runtime: --out-dir <absolute candidate directory> is required; the shared package builder owns the live dist');
  process.exit(2);
}
if (!isAbsolute(outDirectory)) { console.error('build-runtime: --out-dir must be absolute'); process.exit(2); }
const dist = resolve(outDirectory);
const inside = relative(PACKAGE_ROOT, dist);
if (dist === PACKAGE_ROOT || inside === '' || inside.startsWith('..') || inside.includes(`..${sep}`)) {
  console.error('build-runtime: --out-dir must be a candidate directory inside the package, never the package root');
  process.exit(2);
}
if (dist === join(PACKAGE_ROOT, 'dist')) { console.error('build-runtime: --out-dir must not be the live dist'); process.exit(2); }
if (existsSync(dist) && readdirSync(dist).length > 0) {
  console.error(`build-runtime: --out-dir must be new or empty: ${dist}`);
  process.exit(2);
}
mkdirSync(dist, { recursive: true });
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const result = spawnSync(process.execPath, [tsc, '--project', join(PACKAGE_ROOT, 'tsconfig.build.json'), '--outDir', dist], {
  cwd: PACKAGE_ROOT, encoding: 'utf8', env: process.env,
});
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout || result.error?.message || 'runtime TypeScript build failed\n');
  process.exit(result.status ?? 1);
}
const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
writeFileSync(join(dist, 'package.json'), `${JSON.stringify({ name: manifest.name, version: manifest.version, type: 'module' }, null, 2)}\n`);
// The shared package builder inlines declared bundle leaves after this script,
// so this gate runs in the pre-bundle phase; payload/pack gates require the bundle.
assertRuntimeClosure(PACKAGE_ROOT, { distDirectory: dist, preBundle: true });
console.log('runtime-build: one background JavaScript entry, source maps and complete deferred closure; no orphan artifacts.');
