import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isolatedPiEnv } from '../tests/helpers/normalize.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Use the pinned development host, never an ambient `pi` executable or config.
const sdkRoot = dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))));
const manifest: unknown = JSON.parse(await readFile(join(sdkRoot, 'package.json'), 'utf8'));
if (!isRecord(manifest) || !isRecord(manifest['bin']) || typeof manifest['bin']['pi'] !== 'string') {
  throw new Error('Pi SDK package does not expose its CLI bin');
}
const cli = resolve(sdkRoot, manifest['bin']['pi']);
const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'pi-background-shell-smoke-'));
const agentDir = join(scratch, 'agent');
const cwd = join(scratch, 'project');
const home = join(scratch, 'home');
const marker = 'PI_BACKGROUND_SHELL_SMOKE_READY';
const receipt = join(scratch, 'activation-receipt.txt');
const probe = join(scratch, 'smoke-probe.mjs');
await mkdir(cwd, { recursive: true });
await mkdir(home, { recursive: true });
try {
  // Print-mode ui.notify is silent and extension stdout may be redirected.
  // Use a fixture-local receipt written only after all declaration checks pass.
  // The temporary probe does not modify prompts or invoke any model.
  await writeFile(probe, `
import { writeFileSync } from 'node:fs';
export default function (pi) {
  pi.on('session_start', () => {
    const expected = ['bg_kill', 'bg_logs', 'bg_run', 'bg_status'];
    const declared = pi.getActiveTools().filter(name => expected.includes(name));
    if (declared.length > 0) throw new Error('Deferred tools must not be declared directly: ' + declared.join(','));
    const definitions = pi.getAllTools().filter(tool => expected.includes(tool.name));
    if (definitions.length !== 4 || definitions.some(tool => tool.exposure !== 'deferred')) {
      throw new Error('Background tools must register with deferred exposure');
    }
    if (definitions.some(tool => tool.namespace?.name !== 'background-shell')) {
      throw new Error('Background tools must share the background-shell namespace');
    }
    if (definitions.some(tool => !tool.description || tool.promptSnippet || tool.promptGuidelines?.length)) {
      throw new Error('Background tools must have description-only declarations');
    }
    const run = definitions.find(tool => tool.name === 'bg_run');
    if (!run?.parameters?.properties || 'isAgent' in run.parameters.properties) throw new Error('Unexpected bg_run schema');
    const commands = new Set(pi.getCommands().map(command => command.name));
    for (const name of ['bg', 'jobs', 'logs', 'kill', 'tasks', 'bg-tasks', 'bg-clear']) {
      if (!commands.has(name)) throw new Error('Missing command: ' + name);
    }
    writeFileSync(${JSON.stringify(receipt)}, ${JSON.stringify(marker)}, 'utf8');
  });
}
`, 'utf8');
  const result = spawnSync(
    process.execPath,
    [
      cli,
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '--no-themes',
      '--no-approve',
      '-e',
      join(root, 'dist/extensions/background-tasks.js'),
      '-e',
      probe,
      '--offline',
      '--no-builtin-tools',
      '--no-session',
      '-p',
      '/jobs',
    ],
    {
      cwd,
      encoding: 'utf8',
      env: isolatedPiEnv(agentDir, {
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_CACHE_HOME: join(home, '.cache'),
        PI_BG_POSIX_SHELL: 'sh',
        PI_BG_POSIX_SHELL_PATH: undefined,
        PI_BG_SHELL: 'cmd',
        PI_BG_DOCK_SHORTCUT: 'off',
        PI_BG_MAX_OUTPUT_BYTES: '1048576',
      }),
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`Pi ${String(manifest['version'])} smoke failed\n${String(result.error ?? '')}\n${result.stdout}\n${result.stderr}`);
  }
  if (
    (await readFile(receipt, 'utf8').catch(() => '')) !== marker ||
    /Extension error|Failed to load extension/iu.test(result.stderr)
  ) {
    throw new Error(`background shell extension activation was not verified\n${result.stdout}\n${result.stderr}`);
  }
  process.stdout.write(`smoke: Pi ${String(manifest['version'])} activated the compiled shell entry with four tools and seven commands; isolated offline configuration.\n`);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
