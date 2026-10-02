import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Compile } from 'typebox/compile';
import { Value } from 'typebox/value';
import { loadRuntime, record } from './runtime-fixture.js';
import { installedPackageDirectory } from "../helpers/workspace-dependencies.ts";

const root = resolve(import.meta.dirname, '../..');
void describe('Pi 0.99.2 / TypeBox 1.3.27 shell schema parity', { concurrency: false }, () => {
  void it('uses exact verified development packages but ships only wildcard host peers', async () => {
    const pkg = record(JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')));
    assert.equal(pkg['private'], true);
    const peers = record(pkg['peerDependencies']), dev = record(pkg['devDependencies']);
    assert.deepEqual(Object.keys(peers).sort(), ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox']);
    for (const peer of Object.keys(peers)) assert.equal(peers[peer], '*');
    // pi-ai is used by scripted-provider tests, not by the shipped shell runtime.
    for (const peer of ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox']) {
      const expected = peer === 'typebox' ? '1.3.27' : '0.99.2';
      assert.equal(dev[peer], expected);
      const installed = record(JSON.parse(await readFile(resolve(installedPackageDirectory(peer), 'package.json'), 'utf8')));
      assert.equal(installed['version'], expected);
      assert.equal(record(pkg['dependencies'] ?? {})[peer], undefined);
    }
  });
  void it('compiles all four actual registered schemas and matches generated AST docs without prompt fields', async () => {
    const runtime = await loadRuntime(resolve(root, 'dist/extensions/background-tasks.js'));
    try {
      const manifest = record(JSON.parse(await readFile(resolve(root, 'docs/manifest.json'), 'utf8')));
      const surfaces = record(manifest['public_surfaces']);
      const extracted = surfaces['tools'];
      assert.ok(Array.isArray(extracted));
      assert.deepEqual(runtime.tools.map((tool) => tool.name).sort(), ['bg_kill', 'bg_logs', 'bg_run', 'bg_status']);
      for (const tool of runtime.tools) {
        const facts: Record<string, unknown> | undefined = extracted.map(record).find((item) => item['name'] === tool.name);
        assert.ok(facts);
        assert.deepEqual(JSON.parse(JSON.stringify(tool.parameters)), facts['parameters'], `${tool.name} AST schema must match real TypeBox schema`);
        assert.equal(Object.hasOwn(tool, 'promptSnippet'), false);
        assert.equal(Object.hasOwn(tool, 'promptGuidelines'), false);
        if (tool.name === 'bg_run') assert.ok(tool.description.startsWith(String(facts['description'])));
        else assert.equal(tool.description, facts['description']);
        const compiled: { Check(value: unknown): boolean } = Compile(tool.parameters);
        const valid: Record<string, unknown> = tool.name === 'bg_run' ? { name: 'Schema check', command: 'echo ok' } : tool.name === 'bg_status' ? {} : { taskId: 'b123' };
        assert.equal(compiled.Check(valid), true, tool.name);
        assert.equal(Value.Check(tool.parameters, valid), true, tool.name);
        assert.equal(compiled.Check(tool.name === 'bg_run' ? { name: 'Bad', command: 42 } : { taskId: 42 }), false, tool.name);
        if (tool.name === 'bg_run') {
          assert.equal(compiled.Check({ name: 'Bad', command: 'echo ok', isAgent: false }), false, 'removed classification field must fail');
          assert.equal(compiled.Check({ name: 'Bad', command: 'echo ok', timeoutSeconds: 0 }), false);
          assert.equal(compiled.Check({ command: 'echo ok' }), false, 'name is schema-required');
        }
      }
    } finally { await runtime.close(); }
  });
});
