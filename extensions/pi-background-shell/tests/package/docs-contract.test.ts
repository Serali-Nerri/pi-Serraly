import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const text = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
interface Surface { id: string; availability: string; description: string; description_suffix?: string }
interface Manifest {
  schema_version: string;
  package: { verified_host: string };
  public_surfaces: { tools: Surface[]; commands: Surface[]; shortcuts: Surface[] };
  governed_sources: Array<{ path: string; owner: string }>;
  eventbus: { capabilities: { api_version: number }; run: Array<{ name: string; required: boolean }> };
}
void describe('shell docs package contract', () => {
  void it('retains generation/verification/prepack/payload gates and only current docs', () => {
    const pkg = JSON.parse(text('package.json')) as { files: string[]; scripts: Record<string, string>; serraly: { build: { verifyArtifact?: string } } };
    assert.ok(pkg.files.includes('docs/'));
    assert.ok(pkg.files.includes('UPSTREAM.md'));
    assert.equal(pkg.scripts['docs:generate'], 'node scripts/docs/generate.mjs');
    assert.equal(pkg.scripts['docs:verify'], 'node scripts/docs/verify.mjs');
    // The packed-payload gate still runs inside every build, through the shared builder.
    assert.equal(pkg.serraly.build.verifyArtifact, './scripts/check-package-payload.mjs');
    for (const path of ['docs/INDEX.md', 'docs/read-before-edit.md', 'docs/manifest.json', 'docs/reference/runtime-contracts.md', 'docs/api/eventbus-v2.md']) assert.ok(existsSync(new URL(`../../${path}`, import.meta.url)), path);
    for (const path of ['docs/attestations.json', 'scripts/docs/attest.mjs', 'docs/api/eventbus-v1.md', 'docs/subsystems/fusion.md', 'docs/tools/bg_delegate.md']) assert.equal(existsSync(new URL(`../../${path}`, import.meta.url)), false, path);
    const result = spawnSync(process.execPath, ['scripts/docs/verify.mjs'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  });
  void it('publishes exactly four tools/seven commands and only dock availability variants', () => {
    const manifest = JSON.parse(text('docs/manifest.json')) as Manifest;
    const pkgManifest = JSON.parse(text('package.json')) as { serraly: { build: { bundles?: unknown } } };
    assert.equal(manifest.schema_version, 'pi-background-shell.docs-manifest.v1');
    assert.equal(manifest.package.verified_host, '1.2.0');
    assert.deepEqual(manifest.public_surfaces.tools.map((tool) => tool.id), ['tool:bg_kill', 'tool:bg_logs', 'tool:bg_run', 'tool:bg_status']);
    assert.deepEqual(manifest.public_surfaces.commands.map((cmd) => cmd.id), ['command:bg', 'command:bg-clear', 'command:bg-tasks', 'command:jobs', 'command:kill', 'command:logs', 'command:tasks']);
    for (const surface of [...manifest.public_surfaces.tools, ...manifest.public_surfaces.commands]) assert.equal(surface.availability, 'always');
    const dock = new Map(manifest.public_surfaces.shortcuts.map((item) => [item.id, item.availability]));
    assert.equal(dock.get('shortcut:shift+down'), 'dock:shift+down');
    assert.equal(dock.get('shortcut:ctrl+alt+b'), 'dock:ctrl+alt+b');
    assert.equal(dock.get('shortcut:ctrl+alt+c'), 'always');
    assert.equal(manifest.governed_sources.length, 15);
    assert.equal(
      manifest.governed_sources.find((source) => source.path === 'src/ui/task-log-viewport.ts')?.owner,
      'docs/reference/shortcuts-and-dock.md',
    );
    // The bundled tool-card leaf is owned by the lifecycle doc, which also states
    // the bundling contract; the kit stays a declared workspace devDependency.
    assert.equal(
      manifest.governed_sources.find((source) => source.path === 'src/ui/tool-cards.ts')?.owner,
      'docs/subsystems/extension-lifecycle.md',
    );
    assert.deepEqual(pkgManifest.serraly.build.bundles, {
      'src/ui/tool-cards.ts': { output: 'dist/src/ui/tool-cards.js', packages: ['pi-ui-kit'] },
    });
    for (const source of manifest.governed_sources) assert.ok(text(source.owner).includes(source.path));
  });
  void it('records only the static run description plus dynamic shell rule, with v2 wire fields', () => {
    const manifest = JSON.parse(text('docs/manifest.json')) as Manifest;
    const run = manifest.public_surfaces.tools.find((tool) => tool.id === 'tool:bg_run');
    assert.ok(run);
    assert.match(run.description_suffix ?? '', /BG_RUN_DESCRIPTION \+ shellPolicyDescription\(shellPolicy\)/);
    assert.match(text('docs/tools/bg_run.md'), /Dynamic shell suffix/);
    assert.match(text('docs/operations/configuration.md'), /never evaluates extension code/);
    assert.equal(manifest.eventbus.capabilities.api_version, 2);
    assert.deepEqual(manifest.eventbus.run.filter((field) => field.required).map((field) => field.name), ['name', 'command', 'notifyOnCompletion', 'triggerOnCompletion']);
    assert.deepEqual(manifest.eventbus.run.filter((field) => !field.required).map((field) => field.name), ['timeoutSeconds']);
    assert.match(text('UPSTREAM.md'), /471f1dcae7ff13d8f989e4c056bdff1e6b01f1ef/);
    assert.match(text('UPSTREAM.md'), /pi-background-tasks@2\.6\.8/);
    assert.match(text('README.md'), /No disk\/PID adoption/);
  });
});
