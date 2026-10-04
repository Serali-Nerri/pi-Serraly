#!/usr/bin/env node
/**
 * Compile the multi-file shell runtime. Without `--out-dir` the package's own
 * `dist` is rebuilt; `--out-dir` targets a candidate directory inside this
 * package (the staging payload used by the shared package builder).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertRuntimeClosure, PACKAGE_ROOT } from './docs/lib.mjs';

const args = process.argv.slice(2);
let outDirectory;
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--out-dir' && args[index + 1]) outDirectory = args[++index];
  else { console.error(`build-runtime: unknown argument ${args[index]}`); process.exit(2); }
}
const dist = outDirectory === undefined ? join(PACKAGE_ROOT, 'dist') : resolve(outDirectory);
if (outDirectory !== undefined) {
  if (!isAbsolute(outDirectory)) { console.error('build-runtime: --out-dir must be absolute'); process.exit(2); }
  if (dist === join(PACKAGE_ROOT, 'dist')) { console.error('build-runtime: --out-dir must not be the live dist'); process.exit(2); }
  if (relative(PACKAGE_ROOT, dist).startsWith('..') || relative(PACKAGE_ROOT, dist).includes(`..${sep}`)) {
    console.error('build-runtime: --out-dir must stay inside the package'); process.exit(2);
  }
}
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
// Clean before compiling, including on failed builds: retired entries cannot linger.
rmSync(dist, { recursive: true, force: true });
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
