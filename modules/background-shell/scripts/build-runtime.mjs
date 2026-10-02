#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { assertRuntimeClosure, PACKAGE_ROOT } from './docs/lib.mjs';

const dist = join(PACKAGE_ROOT, 'dist');
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
// Clean before compiling, including on failed builds: retired entries cannot linger.
rmSync(dist, { recursive: true, force: true });
const result = spawnSync(process.execPath, [tsc, '--project', join(PACKAGE_ROOT, 'tsconfig.build.json')], {
  cwd: PACKAGE_ROOT, encoding: 'utf8', env: process.env,
});
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout || result.error?.message || 'runtime TypeScript build failed\n');
  process.exit(result.status ?? 1);
}
const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
writeFileSync(join(dist, 'package.json'), `${JSON.stringify({ name: manifest.name, version: manifest.version, type: 'module' }, null, 2)}\n`);
assertRuntimeClosure();
console.log('runtime-build: one background JavaScript entry, source maps and complete deferred closure; no orphan artifacts.');
