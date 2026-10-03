#!/usr/bin/env node
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PACKAGE_ROOT, assertCoverage, checkPayloadFiles, extractCodeFacts, extractRegistrations, generate,
  generateDocTexts, loadDocsModel, parseNpmPackFiles, resolveNpmCli,
  runtimeGraph, verify, verifyLinks, walkFiles,
} from './lib.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'pi-bg-docs-mutations-'));
try {
  for (const path of ['package.json', 'README.md', 'TESTING.md', 'UPSTREAM.md', 'CHANGELOG.md', 'LICENSE', 'src', 'extensions', 'docs']) {
    cpSync(join(PACKAGE_ROOT, path), join(scratch, path), { recursive: true });
  }
  await generate({ packageRoot: scratch });
  await verify({ packageRoot: scratch });
  const facts = extractCodeFacts({ packageRoot: scratch });
  const model = loadDocsModel({ packageRoot: scratch });
  assert.equal(JSON.stringify(generateDocTexts(facts, model)), JSON.stringify(generateDocTexts(facts, model)));
  const source = readFileSync(join(scratch, 'src/extension.ts'), 'utf8');
  const logs = { ...facts.contracts.log_bytes, MAX_TIMEOUT_SECONDS: facts.contracts.max_timeout_seconds };
  const commandDescription = facts.public_surfaces.tools.find((tool) => tool.name === 'bg_run').parameters.properties.command.description;
  const extract = (text) => extractRegistrations(text, { logConstants: logs });
  function mutateText(text, old, replacement) {
    assert.ok(text.includes(old), `mutation seam missing ${old}`);
    return text.replace(old, replacement);
  }
  function rejects(old, replacement, pattern) {
    assert.throws(() => extract(mutateText(source, old, replacement)), pattern);
  }
  rejects('BG_RUN_DESCRIPTION + shellPolicyDescription(shellPolicy)', 'BG_RUN_DESCRIPTION + arbitraryEvaluation(shellPolicy)', /controlled base/);
  rejects('BG_RUN_DESCRIPTION + shellPolicyDescription(shellPolicy)', 'shellPolicyDescription(shellPolicy) + BG_RUN_DESCRIPTION', /controlled base/);
  rejects("'Start a named long-running shell command", '`Start a named long-running shell command${process.env.SHELL}', /static literal|syntax error/);
  rejects("name: 'bg_run',", "name: 'bg_run', promptSnippet: 'hidden',", /description-only/);
  rejects("name: 'bg_run',", "name: 'bg_run', promptGuidelines: ['hidden'],", /description-only/);
  rejects("pi.registerCommand('jobs',", "pi.registerCommand('bg',", /duplicate public registration/);
  rejects("pi.registerCommand('jobs',", "pi['registerCommand']('jobs',", /computed Pi access/);
  rejects("pi.registerCommand('jobs',", "other.registerCommand('jobs',", /direct Pi call/);
  rejects("description: 'Open the background task manager UI',", "description: readEnvironment(),", /unsupported static expression/);
  rejects("if (config.dockShortcut === 'shift+down')", "if (process.env.HIDE_DOCK)", /unsupported shortcut condition/);
  rejects("parameters: BgRunParams,", 'parameters: arbitrarySchema(),', /unsupported schema expression/);
  rejects("name: 'bg_run',", "name: 'bg_run', ...hiddenMetadata,", /spread or shorthand/);
  rejects('const config = parseBackgroundTasksConfig();', "const config = parseBackgroundTasksConfig(); pi.on('before_agent_start', inject);", /system prompt injection/);
  rejects('const config = parseBackgroundTasksConfig();', "const config = parseBackgroundTasksConfig(); pi.on('context', inject);", /system prompt injection/);
  rejects('const config = parseBackgroundTasksConfig();', "const config = parseBackgroundTasksConfig(); const shellPolicyDescription = arbitraryEvaluation;", /binding shadowed/);

  const changed = extract(mutateText(source, commandDescription, 'Changed parameter description'));
  assert.notDeepEqual(changed, facts.public_surfaces, 'parameter description mutation must change extracted contracts');
  const changedSchema = extract(mutateText(source, 'minimum: 1', 'minimum: 2'));
  assert.equal(changedSchema.tools.find((tool) => tool.name === 'bg_run').parameters.properties.timeoutSeconds.minimum, 2);
  assert.throws(() => assertCoverage(facts, { docs: model.docs.filter((doc) => doc.path !== 'docs/subsystems/background-task-runtime.md') }), /missing\/duplicate primary source owner/);
  assert.throws(() => assertCoverage(facts, { docs: [...model.docs, model.docs.find((doc) => doc.frontmatter.covers_sources.length)] }), /missing\/duplicate primary source owner/);

  async function fileMutation(path, change, pattern) {
    const original = readFileSync(join(scratch, path), 'utf8');
    writeFileSync(join(scratch, path), change(original));
    try { await assert.rejects(verify({ packageRoot: scratch }), pattern); }
    finally { writeFileSync(join(scratch, path), original); }
  }
  await fileMutation('src/core/registry.ts', (text) => text + '\n// behavioral mutation fixture\n', /stale generated contract\/source hash/);
  await fileMutation('src/extension.ts', (text) => mutateText(text, commandDescription, 'Changed description'), /stale generated contract/);
  await fileMutation('src/core/extension-api.ts', (text) => mutateText(text, 'api_version: 2,', 'api_version: 1,'), /capabilities literal must be v2/);
  await fileMutation('src/core/extension-api.ts', (text) => mutateText(text, "'name', 'command', 'timeoutSeconds'", "'name', 'command', 'isAgent', 'timeoutSeconds'"), /closed run validator\/interface/);
  await fileMutation('src/core/extension-api.ts', (text) => text.replaceAll('pi-background-shell:request:v2', 'pi-background-tasks:request:v1'), /fork v2 identity/);
  await fileMutation('docs/subsystems/background-task-runtime.md', (text) => text + '\nProse mutation.\n', /stale generated contract/);
  await fileMutation('docs/subsystems/background-task-runtime.md', () => '# No frontmatter\n', /missing JSON frontmatter/);
  await fileMutation('docs/tools/bg_run.md', (text) => text + '\nChanged generated schema.\n', /stale generated contract/);
  const readme = readFileSync(join(scratch, 'README.md'), 'utf8');
  writeFileSync(join(scratch, 'README.md'), readme + '\n[broken](docs/missing.md)\n');
  assert.throws(() => verifyLinks(scratch), /broken local link/);
  writeFileSync(join(scratch, 'README.md'), readme + '\n[broken](docs/INDEX.md#missing-anchor)\n');
  assert.throws(() => verifyLinks(scratch), /broken anchor/);
  writeFileSync(join(scratch, 'README.md'), readme);

  const previous = { ...process.env };
  const keys = ['PI_BG_POSIX_SHELL', 'PI_BG_POSIX_SHELL_PATH', 'PI_BG_SHELL', 'PI_BG_DOCK_SHORTCUT', 'PI_BG_MAX_OUTPUT_BYTES', 'SHELL'];
  try {
    for (const key of keys) process.env[key] = '/invalid environment fixture which must never be evaluated';
    assert.deepEqual(extractCodeFacts({ packageRoot: scratch }), facts);
    await verify({ packageRoot: scratch });
  } finally {
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
  const graphRoot = join(scratch, 'closure');
  mkdirSync(join(graphRoot, 'dist/src'), { recursive: true });
  writeFileSync(join(graphRoot, 'dist/src/entry.js'), "export const deferred = () => import('./ui.js');\n");
  writeFileSync(join(graphRoot, 'dist/src/ui.js'), 'export const ui = true;\n');
  assert.deepEqual(runtimeGraph(graphRoot, 'dist/src/entry.js'), ['dist/src/entry.js', 'dist/src/ui.js']);
  rmSync(join(graphRoot, 'dist/src/ui.js'));
  assert.throws(() => runtimeGraph(graphRoot, 'dist/src/entry.js'), /closure missing/);
  writeFileSync(join(graphRoot, 'dist/src/entry.js'), 'export const deferred = () => import(path);\n');
  assert.throws(() => runtimeGraph(graphRoot, 'dist/src/entry.js'), /nonliteral deferred import/);
  const expectedPayload = ['package.json', 'README.md', 'TESTING.md', 'UPSTREAM.md', 'LICENSE', 'CHANGELOG.md', ...walkFiles(scratch, 'src'), ...walkFiles(scratch, 'extensions'), ...walkFiles(scratch, 'docs')];
  assert.throws(() => checkPayloadFiles(expectedPayload.filter((path) => path !== 'README.md'), scratch), /packed payload/);
  assert.throws(() => checkPayloadFiles([...expectedPayload, 'dist/src/core/pi-launch.js'], scratch), /packed payload/);
  assert.throws(() => checkPayloadFiles([...expectedPayload, 'node_modules/typebox/package.json'], scratch), /packed payload/);
  assert.deepEqual(parseNpmPackFiles('[{"files":[{"path":"z"},{"path":"a"}]}]'), ['a', 'z']);
  assert.throws(() => parseNpmPackFiles('{'), /valid JSON/);
  assert.throws(() => parseNpmPackFiles('[{"files":[]},{"files":[]}]'), /exactly one package/);
  assert.throws(() => parseNpmPackFiles('[{"files":[{}]}]'), /path must be a string/);
  assert.throws(() => resolveNpmCli('/not-node', {}, () => false), /cannot resolve npm-cli/);
  console.log('docs-selftest: schema, registration, source/prose, protocol, coverage, link and closure mutation fixtures passed; environment independent.');
} finally { rmSync(scratch, { recursive: true, force: true }); }
