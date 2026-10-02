import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { installedPackageDirectory } from "../helpers/workspace-dependencies.ts";

const root = resolve(import.meta.dirname, '../..');
void describe('clean build and runtime closure mutations', () => {
  void it('removes retired dist before compile and detects missing/deferred/orphan/stale JS/map payload', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'pi-bg-build-mutations-'));
    try {
      for (const path of ['package.json', 'tsconfig.build.json', 'tsconfig.base.json', 'src', 'extensions']) await cp(join(root, path), join(scratch, path), { recursive: true });
      await mkdir(join(scratch, 'scripts/docs'), { recursive: true });
      for (const path of ['scripts/build-runtime.mjs', 'scripts/docs/lib.mjs']) await cp(join(root, path), join(scratch, path));
      await symlink(dirname(installedPackageDirectory("typescript")), join(scratch, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      await mkdir(join(scratch, 'dist/extensions'), { recursive: true });
      await writeFile(join(scratch, 'dist/extensions/fusion-child.js'), 'retired artifact');
      const build = spawnSync(process.execPath, ['scripts/build-runtime.mjs'], { cwd: scratch, encoding: 'utf8', timeout: 60_000 });
      assert.equal(build.status, 0, `${build.stdout}${build.stderr}`);
      assert.equal(existsSync(join(scratch, 'dist/extensions/fusion-child.js')), false, 'build must clean first');
      const validate = () => spawnSync(process.execPath, ['--input-type=module', '-e', `import { assertRuntimeClosure } from ${JSON.stringify(pathToFileURL(join(scratch, 'scripts/docs/lib.mjs')).href)}; assertRuntimeClosure();`], { cwd: scratch, encoding: 'utf8', timeout: 30_000 });
      assert.equal(validate().status, 0);
      async function mutation(path: string, change: (text: string) => string, pattern: RegExp) {
        const original = await readFile(join(scratch, path), 'utf8');
        await writeFile(join(scratch, path), change(original));
        try {
          const result = validate();
          assert.notEqual(result.status, 0);
          assert.match(result.stderr, pattern);
        } finally { await writeFile(join(scratch, path), original); }
      }
      await mutation('dist/src/extension.js', (text) => text.replace("import('./ui/background-tasks-manager.js')", "import('./ui/missing.js')"), /runtime import closure missing/);
      await mutation('dist/src/extension.js', (text) => text + '\nconsole.log("stale compiled payload");\n', /compiled JavaScript differs/);
      await mutation('dist/src/extension.js.map', (text) => text.replace('Start a named long-running', 'Changed source-map text'), /source map stale\/mismatched/);
      const ui = join(scratch, 'dist/src/ui/background-tasks-manager.js');
      const bytes = await readFile(ui);
      await rm(ui);
      assert.match(validate().stderr, /runtime build artifacts/);
      await writeFile(ui, bytes);
      const orphan = join(scratch, 'dist/src/pi-telemetry-wrapper.js');
      await writeFile(orphan, 'retired wrapper');
      assert.match(validate().stderr, /runtime build artifacts/);
      await rm(orphan);
      assert.equal(validate().status, 0);
      await writeFile(join(scratch, 'src/extension.ts'), 'const broken: string = 42;\n');
      const failed = spawnSync(process.execPath, ['scripts/build-runtime.mjs'], { cwd: scratch, encoding: 'utf8', timeout: 60_000 });
      assert.notEqual(failed.status, 0);
      assert.equal(existsSync(join(scratch, 'dist/extensions/background-tasks.js')), false, 'failed compile must not leave old runtime entry');
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });
});
