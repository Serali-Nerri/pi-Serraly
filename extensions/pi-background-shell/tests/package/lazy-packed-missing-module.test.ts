import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';
import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import { installedPackageDirectory } from '../helpers/workspace-dependencies.ts';
import { loadRuntime } from './runtime-fixture.js';

const exec = promisify(execFile);
const packageRoot = resolve(import.meta.dirname, '../..');
function npmCli(): string {
  const candidates = [process.env['npm_execpath'], join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  const found = candidates.find((path) => path !== undefined && existsSync(path));
  if (found === undefined) throw new Error('npm-cli.js unavailable');
  return found;
}
async function pack(root: string): Promise<string> {
  for (const dir of ['home', 'tmp', 'cache', 'config', 'tarballs', 'unpacked']) await mkdir(join(root, dir));
  for (const file of ['user.npmrc', 'global.npmrc']) await writeFile(join(root, 'config', file), '');
  await writeFile(join(root, 'package.json'), '{"name":"packed-ui-check","private":true}\n');
  await writeFile(join(root, '.npmrc'), '');
  const result = await exec(process.execPath, [npmCli(), 'pack', packageRoot, '--ignore-scripts', '--json', '--pack-destination', join(root, 'tarballs')], {
    cwd: root, timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
    env: {
      PATH: process.env['PATH'] ?? '', ...(process.platform === 'win32' ? { SystemRoot: process.env['SystemRoot'], WINDIR: process.env['WINDIR'] } : {}),
      HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), TMPDIR: join(root, 'tmp'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'),
      npm_config_cache: join(root, 'cache'), npm_config_userconfig: join(root, 'config/user.npmrc'), npm_config_globalconfig: join(root, 'config/global.npmrc'),
      npm_config_registry: 'http://127.0.0.1.invalid/', CI: '1', GIT_ALLOW_PROTOCOL: 'file',
    },
  });
  const entries: unknown = JSON.parse(result.stdout);
  assert.ok(Array.isArray(entries));
  const entry: unknown = entries[0];
  assert.ok(typeof entry === 'object' && entry !== null);
  const filename: unknown = Reflect.get(entry, 'filename');
  assert.equal(typeof filename, 'string');
  if (typeof filename !== 'string') throw new Error('pack filename must be string');
  await exec('tar', ['-xzf', join(root, 'tarballs', filename), '-C', join(root, 'unpacked')], { timeout: 30_000 });
  return join(root, 'unpacked/package');
}
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try { await promise; } catch (error) { assert.ok(error instanceof Error); return error; }
  assert.fail('expected sticky deferred import error');
}
void describe('packed lazy task UI closure', { concurrency: false }, () => {
  void it('loads the intact dock through host peers, but missing UI does not break process startup or RPC fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-bg-packed-ui-'));
    let runtime: Awaited<ReturnType<typeof loadRuntime>> | undefined;
    try {
      const packed = await pack(root);
      assert.equal(existsSync(join(packed, 'node_modules')), false, 'no private SDK or production dependencies needed');
      runtime = await loadRuntime(join(packed, 'dist/extensions/background-tasks.js'));
      let uiCalls = 0;
      runtime.session.extensionRunner.setUIContext({
        ...runtime.session.extensionRunner.getUIContext(),
        custom: (async () => { uiCalls += 1; return undefined; }) as ExtensionUIContext['custom'],
        notify: () => undefined,
      }, 'tui');
      const intact = runtime.session.extensionRunner.getRegisteredCommands().find((command) => command.invocationName === 'tasks');
      assert.ok(intact);
      await intact.handler('', runtime.session.extensionRunner.createCommandContext());
      assert.equal(uiCalls, 1, 'deferred module must resolve host TUI libraries without bundled peers');
      assert.equal(runtime.session.extensionRunner.hasHandlers('before_agent_start'), false);
      await runtime.close(); runtime = undefined;

      // The shipped source imports the declared workspace kit, which a zero-dependency
      // payload does not carry: that path is a workspace path, not a release path.
      const sourceOnly = join(root, 'source-without-workspace');
      await cp(packed, sourceOnly, { recursive: true });
      const unresolved = await loadRuntime(join(sourceOnly, 'extensions/background-tasks.ts')).then(
        () => undefined,
        (error: unknown) => error,
      );
      assert.ok(unresolved instanceof Error, 'the bare workspace import cannot resolve without the workspace');
      assert.match(unresolved.message, /pi-ui-kit/);

      for (const [entry, missing] of [
        ['dist/extensions/background-tasks.js', 'dist/src/ui/background-tasks-manager.js'],
        ['extensions/background-tasks.ts', 'src/ui/background-tasks-manager.ts'],
        ['dist/extensions/background-tasks.js', 'dist/src/ui/task-log-viewport.js'],
        ['extensions/background-tasks.ts', 'src/ui/task-log-viewport.ts'],
      ] as const) {
        const damaged = join(root, `${entry.startsWith('dist/') ? 'damaged-dist' : 'damaged-source'}-${missing.includes('task-log-viewport') ? 'viewport' : 'manager'}`);
        await cp(packed, damaged, { recursive: true });
        await rm(join(damaged, missing));
        if (entry.startsWith('extensions/')) {
          // Workspace sources resolve the kit through the workspace link.
          await mkdir(join(damaged, 'node_modules'), { recursive: true });
          await symlink(installedPackageDirectory('pi-ui-kit'), join(damaged, 'node_modules/pi-ui-kit'), process.platform === 'win32' ? 'junction' : 'dir');
        }
        runtime = await loadRuntime(join(damaged, entry));
        assert.deepEqual(runtime.tools.map((tool) => tool.name).sort(), ['bg_kill', 'bg_logs', 'bg_run', 'bg_status']);
        const command = runtime.session.extensionRunner.getRegisteredCommands().find((candidate) => candidate.invocationName === 'tasks');
        assert.ok(command);
        const notices: string[] = [];
        let customCalls = 0;
        runtime.session.extensionRunner.setUIContext({
          ...runtime.session.extensionRunner.getUIContext(),
          notify: (message) => notices.push(message),
          custom: (async () => { customCalls += 1; return undefined; }) as ExtensionUIContext['custom'],
        }, 'json');
        await command.handler('', runtime.session.extensionRunner.createCommandContext());
        assert.equal(customCalls, 0);
        assert.ok(notices.some((message) => /bg_status\/bg_logs/.test(message)));
        runtime.session.extensionRunner.setUIContext(runtime.session.extensionRunner.getUIContext(), 'tui');
        const first = await rejection(Promise.resolve(command.handler('', runtime.session.extensionRunner.createCommandContext())));
        const second = await rejection(Promise.resolve(command.handler('', runtime.session.extensionRunner.createCommandContext())));
        assert.equal(first, second, 'failed deferred import must be sticky per activation');
        assert.match(first.message, /lazy_module_load_failed.*background-task-manager/);
        assert.match(first.message, missing.includes('task-log-viewport') ? /task-log-viewport/ : /background-tasks-manager/);
        assert.equal(customCalls, 0);
        const status = runtime.session.getToolDefinition('bg_status');
        assert.ok(status);
        const statusResult = await status.execute('ui-no-tasks', {}, undefined, undefined, runtime.session.extensionRunner.createToolContext('ui-no-tasks', undefined));
        assert.equal(JSON.stringify(statusResult.details), '{"tasks":[]}', 'UI failure cannot manufacture task work');
        await runtime.close(); runtime = undefined;
      }
    } finally {
      if (runtime !== undefined) await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
