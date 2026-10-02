import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const PI_PACKAGE_NAME = '@earendil-works/pi-coding-agent';

/** Resolve the installed host's bin metadata; no dependency on shell-task launch code. */
export function resolvePiCli(): { executable: string; args: string[] } {
  let root = dirname(fileURLToPath(import.meta.resolve(PI_PACKAGE_NAME)));
  while (!existsSync(join(root, 'package.json'))) {
    const parent = dirname(root);
    if (parent === root) throw new Error('Cannot locate installed Pi package manifest');
    root = parent;
  }
  const manifest: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (typeof manifest !== 'object' || manifest === null || Reflect.get(manifest, 'name') !== PI_PACKAGE_NAME) {
    throw new Error('Resolved manifest is not the Pi coding-agent package');
  }
  const bin: unknown = Reflect.get(manifest, 'bin');
  const entry: unknown = typeof bin === 'string' ? bin :
    typeof bin === 'object' && bin !== null ? Reflect.get(bin, 'pi') : undefined;
  if (typeof entry !== 'string') throw new Error('Installed Pi package has no pi bin');
  const cli = resolve(root, entry);
  if (!existsSync(cli)) throw new Error(`Installed Pi CLI is missing: ${cli}`);
  return { executable: process.execPath, args: [cli] };
}

/** An ordinary child command named pi, with no routing, wrapping, or model calls. */
export async function installFakeCli(
  root: string,
  options: { stdout: string; stderr?: string; delayMs?: number },
): Promise<{ command: string; argvPath: string }> {
  const dir = join(root, 'fake-cli');
  await mkdir(dir, { recursive: true });
  const script = join(dir, process.platform === 'win32' ? 'pi.cjs' : 'pi');
  const argvPath = join(dir, 'argv.json');
  await writeFile(script, [
    '#!/usr/bin/env node',
    `require('node:fs').writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));`,
    `const emit = () => { process.stdout.write(${JSON.stringify(options.stdout)}); process.stderr.write(${JSON.stringify(options.stderr ?? '')}); };`,
    `setTimeout(emit, ${String(options.delayMs ?? 0)});`,
    '',
  ].join('\n'), 'utf8');
  await chmod(script, 0o755);
  // JSON quoting is suitable for these filesystem paths on both test platforms.
  return {
    command: process.platform === 'win32' ? `"${process.execPath}" "${script}"` : `"${script}"`,
    argvPath,
  };
}
