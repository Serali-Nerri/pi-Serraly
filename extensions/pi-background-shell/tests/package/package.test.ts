import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { installedPackageDirectory } from '../helpers/workspace-dependencies.ts';
import { parseJsonText } from '../../src/core/common.js';
import { startInstalledDependencyRegistry } from '../helpers/offline-npm-registry.js';
import { findFileUrlPathnameViolations } from '../helpers/typescript-source-guards.js';
import { loadRuntime, nextTerminal, record, stringField } from './runtime-fixture.js';

// npm ships as npm.cmd on Windows, and spawnSync with shell:false does not
// consult PATHEXT, so spawning the bare name yields status null with no child.
// Resolving npm's own JavaScript entry and running it through the current Node
// executable avoids the shim without introducing shell:true, mirroring how
// production resolves the Pi bin.
function resolveNpmCli(): string {
  const nodeDir = dirname(process.execPath);
  const candidates = [
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot resolve npm-cli.js near ${process.execPath}`);
}

const npmCli = resolveNpmCli();

interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

type NpmIgnoreScriptsObservation = readonly [
  version: string,
  status: number | null,
  output: string,
  markers: readonly string[],
];

function requireSupportedNpmVersion(rawVersion: string): string {
  const version = rawVersion.trim();
  const match = /^(\d+)\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.exec(version);
  assert.ok(
    match,
    `expected npm --version to report a semantic version, received ${JSON.stringify(rawVersion)}`,
  );
  const npmMajor = Number(match[1]);
  assert.ok(
    Number.isSafeInteger(npmMajor) && npmMajor >= 10,
    `expected npm >=10, received ${version}`,
  );
  return version;
}

function assertNpmIgnoreScriptsObservation(
  versionText: string,
  status: number | null,
  output: string,
  markers: readonly string[],
): void {
  const version = requireSupportedNpmVersion(versionText);
  if (status === 0 && markers.length === 0) return;

  const isKnownNpm1093PrepareDefect =
    version === '10.9.3' &&
    status === 1 &&
    output.includes('sentinel lifecycle executed: prepare') &&
    markers.length === 1 &&
    markers[0] === 'prepare';
  if (isKnownNpm1093PrepareDefect) return;

  assert.fail(
    `unexpected npm pack --ignore-scripts lifecycle observation for npm ${version}: ` +
      `status=${String(status)} markers=${JSON.stringify(markers)} output=${JSON.stringify(output)}`,
  );
}

function runNpm(
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): CommandResult {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runNpmAsync(
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [npmCli, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (status) => {
      resolveResult({
        status,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

interface PackageJson {
  name: string;
  type: string;
  keywords: string[];
  pi: { extensions: string[]; image?: string | undefined };
  scripts: Record<string, string>;
  files: string[];
  peerDependencies: Record<string, string>;
  dependencies?: Record<string, string> | undefined;
  devDependencies?: Record<string, string> | undefined;
  serraly: { build: { kind: string; script: string; verifyArtifact?: string } };
}

interface NpmPackFile {
  path: string;
}

interface NpmPackEntry {
  filename: string;
  files: NpmPackFile[];
}

interface SourceViolation {
  file: string;
  rule: string;
  excerpt: string;
}

const root = new URL('../../', import.meta.url);

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function field(value: object, key: string): unknown {
  const property: unknown = Reflect.get(value, key);
  return property;
}

function parseJsonValue(text: string): unknown {
  return parseJsonText(text);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  assert.ok(
    value.every((item) => typeof item === 'string'),
    `${label} must contain strings`,
  );
  return value;
}

function parsePackageJson(value: unknown): PackageJson {
  assert.ok(isObject(value), 'package.json must be an object');
  const name = requireString(field(value, 'name'), 'name');
  const type = requireString(field(value, 'type'), 'type');
  const pi = field(value, 'pi');
  const scripts = field(value, 'scripts');
  const peerDependencies = field(value, 'peerDependencies');
  const serraly = field(value, 'serraly');
  assert.ok(isObject(pi));
  assert.ok(isObject(scripts));
  assert.ok(isObject(peerDependencies));
  assert.ok(isObject(serraly));
  const build = field(serraly, 'build');
  assert.ok(isObject(build));
  return {
    name,
    type,
    keywords: requireStringArray(field(value, 'keywords'), 'keywords'),
    pi: {
      extensions: requireStringArray(field(pi, 'extensions'), 'pi.extensions'),
      image: typeof field(pi, 'image') === 'string' ? (field(pi, 'image') as string) : undefined,
    },
    scripts: Object.fromEntries(
      Object.entries(scripts).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
    files: requireStringArray(field(value, 'files'), 'files'),
    serraly: {
      build: {
        kind: requireString(field(build, 'kind'), 'serraly.build.kind'),
        script: requireString(field(build, 'script'), 'serraly.build.script'),
        ...(typeof field(build, 'verifyArtifact') === 'string'
          ? { verifyArtifact: field(build, 'verifyArtifact') as string }
          : {}),
      },
    },
    peerDependencies: Object.fromEntries(
      Object.entries(peerDependencies).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
    dependencies: stringRecordField(value, 'dependencies'),
    devDependencies: stringRecordField(value, 'devDependencies'),
  };
}

function stringRecordField(value: object, key: string): Record<string, string> | undefined {
  const raw = field(value, key);
  if (raw === undefined) return undefined;
  assert.ok(isObject(raw), `${key} must be an object`);
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

async function pkg(): Promise<PackageJson> {
  return parsePackageJson(parseJsonValue(await readFile(new URL('package.json', root), 'utf8')));
}

async function text(file: string): Promise<string> {
  return readFile(new URL(file, root), 'utf8');
}

async function walkSourceTree(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walkSourceTree(path)));
    else if (/\.ts$/.test(entry.name)) files.push(path);
  }
  return files;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function compactExcerpt(source: string): string {
  return source.replace(/\s+/g, ' ').trim().slice(0, 180);
}

function isPathLikeParameter(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'path' || lower === 'file' || lower.endsWith('path');
}

function isPathSyncHelperName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith('write') || lower.startsWith('replace')) return false;
  if (
    lower === 'fsync' ||
    lower === 'sync' ||
    lower === 'fsyncfile' ||
    lower === 'fsyncpath' ||
    lower === 'syncfile' ||
    lower === 'syncpath'
  )
    return true;
  if (lower.includes('fsync') && (lower.includes('file') || lower.includes('path'))) return true;
  return lower.startsWith('sync') && (lower.includes('file') || lower.includes('path'));
}

function addPatternViolations(
  violations: SourceViolation[],
  file: string,
  rule: string,
  source: string,
  pattern: RegExp,
): void {
  for (const match of source.matchAll(pattern)) {
    violations.push({ file, rule, excerpt: compactExcerpt(match[0] ?? '') });
  }
}

function addExportedPathSyncViolations(
  violations: SourceViolation[],
  file: string,
  source: string,
): void {
  const exportedFunction =
    /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\b/g;
  for (const match of source.matchAll(exportedFunction)) {
    const name = match[1];
    const parameter = match[2];
    if (
      name !== undefined &&
      parameter !== undefined &&
      isPathSyncHelperName(name) &&
      isPathLikeParameter(parameter)
    ) {
      violations.push({
        file,
        rule: 'exported path sync helper',
        excerpt: compactExcerpt(match[0]),
      });
    }
  }

  const exportedConst =
    /\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)\b/g;
  for (const match of source.matchAll(exportedConst)) {
    const name = match[1];
    const parameter = match[2];
    if (
      name !== undefined &&
      parameter !== undefined &&
      isPathSyncHelperName(name) &&
      isPathLikeParameter(parameter)
    ) {
      violations.push({
        file,
        rule: 'exported path sync helper',
        excerpt: compactExcerpt(match[0]),
      });
    }
  }

  const exportedList = /\bexport\s*\{([^}]*)\}/g;
  for (const match of source.matchAll(exportedList)) {
    const names = match[1];
    if (names !== undefined && names.split(',').some((name) => isPathSyncHelperName(name.trim()))) {
      violations.push({
        file,
        rule: 'exported path sync helper',
        excerpt: compactExcerpt(match[0]),
      });
    }
  }
}

function addSwallowedSyncViolations(
  violations: SourceViolation[],
  file: string,
  source: string,
): void {
  const syncTryCatch =
    /try\s*\{(?:(?!\}\s*catch)[\s\S])*?\.sync\s*\([^)]*\)[\s\S]*?\}\s*catch\s*(?:\([^)]*\))?\s*\{([\s\S]*?)\}/g;
  for (const match of source.matchAll(syncTryCatch)) {
    const body = match[1] ?? '';
    const trimmed = body.trim();
    const recordsFailure =
      /failure\(\s*['"]sync_(?:file|directory)['"]/.test(body) || /throwDurable\b/.test(body);
    const throwsImmediately = /^throw\b/.test(trimmed);
    if (
      trimmed.length === 0 ||
      /\breturn\b/.test(body) ||
      (!recordsFailure && !throwsImmediately)
    ) {
      violations.push({ file, rule: 'silent sync catch', excerpt: compactExcerpt(match[0] ?? '') });
    }
  }
}

function formatSourceViolations(violations: readonly SourceViolation[]): string {
  return violations
    .map((violation) => `${violation.file} ${violation.rule}: ${violation.excerpt}`)
    .join('\n');
}

function makeIsolatedEnvRoot(prefix: string): string {
  const rootDir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(rootDir, 'home'), { recursive: true });
  mkdirSync(join(rootDir, 'cache'), { recursive: true });
  mkdirSync(join(rootDir, 'config'), { recursive: true });
  mkdirSync(join(rootDir, 'tmp'), { recursive: true });
  writeFileSync(join(rootDir, 'config', 'user.npmrc'), '');
  writeFileSync(join(rootDir, 'config', 'global.npmrc'), '');
  return rootDir;
}

function makeIsolatedNpmProject(directory: string, name: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'package.json'),
    `${JSON.stringify({ name, private: true, version: '1.0.0' }, null, 2)}\n`,
  );
  writeFileSync(join(directory, '.npmrc'), '');
}

function removeIsolatedEnvRoot(rootDir: string): void {
  rmSync(rootDir, { recursive: true, force: true });
}

function isolatedNpmEnv(rootDir: string): NodeJS.ProcessEnv {
  const cache = join(rootDir, 'cache');
  const userConfig = join(rootDir, 'config', 'user.npmrc');
  const globalConfig = join(rootDir, 'config', 'global.npmrc');
  const registry = 'http://127.0.0.1.invalid/';
  return {
    PATH: process.env['PATH'] ?? '',
    HOME: join(rootDir, 'home'),
    USERPROFILE: join(rootDir, 'home'),
    XDG_CONFIG_HOME: join(rootDir, 'config'),
    TMPDIR: join(rootDir, 'tmp'),
    TMP: join(rootDir, 'tmp'),
    TEMP: join(rootDir, 'tmp'),
    NPM_CONFIG_CACHE: cache,
    npm_config_cache: cache,
    NPM_CONFIG_USERCONFIG: userConfig,
    npm_config_userconfig: userConfig,
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    npm_config_globalconfig: globalConfig,
    NPM_CONFIG_REGISTRY: registry,
    npm_config_registry: registry,
    GIT_ALLOW_PROTOCOL: 'file',
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    CI: '1',
  };
}

function localRegistryNpmEnv(rootDir: string, registry: string): NodeJS.ProcessEnv {
  const env = isolatedNpmEnv(rootDir);
  env['NPM_CONFIG_REGISTRY'] = registry;
  env['npm_config_registry'] = registry;
  return env;
}

function hashReadOnlyTree(directory: string): string {
  const hash = createHash('sha256');
  const visit = (path: string, relativePath: string): void => {
    const stat = lstatSync(path);
    const mode = stat.mode & 0o7777;
    if (stat.isSymbolicLink()) {
      hash.update(`link\0${relativePath}\0${String(mode)}\0${readlinkSync(path)}\0`);
      return;
    }
    if (stat.isFile()) {
      hash.update(`file\0${relativePath}\0${String(mode)}\0${String(stat.size)}\0`);
      hash.update(readFileSync(path));
      hash.update('\0');
      return;
    }
    assert.ok(stat.isDirectory(), `fixture source contains unsupported entry ${path}`);
    hash.update(`directory\0${relativePath}\0${String(mode)}\0`);
    for (const name of readdirSync(path).sort()) {
      visit(join(path, name), relativePath.length === 0 ? name : `${relativePath}/${name}`);
    }
  };
  visit(directory, '');
  return hash.digest('hex');
}

function parsePackEntries(stdout: string): NpmPackEntry[] {
  const trimmed = stdout.trim();
  const arrayStart = trimmed.startsWith('[') ? 0 : stdout.lastIndexOf('\n[') + 1;
  assert.ok(
    arrayStart > 0 || trimmed.startsWith('['),
    `npm pack output must end with a JSON array; received ${JSON.stringify(stdout.slice(0, 160))}`,
  );
  const parsed = parseJsonValue(arrayStart === 0 ? trimmed : stdout.slice(arrayStart).trim());
  assert.ok(Array.isArray(parsed), 'npm pack output must be an array');
  return parsed.map((entry): NpmPackEntry => {
    assert.ok(isObject(entry), 'pack entry must be an object');
    const filename = requireString(field(entry, 'filename'), 'pack filename');
    const files = field(entry, 'files');
    assert.ok(Array.isArray(files), 'pack entry files must be an array');
    return {
      filename,
      files: files.map((file): NpmPackFile => {
        assert.ok(isObject(file), 'pack file must be an object');
        const path = requireString(field(file, 'path'), 'pack file path');
        return { path };
      }),
    };
  });
}

void describe('package', { concurrency: false }, () => {
  void it('manifest/source provenance and peers describe only the local shell fork', async () => {
    const p = await pkg();
    assert.equal(p.name, 'pi-background-shell');
    assert.equal(p.type, 'module');
    assert.deepEqual(p.pi.extensions, ['./dist/extensions/background-tasks.js']);
    assert.equal(p.pi.image, undefined);
    assert.deepEqual(p.dependencies ?? {}, {});
    assert.deepEqual(p.files, ['dist/', 'extensions/', 'src/', 'README.md', 'TESTING.md', 'LICENSE', 'UPSTREAM.md', 'CHANGELOG.md', 'docs/']);
    assert.equal(p.peerDependencies['@earendil-works/pi-ai'], undefined, 'pi-ai is scripted-provider development-only');
    assert.equal(p.devDependencies?.['@earendil-works/pi-ai'], '1.0.0');
    for (const peer of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox']) {
      assert.equal(p.peerDependencies[peer], '*');
      assert.equal(p.devDependencies?.[peer], peer === 'typebox' ? '1.3.27' : '1.0.0');
    }
    assert.equal(p.scripts['build:runtime'], 'node ../../scripts/build-package.mjs');
    assert.equal(p.serraly.build.verifyArtifact, './scripts/check-package-payload.mjs');
    const provenance = await text('UPSTREAM.md');
    assert.match(provenance, /471f1dcae7ff13d8f989e4c056bdff1e6b01f1ef/);
    assert.match(provenance, /pi-background-tasks@2\.6\.8/);
    assert.match(await text('LICENSE'), /^ISC License/);
    assert.equal((await text('extensions/background-tasks.ts')).trim(), "export { default } from '../src/extension.js';");
  });

  void it('validates exact packed JS/maps/source/docs closure with no retired artifacts', () => {
    const result = spawnSync(process.execPath, ['scripts/check-package-payload.mjs'], {
      cwd: fileURLToPath(root), encoding: 'utf8', timeout: 60_000,
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /packed files satisfy runtime\/docs closure/);
  });

  void it('keeps production durable syncing handle-scoped and loud', async () => {
    const files = await walkSourceTree(fileURLToPath(new URL('src/', root)));
    const violations: SourceViolation[] = [];
    for (const file of files) {
      const source = stripComments(await readFile(file, 'utf8'));
      // file is a native path from walkSourceTree, so the prefix must be native
      // too. Comparing against a URL pathname silently never matches on Windows.
      const rootPath = fileURLToPath(root);
      const label = file.startsWith(rootPath) ? file.slice(rootPath.length) : file;
      addPatternViolations(
        violations,
        label,
        'read-open sync',
        source,
        /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:nodeOpen|open|fs(?:Promises)?\.open|[A-Za-z_$][\w$]*\.openWritable)\s*\([^;]*,\s*(['"])r\+?\2[^;]*\)\s*;?[\s\S]*?\b\1\s*\.\s*sync\s*\(/g,
      );
      addPatternViolations(
        violations,
        label,
        'read-open sync',
        source,
        /\b([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:nodeOpen|open|fs(?:Promises)?\.open|[A-Za-z_$][\w$]*\.openWritable)\s*\([^;]*,\s*(['"])r\+?\2[^;]*\)\s*;?[\s\S]*?\b\1\s*\.\s*sync\s*\(/g,
      );
      addPatternViolations(
        violations,
        label,
        'fsyncFile function',
        source,
        /\b(?:async\s+)?function\s+fsyncFile\b|\b(?:const|let|var)\s+fsyncFile\s*=/g,
      );
      addExportedPathSyncViolations(violations, label, source);
      addSwallowedSyncViolations(violations, label, source);
    }
    assert.equal(violations.length, 0, formatSourceViolations(violations));
  });

  void it('file URL pathname guard distinguishes native-path conversions from URL validation', () => {
    const fileUrlAntipatterns = [
      "import { URL as NodeURL, pathToFileURL as toFileUrl } from 'node:url';",
      "const inline = new URL('./child', import.meta.url).pathname;",
      'const meta = import.meta;',
      'const moduleHref = meta.url;',
      "const variable = new NodeURL('../', moduleHref);",
      'const alias = variable;',
      "const variablePath = alias['pathname'];",
      "const { pathname: drivePath } = new URL('file:///C:/Users/Test/repo/file.ts');",
      "const uncPath = new URL('file://server/share/repo/file.ts').pathname;",
      "const fromNative = toFileUrl('C:\\\\repo\\\\file.ts').pathname;",
      'const URLAlias = NodeURL;',
      "const constructorAlias = new URLAlias('file:///D:/work/pkg/index.ts').pathname;",
      'let assigned;',
      "assigned = new URL('./assigned', import.meta.url);",
      'const assignedPath = assigned.pathname;',
    ].join('\n');
    assert.deepEqual(
      findFileUrlPathnameViolations('file-url-antipatterns.ts', fileUrlAntipatterns).map(
        (violation) => violation.line,
      ),
      [2, 7, 8, 9, 10, 12, 15],
    );

    const legitimateUrlPaths = [
      'function validate(configured: string): string {',
      '  const parsed = new URL(configured);',
      "  if (parsed.origin !== 'https://api.anthropic.com' || parsed.pathname !== '/') throw new Error();",
      '  return parsed.pathname;',
      '}',
      "const inlineHttps = new URL('https://example.com/a/b').pathname;",
      "const basedHttps = new URL('/v1/messages', 'https://api.anthropic.com').pathname;",
      "const absoluteOverride = new URL('https://example.com/a', import.meta.url).pathname;",
      "const nativePath = fileURLToPath(new URL('./module.ts', import.meta.url));",
      'function requestPath(url: URL): string {',
      '  return `${url.pathname}${url.search}`;',
      '}',
      '// Ordinary prose mentions new URL(...).pathname and file:///C:/repo.',
      'const quoted = "new URL(\\"file:///C:/repo\\").pathname";',
      'const pattern = /file:\\/\\/\\/C:\\/repo|\\.pathname/u;',
    ].join('\n');
    assert.deepEqual(
      findFileUrlPathnameViolations('legitimate-url-paths.ts', legitimateUrlPaths),
      [],
    );
  });

  void it('file URL guard gives absolute first arguments precedence over bases', () => {
    const fileCases = [
      "const absoluteFile = new URL('file:///C:/work/file.ts');",
      "const fromObject = new URL(absoluteFile, 'https://example.com/base').pathname;",
      "const fromMeta = new URL(import.meta.url, 'https://example.com/base').pathname;",
      "const host = 'server';",
      'const fromTemplate = new URL(`file://${host}/share/file.ts`).pathname;',
    ].join('\n');
    assert.deepEqual(
      findFileUrlPathnameViolations('absolute-file-first.ts', fileCases).map(
        (violation) => violation.line,
      ),
      [2, 3, 5],
    );

    const httpsCases = [
      "const absoluteHttps = new URL('https://example.com/request/path');",
      'const fromObject = new URL(absoluteHttps, import.meta.url).pathname;',
      "const host = 'example.com';",
      'const fromTemplate = new URL(`https://${host}/v1`, import.meta.url).pathname;',
    ].join('\n');
    assert.deepEqual(findFileUrlPathnameViolations('absolute-https-first.ts', httpsCases), []);
  });

  void it('file URL guard retains explicit bases for possibly relative first inputs', () => {
    const fileBaseCases = [
      'declare const relativeName: string;',
      'declare const fixtureName: string;',
      'declare const condition: boolean;',
      'const inline = new URL(relativeName, import.meta.url).pathname;',
      "const literalBase = new URL(relativeName, 'file:///C:/pkg/module.ts').pathname;",
      "const fileBaseObject = new URL('file:///C:/pkg/module.ts');",
      'const declared = new URL(relativeName, fileBaseObject);',
      'const declaredPath = declared.pathname;',
      "let assigned = new URL('https://example.com/start');",
      'assigned = new URL(`./fixtures/${fixtureName}.json`, `file:///C:/pkg/module.ts`);',
      'const assignedPath = assigned.pathname;',
      'const parentTemplate = new URL(`../fixtures/${fixtureName}.json`, import.meta.url).pathname;',
      "const mixedFirst = condition ? 'https://example.com/request/path' : relativeName;",
      'const mixedPath = new URL(mixedFirst, import.meta.url).pathname;',
      "const absoluteFileObject = new URL('file:///D:/work/object.ts');",
      "new URL(absoluteFileObject, 'https://example.com/base').pathname;",
      "new URL('file:///E:/work/literal.ts', 'https://example.com/base').pathname;",
      "const fileHost = 'server';",
      'new URL(`file://${fileHost}/share/template.ts`, `https://example.com/base`).pathname;',
    ].join('\n');
    assert.deepEqual(
      findFileUrlPathnameViolations('possible-relative-file-bases.ts', fileBaseCases).map(
        (violation) => violation.line,
      ),
      [4, 5, 8, 11, 12, 14, 16, 17, 19],
    );

    const httpsBaseControls = [
      'declare const relativeName: string;',
      'declare const fixtureName: string;',
      'declare const condition: boolean;',
      "new URL(relativeName, 'https://example.com/base').pathname;",
      'new URL(`./fixtures/${fixtureName}.json`, `https://example.com/base`).pathname;',
      "const httpsBaseObject = new URL('https://example.com/base');",
      'new URL(`../fixtures/${fixtureName}.json`, httpsBaseObject).pathname;',
      "const mixedFirst = condition ? 'https://example.com/request/path' : relativeName;",
      'new URL(mixedFirst, httpsBaseObject).pathname;',
      "const absoluteHttpsObject = new URL('https://example.com/object');",
      'new URL(absoluteHttpsObject, import.meta.url).pathname;',
      "new URL('https://example.com/literal', import.meta.url).pathname;",
      "const httpsHost = 'example.com';",
      'new URL(`https://${httpsHost}/template`, import.meta.url).pathname;',
    ].join('\n');
    assert.deepEqual(
      findFileUrlPathnameViolations('possible-relative-https-bases.ts', httpsBaseControls),
      [],
    );
  });

  void it('file URL guard follows WHATWG preprocessing for static inputs', () => {
    const fileCases = [
      "const host = 'server';",
      "const leadingControls = new URL('\\u0000\\u001f file:///C:/work/file.ts', 'https://example.com/base').pathname;",
      "const normalizedTabs = new URL('fi\\tle:///D:/work/file.ts', 'https://example.com/base').pathname;",
      "const normalizedCarriageReturn = new URL('fi\\rle:///E:/work/file.ts', 'https://example.com/base').pathname;",
      "const normalizedTemplate = new URL(`\\r\\nfi\\tle://${host}/share/file.ts`, 'https://example.com/base').pathname;",
    ].join('\n');
    assert.deepEqual(
      findFileUrlPathnameViolations('whatwg-file-preprocessing.ts', fileCases).map(
        (violation) => violation.line,
      ),
      [2, 3, 4, 5],
    );

    const httpsCases = [
      "const host = 'example.com';",
      "const leadingControls = new URL('\\u0000 \\t\\r\\nhttps://example.com/request/path', import.meta.url).pathname;",
      "const normalizedNewline = new URL('ht\\ntps://example.com/request/path', import.meta.url).pathname;",
      "const normalizedTab = new URL('ht\\ttps://example.com/request/path', import.meta.url).pathname;",
      "const normalizedCarriageReturn = new URL('ht\\rtps://example.com/request/path', import.meta.url).pathname;",
      'const normalizedTemplate = new URL(`\\r\\nht\\ntps://${host}/v1`, import.meta.url).pathname;',
    ].join('\n');
    assert.deepEqual(
      findFileUrlPathnameViolations('whatwg-https-preprocessing.ts', httpsCases),
      [],
    );

    const dynamicCases = [
      'declare const condition: boolean;',
      'declare const dynamicScheme: string;',
      "const maybeFile = condition ? 'file:///C:/work/file.ts' : `${dynamicScheme}://example.com/path`;",
      "new URL(maybeFile, 'https://example.com/base').pathname;",
      'new URL(`${dynamicScheme}://example.com/path`, import.meta.url).pathname;',
    ].join('\n');
    assert.deepEqual(
      findFileUrlPathnameViolations('whatwg-dynamic-boundary.ts', dynamicCases).map(
        (violation) => violation.line,
      ),
      [4, 5],
    );

    const runtimeHost = 'server';
    assert.equal(
      new URL('\u0000\u001f file:///C:/work/file.ts', 'https://example.com/base').protocol,
      'file:',
    );
    assert.equal(
      new URL('fi\tle:///D:/work/file.ts', 'https://example.com/base').protocol,
      'file:',
    );
    assert.equal(
      new URL('fi\rle:///E:/work/file.ts', 'https://example.com/base').protocol,
      'file:',
    );
    assert.equal(
      new URL(`\r\nfi\tle://${runtimeHost}/share/file.ts`, 'https://example.com/base').protocol,
      'file:',
    );
    assert.equal(
      new URL('\u0000 \t\r\nhttps://example.com/request/path', import.meta.url).protocol,
      'https:',
    );
    assert.equal(new URL('ht\ntps://example.com/request/path', import.meta.url).protocol, 'https:');
    assert.equal(new URL('ht\ttps://example.com/request/path', import.meta.url).protocol, 'https:');
    assert.equal(new URL('ht\rtps://example.com/request/path', import.meta.url).protocol, 'https:');
    assert.equal(new URL(`\r\nht\ntps://${runtimeHost}/v1`, import.meta.url).protocol, 'https:');
  });

  void it('file URL guard preserves explicit abrupt completion states', () => {
    const positiveCases: ReadonlyArray<{
      readonly name: string;
      readonly source: string;
      readonly lines: readonly number[];
    }> = [
      {
        name: 'nested ordinary switch break',
        source: [
          'declare const mode: string;',
          "let target = 'https://example.com/request/path';",
          'switch (mode) {',
          "  case 'native': {",
          "    target = 'file:///C:/work/file.ts';",
          '    break;',
          '  }',
          '  default:',
          "    target = 'https://example.com/other';",
          '}',
          'new URL(target).pathname;',
        ].join('\n'),
        lines: [11],
      },
      {
        name: 'labeled break',
        source: [
          'declare const condition: boolean;',
          "let target = 'file:///C:/work/file.ts';",
          'exit: {',
          '  if (condition) break exit;',
          "  target = 'https://example.com/request/path';",
          '}',
          'new URL(target).pathname;',
        ].join('\n'),
        lines: [7],
      },
      {
        name: 'ordinary continue',
        source: [
          'declare const condition: boolean;',
          "let target = 'https://example.com/request/path';",
          'do {',
          '  if (condition) {',
          "    target = 'file:///C:/work/file.ts';",
          '    continue;',
          '  }',
          "  target = 'https://example.com/other';",
          '} while (false);',
          'new URL(target).pathname;',
        ].join('\n'),
        lines: [10],
      },
      {
        name: 'labeled continue',
        source: [
          'declare const condition: boolean;',
          "let target = 'https://example.com/request/path';",
          'outer: do {',
          '  if (condition) {',
          "    target = 'file:///C:/work/file.ts';",
          '    continue outer;',
          '  }',
          "  target = 'https://example.com/other';",
          '} while (false);',
          'new URL(target).pathname;',
        ].join('\n'),
        lines: [10],
      },
      {
        name: 'normal completion runs finally',
        source: [
          'function inspect(): void {',
          "  let target = 'https://example.com/request/path';",
          "  try { target = 'file:///C:/work/file.ts'; }",
          '  finally { new URL(target).pathname; }',
          '}',
        ].join('\n'),
        lines: [4],
      },
      {
        name: 'break runs finally',
        source: [
          'function inspect(): void {',
          "  let target = 'https://example.com/request/path';",
          '  while (true) {',
          "    try { target = 'file:///C:/work/file.ts'; break; }",
          '    finally { new URL(target).pathname; }',
          '  }',
          '}',
        ].join('\n'),
        lines: [5],
      },
      {
        name: 'continue runs finally',
        source: [
          'function inspect(): void {',
          "  let target = 'https://example.com/request/path';",
          '  do {',
          "    try { target = 'file:///C:/work/file.ts'; continue; }",
          '    finally { new URL(target).pathname; }',
          '  } while (false);',
          '}',
        ].join('\n'),
        lines: [5],
      },
      {
        name: 'return into finally with live provenance',
        source: [
          'function inspect(): void {',
          "  let target = 'https://example.com/request/path';",
          '  try {',
          "    target = 'file:///C:/work/file.ts';",
          '    return;',
          '  } finally {',
          '    new URL(target).pathname;',
          '  }',
          '}',
        ].join('\n'),
        lines: [7],
      },
      {
        name: 'direct return finally syntax',
        source: [
          'function inspect(): void {',
          '  try { return; } finally {',
          "    new URL('file:///C:/work/file.ts').pathname;",
          '  }',
          '}',
        ].join('\n'),
        lines: [3],
      },
      {
        name: 'throw state enters catch',
        source: [
          'function inspect(): void {',
          "  let target = 'https://example.com/request/path';",
          '  try {',
          "    target = 'file:///C:/work/file.ts';",
          "    throw new Error('caught');",
          '  } catch {',
          '    new URL(target).pathname;',
          '  }',
          '}',
        ].join('\n'),
        lines: [7],
      },
      {
        name: 'throw into finally',
        source: [
          'function inspect(): void {',
          "  let target = 'https://example.com/request/path';",
          '  try {',
          "    target = 'file:///C:/work/file.ts';",
          "    throw new Error('uncaught');",
          '  } finally {',
          '    new URL(target).pathname;',
          '  }',
          '}',
        ].join('\n'),
        lines: [7],
      },
    ];
    for (const fixture of positiveCases) {
      assert.deepEqual(
        findFileUrlPathnameViolations(`${fixture.name}.ts`, fixture.source).map(
          (violation) => violation.line,
        ),
        fixture.lines,
        fixture.name,
      );
    }

    const httpControls = [
      {
        name: 'nested break HTTP',
        source: [
          'declare const mode: string;',
          "let target = 'https://example.com/request/path';",
          'switch (mode) {',
          "  case 'keep': { break; }",
          "  default: target = 'https://example.com/other';",
          '}',
          'new URL(target).pathname;',
        ].join('\n'),
      },
      {
        name: 'labeled break HTTP',
        source: [
          'declare const condition: boolean;',
          "let target = 'https://example.com/request/path';",
          'exit: {',
          '  if (condition) break exit;',
          "  target = 'https://example.com/other';",
          '}',
          'new URL(target).pathname;',
        ].join('\n'),
      },
      {
        name: 'continue HTTP',
        source: [
          'declare const condition: boolean;',
          "let target = 'https://example.com/request/path';",
          'do {',
          '  if (condition) {',
          "    target = 'https://example.com/continued';",
          '    continue;',
          '  }',
          "  target = 'https://example.com/other';",
          '} while (false);',
          'new URL(target).pathname;',
        ].join('\n'),
      },
      {
        name: 'normal finally HTTP',
        source: [
          'function inspect(): void {',
          "  let target = 'file:///C:/work/file.ts';",
          "  try { target = 'https://example.com/request/path'; }",
          '  finally { new URL(target).pathname; }',
          '}',
        ].join('\n'),
      },
      {
        name: 'return finally HTTP',
        source: [
          'function inspect(): void {',
          "  let target = 'file:///C:/work/file.ts';",
          "  try { target = 'https://example.com/request/path'; return; }",
          '  finally { new URL(target).pathname; }',
          '}',
        ].join('\n'),
      },
      {
        name: 'caught throw HTTP',
        source: [
          'function inspect(): void {',
          "  let target = 'file:///C:/work/file.ts';",
          '  try {',
          "    target = 'https://example.com/request/path';",
          "    throw new Error('caught');",
          '  } catch { new URL(target).pathname; }',
          '}',
        ].join('\n'),
      },
      {
        name: 'throw finally HTTP',
        source: [
          'function inspect(): void {',
          "  let target = 'file:///C:/work/file.ts';",
          '  try {',
          "    target = 'https://example.com/request/path';",
          "    throw new Error('uncaught');",
          '  } finally { new URL(target).pathname; }',
          '}',
        ].join('\n'),
      },
    ];
    for (const fixture of httpControls) {
      assert.deepEqual(
        findFileUrlPathnameViolations(`${fixture.name}.ts`, fixture.source),
        [],
        fixture.name,
      );
    }
  });

  void it('file URL guard prunes statically impossible short-circuit writes', () => {
    const controls = [
      "let target = 'https://example.com/request/path';",
      "false && (target = 'file:///C:/skipped-and.ts');",
      "true || (target = 'file:///C:/skipped-or.ts');",
      "const present = 'present';",
      "present ?? (target = 'file:///C:/skipped-nullish.ts');",
      'new URL(target).pathname;',
    ].join('\n');
    assert.deepEqual(findFileUrlPathnameViolations('short-circuit-controls.ts', controls), []);

    const hazards = [
      "let andTarget = 'https://example.com/request/path';",
      "true && (andTarget = 'file:///C:/evaluated-and.ts');",
      'new URL(andTarget).pathname;',
      "let orTarget = 'https://example.com/request/path';",
      "false || (orTarget = 'file:///C:/evaluated-or.ts');",
      'new URL(orTarget).pathname;',
      "let nullishTarget = 'https://example.com/request/path';",
      'const missing = null;',
      "missing ?? (nullishTarget = 'file:///C:/evaluated-nullish.ts');",
      'new URL(nullishTarget).pathname;',
    ].join('\n');
    assert.deepEqual(
      findFileUrlPathnameViolations('short-circuit-hazards.ts', hazards).map(
        (violation) => violation.line,
      ),
      [3, 6, 10],
    );
  });

  void it('file URL guard checks for-of destructuring and resolves globalThis lexically', () => {
    const hazards = [
      "let pathname = '';",
      "for ({ pathname } of [new URL('file:///C:/work/file.ts')]) break;",
      "for (const { pathname: declaredPath } of [new URL('file://server/share/file.ts')]) { void declaredPath; }",
      "const globalPath = new globalThis.URL('file:///D:/work/file.ts').pathname;",
    ].join('\n');
    assert.deepEqual(
      findFileUrlPathnameViolations('for-of-and-global-url.ts', hazards).map(
        (violation) => violation.line,
      ),
      [2, 3, 4],
    );

    const controls = [
      "let pathname = '';",
      "for ({ pathname } of [new URL('https://example.com/request/path')]) break;",
      "for (const { pathname: requestPath } of [new URL('https://example.com/other')]) { void requestPath; }",
      'function localUrl(URL: new (value: string) => { pathname: string }): string {',
      "  for ({ pathname } of [new URL('file:///C:/not-a-real-url')]) break;",
      '  return pathname;',
      '}',
      "class FakeURL { readonly pathname = 'not-a-native-path'; constructor(_value: string) {} }",
      'function parameterShadow(globalThis: { URL: typeof FakeURL }): string {',
      "  return new globalThis.URL('file:///C:/not-a-real-url').pathname;",
      '}',
      'function localShadow(): string {',
      '  const globalThis = { URL: FakeURL };',
      "  return new globalThis.URL('file:///C:/still-not-a-real-url').pathname;",
      '}',
    ].join('\n');
    assert.deepEqual(
      findFileUrlPathnameViolations('for-of-and-global-url-controls.ts', controls),
      [],
    );
  });

  void it('file URL guard distinguishes uppercase constructor and lowercase meta keys', () => {
    const hazards = [
      "new globalThis.URL('file:///C:/work/dot.ts').pathname;",
      "new globalThis['URL']('file:///C:/work/bracket.ts').pathname;",
      "const constructorKey = 'URL' as const;",
      "new globalThis[constructorKey]('file:///C:/work/key.ts').pathname;",
      "const importMetaKey = 'url' as const;",
      "new URL('./child.ts', import.meta[importMetaKey]).pathname;",
    ].join('\n');
    assert.deepEqual(
      findFileUrlPathnameViolations('static-url-keys.ts', hazards).map(
        (violation) => violation.line,
      ),
      [1, 2, 4, 6],
    );

    const controls = [
      "class FakeURL { readonly pathname = 'fake'; constructor(_value: string) {} }",
      'declare global {',
      '  var url: typeof FakeURL;',
      '  interface ImportMeta { readonly URL: string; }',
      '}',
      "const lowercaseConstructorKey = 'url' as const;",
      "new globalThis[lowercaseConstructorKey]('file:///C:/not-native.ts').pathname;",
      "const uppercaseMetaKey = 'URL' as const;",
      "new URL('./child.ts', import.meta[uppercaseMetaKey]).pathname;",
      'function parameterShadow(globalThis: { URL: typeof FakeURL }): string {',
      "  return new globalThis['URL']('file:///C:/parameter.ts').pathname;",
      '}',
      'function localShadow(): string {',
      '  const globalThis = { URL: FakeURL };',
      "  return new globalThis['URL']('file:///C:/local.ts').pathname;",
      '}',
      'export {};',
    ].join('\n');
    assert.deepEqual(findFileUrlPathnameViolations('static-url-key-controls.ts', controls), []);
  });

  void it('file URL guard uses feasible values at each pathname read', () => {
    const readBeforeWrite = [
      "let target = 'file:///C:/work/file.ts';",
      'const nativePath = new URL(target).pathname;',
      "target = 'https://example.com/request/path';",
    ].join('\n');
    assert.deepEqual(
      findFileUrlPathnameViolations('read-before-write.ts', readBeforeWrite).map(
        (violation) => violation.line,
      ),
      [2],
    );

    const mayFileBranch = [
      'let target: string;',
      "if (condition) target = 'https://example.com/request/path';",
      "else target = 'file:///C:/work/file.ts';",
      'const maybeNativePath = new URL(target).pathname;',
    ].join('\n');
    assert.deepEqual(
      findFileUrlPathnameViolations('may-file-branch.ts', mayFileBranch).map(
        (violation) => violation.line,
      ),
      [4],
    );

    const switchMayFile = [
      "let target = 'https://example.com/request/path';",
      'switch (mode) {',
      "  case 'native':",
      "    target = 'file:///C:/work/file.ts';",
      '    break;',
      '  default:',
      "    target = 'https://example.com/other';",
      '}',
      'const maybeNativePath = new URL(target).pathname;',
    ].join('\n');
    assert.deepEqual(
      findFileUrlPathnameViolations('switch-may-file.ts', switchMayFile).map(
        (violation) => violation.line,
      ),
      [9],
    );

    const overwrittenBeforeRead = [
      "let parsed = new URL('./module.ts', import.meta.url);",
      "parsed = new URL('https://example.com/request/path');",
      'const requestPath = parsed.pathname;',
    ].join('\n');
    assert.deepEqual(
      findFileUrlPathnameViolations('overwritten-before-read.ts', overwrittenBeforeRead),
      [],
    );

    const writeAfterRead = [
      "let target = 'https://example.com/request/path';",
      'const requestPath = new URL(target).pathname;',
      "target = 'file:///C:/work/file.ts';",
    ].join('\n');
    assert.deepEqual(findFileUrlPathnameViolations('write-after-read.ts', writeAfterRead), []);

    const unreachableFileWrite = [
      "let target = 'https://example.com/request/path';",
      "if (false) target = 'file:///C:/work/file.ts';",
      'const requestPath = new URL(target).pathname;',
    ].join('\n');
    assert.deepEqual(
      findFileUrlPathnameViolations('unreachable-file-write.ts', unreachableFileWrite),
      [],
    );
  });

  void it('file URL guard covers destructuring assignments and computed pathname aliases', () => {
    const hazards = [
      'let assignedPath: string;',
      "({ pathname: assignedPath } = new URL('file:///C:/work/file.ts'));",
      "const key = 'pathname' as const;",
      "const computedPath = new URL('file://server/share/file.ts')[key];",
      'let computedAssignment: string;',
      "({ [key]: computedAssignment } = new URL('file:///D:/work/file.ts'));",
    ].join('\n');
    assert.deepEqual(
      findFileUrlPathnameViolations('pathname-aliases.ts', hazards).map(
        (violation) => violation.line,
      ),
      [2, 4, 6],
    );

    const controls = [
      'let requestPath: string;',
      "({ pathname: requestPath } = new URL('https://example.com/request/path'));",
      "const key = 'pathname' as const;",
      "const computedPath = new URL('https://example.com/request/path')[key];",
      'function local(URL: new (value: string) => { pathname: string }): string {',
      '  let pathname: string;',
      "  ({ pathname } = new URL('file:///C:/not-a-real-url-object'));",
      "  return new URL('file:///C:/still-not-a-real-url-object')[key];",
      '}',
    ].join('\n');
    assert.deepEqual(findFileUrlPathnameViolations('pathname-alias-controls.ts', controls), []);
  });

  void it('converts file URLs to native paths instead of using URL.pathname', async () => {
    // A file URL pathname such as `/D:/a/repo/` is not a Windows native path.
    // Follow only compiler-proven file URL provenance so HTTPS path validation
    // remains legitimate while inline, indirect, and aliased conversions fail.
    const roots = ['src', 'extensions', 'scripts', 'tests'];
    const offenders: string[] = [];
    for (const rootDir of roots) {
      const dir = fileURLToPath(new URL(`${rootDir}/`, root));
      if (!existsSync(dir)) continue;
      for (const file of await walkSourceTree(dir)) {
        const source = await readFile(file, 'utf8');
        for (const violation of findFileUrlPathnameViolations(file, source)) {
          offenders.push(`${violation.file}:${String(violation.line)} ${violation.text}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'use fileURLToPath(fileUrl) instead of fileUrl.pathname for native paths',
    );
  });

  void it('typechecks standalone with the full monorepo strictness vendored locally', async () => {
    // The package is published both from this monorepo and as a standalone git
    // repo. A parent `../../tsconfig.base.json` does not exist in the standalone
    // checkout, so `extends` must point at a locally vendored copy. CI proved
    // that a missing base silently drops `skipLibCheck` and makes `tsc` walk
    // node_modules type definitions.
    const tsconfig = parseJsonValue(await text('tsconfig.json'));
    assert.ok(isObject(tsconfig));
    assert.equal(
      field(tsconfig, 'extends'),
      './tsconfig.base.json',
      'tsconfig must extend a locally vendored base so standalone checkouts typecheck',
    );

    const localBase = parseJsonValue(await text('tsconfig.base.json'));
    assert.ok(isObject(localBase));
    const localOptions = field(localBase, 'compilerOptions');
    assert.ok(isObject(localOptions));

    // Every strictness flag from the monorepo base must be present and equal.
    // Weakening the standalone config to make a build pass is not acceptable.
    const required: Record<string, boolean> = {
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      noImplicitOverride: true,
      noImplicitReturns: true,
      noPropertyAccessFromIndexSignature: true,
      noFallthroughCasesInSwitch: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      useUnknownInCatchVariables: true,
      verbatimModuleSyntax: true,
      isolatedModules: true,
      allowUnreachableCode: false,
      allowUnusedLabels: false,
      skipLibCheck: true,
    };
    for (const [flag, expected] of Object.entries(required)) {
      assert.equal(
        field(localOptions, flag),
        expected,
        `vendored tsconfig.base.json must keep ${flag}=${String(expected)}`,
      );
    }
  });

  void it('isolates npm user, global, and project configuration without a hostile request', async () => {
    const envRoot = makeIsolatedEnvRoot('pi-bg-npm-config-env-');
    const probeProject = join(envRoot, 'probe-project');
    const hostileProject = join(envRoot, 'hostile-project');
    const safeUserConfig = join(envRoot, 'config', 'user.npmrc');
    const safeGlobalConfig = join(envRoot, 'config', 'global.npmrc');
    const hostileGlobalConfig = join(envRoot, 'hostile-global.npmrc');
    const hostileRegistry = 'http://127.0.0.1:9/never-contact/';
    const ownedRegistry = 'http://127.0.0.1:43210/';
    try {
      for (const [directory, name] of [
        [probeProject, 'isolated-config-probe'],
        [hostileProject, 'hostile-project-probe'],
      ] as const) {
        mkdirSync(directory, { recursive: true });
        await writeFile(
          join(directory, 'package.json'),
          `${JSON.stringify({ name, private: true, version: '1.0.0' }, null, 2)}\n`,
        );
      }
      await writeFile(join(probeProject, '.npmrc'), '');
      await writeFile(join(hostileProject, '.npmrc'), `@mixmark-io:registry=${hostileRegistry}\n`);
      await writeFile(safeUserConfig, '');
      await writeFile(safeGlobalConfig, '');
      await writeFile(hostileGlobalConfig, `@mixmark-io:registry=${hostileRegistry}\n`);

      const vulnerableEnv = localRegistryNpmEnv(envRoot, ownedRegistry);
      vulnerableEnv['NPM_CONFIG_GLOBALCONFIG'] = hostileGlobalConfig;
      vulnerableEnv['npm_config_globalconfig'] = hostileGlobalConfig;
      const vulnerableGlobal = runNpm(['config', 'get', '@mixmark-io:registry'], {
        cwd: probeProject,
        env: vulnerableEnv,
      });
      assert.equal(vulnerableGlobal.status, 0, vulnerableGlobal.stderr);
      assert.equal(vulnerableGlobal.stdout.trim(), hostileRegistry);

      const isolatedEnv = localRegistryNpmEnv(envRoot, ownedRegistry);
      assert.equal(isolatedEnv['NPM_CONFIG_USERCONFIG'], safeUserConfig);
      assert.equal(isolatedEnv['npm_config_userconfig'], safeUserConfig);
      assert.equal(isolatedEnv['NPM_CONFIG_GLOBALCONFIG'], safeGlobalConfig);
      assert.equal(isolatedEnv['npm_config_globalconfig'], safeGlobalConfig);
      assert.equal(isolatedEnv['GIT_ALLOW_PROTOCOL'], 'file');
      assert.equal(isolatedEnv['TMPDIR'], join(envRoot, 'tmp'));

      const effectiveGlobal = runNpm(['config', 'get', 'globalconfig'], {
        cwd: probeProject,
        env: isolatedEnv,
      });
      assert.equal(effectiveGlobal.status, 0, effectiveGlobal.stderr);
      assert.equal(effectiveGlobal.stdout.trim(), safeGlobalConfig);
      const effectiveUser = runNpm(['config', 'get', 'userconfig'], {
        cwd: probeProject,
        env: isolatedEnv,
      });
      assert.equal(effectiveUser.status, 0, effectiveUser.stderr);
      assert.equal(effectiveUser.stdout.trim(), safeUserConfig);
      const effectiveRegistry = runNpm(['config', 'get', 'registry'], {
        cwd: probeProject,
        env: isolatedEnv,
      });
      assert.equal(effectiveRegistry.status, 0, effectiveRegistry.stderr);
      assert.equal(effectiveRegistry.stdout.trim(), ownedRegistry);
      const effectiveScope = runNpm(['config', 'get', '@mixmark-io:registry'], {
        cwd: probeProject,
        env: isolatedEnv,
      });
      assert.equal(effectiveScope.status, 0, effectiveScope.stderr);
      assert.notEqual(effectiveScope.stdout.trim(), hostileRegistry);

      const vulnerableProject = runNpm(['config', 'get', '@mixmark-io:registry'], {
        cwd: hostileProject,
        env: isolatedEnv,
      });
      assert.equal(vulnerableProject.status, 0, vulnerableProject.stderr);
      assert.equal(vulnerableProject.stdout.trim(), hostileRegistry);
    } finally {
      removeIsolatedEnvRoot(envRoot);
    }
  });

  void it('characterizes npm --ignore-scripts without requiring future npm defects', () => {
    const prepareFailure = 'sentinel lifecycle executed: prepare';
    const accepted: readonly NpmIgnoreScriptsObservation[] = [
      ['10.9.3', 1, prepareFailure, ['prepare']],
      ['11.13.0', 0, '', []],
      ['10.10.0', 0, '', []],
    ];
    for (const observation of accepted) assertNpmIgnoreScriptsObservation(...observation);

    const rejected: readonly NpmIgnoreScriptsObservation[] = [
      ['10.10.0', 1, prepareFailure, ['prepare']],
      ['11.13.0', 0, '', ['prepare']],
      ['10.9.3', 1, prepareFailure, ['prepack', 'prepare']],
      ['10.9.3', 2, prepareFailure, ['prepare']],
      ['10.9.3', 1, 'different failure', ['prepare']],
      ['11.13.0', 1, 'different failure', []],
    ];
    for (const observation of rejected) {
      assert.throws(
        () => assertNpmIgnoreScriptsObservation(...observation),
        /unexpected npm pack --ignore-scripts lifecycle observation/u,
      );
    }
    assert.throws(
      () => assertNpmIgnoreScriptsObservation('not-semver', 0, '', []),
      /expected npm --version to report a semantic version/u,
    );
    assert.throws(
      () => assertNpmIgnoreScriptsObservation('9.9.9', 0, '', []),
      /expected npm >=10/u,
    );
  });

  void it('denies dependency packing lifecycle scripts across supported npm CLIs', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'pi-bg-pack-script-denial-'));
    const envRoot = makeIsolatedEnvRoot('pi-bg-pack-script-env-');
    const packageRoot = join(temp, 'fixture-root');
    const sentinelDirectory = join(packageRoot, 'node_modules', 'npm-pack-lifecycle-sentinel');
    const packProject = join(temp, 'pack-project');
    const markerDirectory = join(temp, 'markers');
    const sentinelScripts = {
      prepack: 'node lifecycle.cjs prepack',
      prepare: 'node lifecycle.cjs prepare',
      postpack: 'node lifecycle.cjs postpack',
    };
    let registry: Awaited<ReturnType<typeof startInstalledDependencyRegistry>> | undefined;

    const resetMarkers = (): void => {
      rmSync(markerDirectory, { recursive: true, force: true });
      mkdirSync(markerDirectory, { recursive: true });
    };
    const markerEvents = (): string[] => {
      const markerPath = join(markerDirectory, 'attempts.log');
      if (!existsSync(markerPath)) return [];
      return readFileSync(markerPath, 'utf8').trim().split('\n').filter(Boolean);
    };
    const sentinelEnv = (failEvent: string): NodeJS.ProcessEnv => ({
      ...isolatedNpmEnv(envRoot),
      NPM_PACK_SENTINEL_MARKERS: markerDirectory,
      NPM_PACK_SENTINEL_FAIL_EVENT: failEvent,
    });

    try {
      makeIsolatedNpmProject(packageRoot, 'lifecycle-sentinel-root');
      makeIsolatedNpmProject(packProject, 'lifecycle-sentinel-pack-project');
      mkdirSync(sentinelDirectory, { recursive: true });
      const sentinelManifest = `${JSON.stringify(
        {
          name: 'npm-pack-lifecycle-sentinel',
          version: '1.0.0',
          scripts: sentinelScripts,
          files: ['lifecycle.cjs', 'payload.txt'],
        },
        null,
        2,
      )}\n`;
      writeFileSync(join(sentinelDirectory, 'package.json'), sentinelManifest);
      writeFileSync(join(sentinelDirectory, 'payload.txt'), 'real sentinel payload\n');
      writeFileSync(
        join(sentinelDirectory, 'lifecycle.cjs'),
        [
          "const { appendFileSync, mkdirSync } = require('node:fs');",
          "const { join } = require('node:path');",
          'const event = process.argv[2];',
          'const markers = process.env.NPM_PACK_SENTINEL_MARKERS;',
          "if (!markers) throw new Error('NPM_PACK_SENTINEL_MARKERS is required');",
          'mkdirSync(markers, { recursive: true });',
          "appendFileSync(join(markers, 'attempts.log'), `${event}\\n`, 'utf8');",
          'if (process.env.NPM_PACK_SENTINEL_FAIL_EVENT === event) {',
          '  throw new Error(`sentinel lifecycle executed: ${event}`);',
          '}',
          '',
        ].join('\n'),
      );

      const npmVersion = runNpm(['--version'], {
        cwd: packProject,
        env: sentinelEnv(''),
      });
      assert.equal(npmVersion.status, 0, npmVersion.stderr);
      const npmVersionText = requireSupportedNpmVersion(npmVersion.stdout);

      resetMarkers();
      const attemptedTarballs = join(temp, 'attempted-tarballs');
      mkdirSync(attemptedTarballs, { recursive: true });
      const lifecycleAttempt = runNpm(
        ['pack', '--json', '--pack-destination', attemptedTarballs, sentinelDirectory],
        { cwd: packProject, env: sentinelEnv('postpack') },
      );
      assert.notEqual(lifecycleAttempt.status, 0, 'the lifecycle control must fail loudly');
      assert.match(
        `${lifecycleAttempt.stderr}\n${lifecycleAttempt.stdout}`,
        /sentinel lifecycle executed: postpack/u,
      );
      assert.deepEqual(markerEvents(), ['prepack', 'prepare', 'postpack']);

      resetMarkers();
      const ignoredTarballs = join(temp, 'ignored-tarballs');
      mkdirSync(ignoredTarballs, { recursive: true });
      const ignoredAttempt = runNpm(
        [
          'pack',
          '--ignore-scripts',
          '--json',
          '--pack-destination',
          ignoredTarballs,
          sentinelDirectory,
        ],
        { cwd: packProject, env: sentinelEnv('prepare') },
      );
      assertNpmIgnoreScriptsObservation(
        npmVersionText,
        ignoredAttempt.status,
        `${ignoredAttempt.stderr}\n${ignoredAttempt.stdout}`,
        markerEvents(),
      );

      resetMarkers();
      await assert.rejects(
        startInstalledDependencyRegistry({
          dependencySpecs: { 'missing-lifecycle-sentinel': '1.0.0' },
          npmCli,
          npmEnv: sentinelEnv('prepare'),
          packageRoot,
          scratchDir: join(temp, 'invalid-registry'),
        }),
        /installed production dependency missing-lifecycle-sentinel is missing/u,
      );
      assert.deepEqual(markerEvents(), []);

      const sourceHashBefore = hashReadOnlyTree(sentinelDirectory);
      registry = await startInstalledDependencyRegistry({
        dependencySpecs: { 'npm-pack-lifecycle-sentinel': '1.0.0' },
        npmCli,
        npmEnv: sentinelEnv('prepare'),
        packageRoot,
        scratchDir: join(temp, 'safe-registry'),
      });
      assert.deepEqual(registry.packageVersions, ['npm-pack-lifecycle-sentinel@1.0.0']);
      assert.deepEqual(markerEvents(), [], 'safe dependency packaging must execute no lifecycle');
      assert.equal(hashReadOnlyTree(sentinelDirectory), sourceHashBefore);

      const consumer = join(temp, 'consumer');
      makeIsolatedNpmProject(consumer, 'lifecycle-sentinel-consumer');
      writeFileSync(
        join(consumer, 'package.json'),
        `${JSON.stringify(
          {
            name: 'lifecycle-sentinel-consumer',
            private: true,
            version: '1.0.0',
            dependencies: { 'npm-pack-lifecycle-sentinel': '1.0.0' },
          },
          null,
          2,
        )}\n`,
      );
      const install = await runNpmAsync(
        ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'],
        {
          cwd: consumer,
          env: {
            ...localRegistryNpmEnv(envRoot, registry.origin),
            NPM_PACK_SENTINEL_MARKERS: markerDirectory,
            NPM_PACK_SENTINEL_FAIL_EVENT: 'prepare',
          },
        },
      );
      assert.equal(install.status, 0, install.stderr);
      assert.equal(
        await readFile(
          join(consumer, 'node_modules', 'npm-pack-lifecycle-sentinel', 'package.json'),
          'utf8',
        ),
        sentinelManifest,
        'safe packaging must preserve the real script-bearing manifest bytes',
      );
      assert.deepEqual(markerEvents(), []);
      assert.equal(hashReadOnlyTree(sentinelDirectory), sourceHashBefore);
    } finally {
      if (registry !== undefined) await registry.close();
      await rm(temp, { recursive: true, force: true });
      removeIsolatedEnvRoot(envRoot);
    }
  });

  void it('installs a local tarball offline with zero private peers and runs raw shell logs on host libraries', async () => {
    const envRoot = makeIsolatedEnvRoot('pi-bg-local-install-');
    const consumer = join(envRoot, 'consumer'), packProject = join(envRoot, 'pack-project'), tarballs = join(envRoot, 'tarballs');
    let runtime: Awaited<ReturnType<typeof loadRuntime>> | undefined;
    try {
      makeIsolatedNpmProject(consumer, 'shell-consumer');
      makeIsolatedNpmProject(packProject, 'shell-pack-project');
      mkdirSync(tarballs);
      const pack = runNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', tarballs, fileURLToPath(root)], {
        cwd: packProject, env: isolatedNpmEnv(envRoot),
      });
      assert.equal(pack.status, 0, pack.stderr);
      const entry = parsePackEntries(pack.stdout)[0];
      assert.ok(entry);
      assert.equal(entry.files.some((file) => file.path.includes('node_modules')), false);
      const install = runNpm(['install', '--offline', '--legacy-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', join(tarballs, entry.filename)], {
        cwd: consumer, env: isolatedNpmEnv(envRoot),
      });
      assert.equal(install.status, 0, `${install.stdout}${install.stderr}`);
      const installed = join(consumer, 'node_modules', 'pi-background-shell');
      assert.ok(existsSync(join(installed, 'dist/extensions/background-tasks.js')));
      for (const peer of ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox']) {
        assert.equal(existsSync(join(consumer, 'node_modules', ...peer.split('/'))), false, `${peer} must come from the host`);
        assert.equal(existsSync(join(installed, 'node_modules', ...peer.split('/'))), false, `${peer} must not be bundled`);
      }
      runtime = await loadRuntime(join(installed, 'dist/extensions/background-tasks.js'));
      assert.deepEqual(runtime.tools.map((tool) => tool.name).sort(), ['bg_kill', 'bg_logs', 'bg_run', 'bg_status']);
      assert.deepEqual(runtime.session.extensionRunner.getRegisteredCommands().map((command) => command.invocationName).sort(), ['bg', 'bg-clear', 'bg-tasks', 'jobs', 'kill', 'logs', 'tasks']);
      for (const tool of runtime.tools) {
        assert.equal(Object.hasOwn(tool, 'promptSnippet'), false);
        assert.equal(Object.hasOwn(tool, 'promptGuidelines'), false);
      }
      const run = runtime.session.getToolDefinition('bg_run');
      const logs = runtime.session.getToolDefinition('bg_logs');
      assert.ok(run); assert.ok(logs);
      assert.match(run.description, /Shell executable:.*args:.*command syntax:/);
      const raw = '{"type":"message_end","message":{"role":"assistant"}}\n<pi-context-usage>not telemetry</pi-context-usage>\n';
      const script = "process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant'}})+'\\n<pi-context-usage>not telemetry</pi-context-usage>\\n');process.stderr.write('stderr raw\\n')";
      const command = `"${process.execPath}" -e "${script}"`;
      const terminalPromise = nextTerminal(runtime.eventBus);
      const result = await run.execute('packed-raw-run', { name: 'Raw shell', command, notifyOnCompletion: false, triggerOnCompletion: false }, undefined, undefined, runtime.session.extensionRunner.createToolContext('packed-tool', undefined));
      const task = record(result.details)['task'];
      const id = stringField(task, 'id');
      const terminal = await terminalPromise;
      assert.equal(record(terminal)['status'], 'completed');
      assert.equal(stringField(terminal, 'id'), id);
      const output = await readFile(join(runtime.cwd, stringField(task, 'outputPath')), 'utf8');
      assert.ok(output.includes(raw), output);
      assert.match(output, /stderr raw/);
      const logResult = await logs.execute('packed-raw-logs', { taskId: id, maxBytes: 50 * 1024, tail: true }, undefined, undefined, runtime.session.extensionRunner.createToolContext('packed-tool', undefined));
      assert.ok(logResult.content.some((part) => part.type === 'text' && part.text.includes(raw)));
      const runtimeDirectory = dirname(join(runtime.cwd, stringField(task, 'outputPath')));
      // Event delivery precedes a final delivery-latch metadata replacement; its
      // atomic temp name is legitimate, but no wrapper/producer artifact is.
      const entries = await readdir(runtimeDirectory);
      const atomicTemporary = new RegExp(`^\\.${id}\\.json\\.[0-9]+\\.[0-9a-f]+\\.tmp$`);
      for (const entry of entries) assert.ok(entry === `${id}.json` || entry === `${id}.output` || atomicTemporary.test(entry), `unexpected runtime artifact ${entry}`);
      assert.ok(entries.includes(`${id}.json`));
      assert.ok(entries.includes(`${id}.output`));
      const metadata = record(parseJsonValue(await readFile(join(runtimeDirectory, `${id}.json`), 'utf8')));
      for (const removed of ['isAgent', 'contextUsage', 'tokenUsage', 'toolUsage', 'model', 'telemetryWrapped']) assert.equal(Object.hasOwn(metadata, removed), false, removed);
      // A second source-entry activation proves local checkout installation is also
      // viable: the shipped source needs the declared workspace kit, which the
      // zero-dependency payload itself does not carry.
      await runtime.close(); runtime = undefined;
      mkdirSync(join(installed, 'node_modules'), { recursive: true });
      const workspaceKit = join(installed, 'node_modules/pi-ui-kit');
      if (!existsSync(workspaceKit)) symlinkSync(installedPackageDirectory('pi-ui-kit'), workspaceKit, process.platform === 'win32' ? 'junction' : 'dir');
      runtime = await loadRuntime(join(installed, 'extensions/background-tasks.ts'));
      assert.deepEqual(runtime.tools.map((tool) => tool.name).sort(), ['bg_kill', 'bg_logs', 'bg_run', 'bg_status']);
    } finally {
      if (runtime !== undefined) await runtime.close();
      removeIsolatedEnvRoot(envRoot);
    }
  });
});
