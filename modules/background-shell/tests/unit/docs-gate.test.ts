import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
function run(rel: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [fileURLToPath(new URL(`../../${rel}`, import.meta.url)), ...args], {
    cwd: root, encoding: 'utf8', env, timeout: 60_000,
  });
}
void describe('focused docs/schema freshness gate', () => {
  void it('detects contract/source/prose/protocol/coverage/closure mutations without executing runtime or reading shell settings', () => {
    const result = run('scripts/docs/selftest.mjs');
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /mutation fixtures passed; environment independent/);
  });
  void it('verifies deterministic current docs even under invalid activation-only environment', () => {
    const result = run('scripts/docs/verify.mjs', [], {
      ...process.env, PI_BG_POSIX_SHELL: 'invalid', PI_BG_SHELL: 'invalid',
      PI_BG_DOCK_SHORTCUT: 'invalid', PI_BG_MAX_OUTPUT_BYTES: 'invalid', SHELL: '/invalid',
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /deterministic schema\/docs generation OK/);
  });
  void it('rejects obsolete attestation flags instead of relying on archived receipts', () => {
    const result = run('scripts/docs/verify.mjs', ['--require-attestations']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown argument/);
  });
});
