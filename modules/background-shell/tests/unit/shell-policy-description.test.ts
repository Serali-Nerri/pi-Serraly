import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { shellInvocationForPolicy } from '../../src/core/common.js';
import * as shellPolicyModule from '../../src/core/shell-policy.js';
import {
  initializeShellPolicy,
  shellPolicyDescription,
} from '../../src/core/shell-policy.js';

void describe('shell-policy description-only contract', () => {
  void it('exports only initialization and a description suffix, with no prompt hooks', () => {
    assert.deepEqual(Object.keys(shellPolicyModule).sort(), [
      'initializeShellPolicy',
      'shellPolicyDescription',
    ]);
  });

  for (const [executable, syntax] of [
    ['/bin/bash', 'Bash'],
    ['/bin/sh', 'POSIX shell'],
    ['/bin/zsh', 'POSIX shell'],
    ['/usr/bin/fish', 'inherited shell (not classified as Bash or POSIX)'],
    ['/usr/bin/nu', 'inherited shell (not classified as Bash or POSIX)'],
    ['/custom/unknown', 'inherited shell (not classified as Bash or POSIX)'],
  ] as const) {
    void it(`describes the actual inherited executable and syntax: ${executable}`, () => {
      const policy = initializeShellPolicy({ platform: 'linux', env: { SHELL: executable } });
      const suffix = shellPolicyDescription(policy);
      assert.ok(suffix.startsWith(' '), 'composes with a static base description');
      assert.ok(!suffix.includes('\n'), 'brief single-line description');
      assert.ok(suffix.includes(`Shell executable: ${JSON.stringify(executable)}`));
      assert.ok(suffix.includes('args: ["-c","<command>"]'));
      assert.ok(suffix.includes(`command syntax: ${syntax}.`));
      const invocation = shellInvocationForPolicy('<command>', policy);
      assert.equal(invocation.shell, policy.executable);
      assert.ok(suffix.includes(`args: ${JSON.stringify(invocation.args)}`));
    });
  }

  void it('describes Windows cmd argv quoting without reading POSIX settings', () => {
    const policy = initializeShellPolicy({
      platform: 'win32',
      env: {
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        PI_BG_POSIX_SHELL: 'invalid-and-ignored',
        PI_BG_POSIX_SHELL_PATH: '/invalid-and-ignored',
      },
    });
    const invocation = shellInvocationForPolicy('<command>', policy);
    const suffix = shellPolicyDescription(policy);
    assert.ok(suffix.includes(`Shell executable: ${JSON.stringify(invocation.shell)}`));
    assert.ok(suffix.includes(`args: ${JSON.stringify(invocation.args)}`));
    assert.deepEqual(invocation.args, ['/d', '/s', '/c', '"<command>"']);
    assert.match(suffix, /command syntax: Windows cmd\.exe/);
    assert.doesNotMatch(suffix, /login-shell/);
  });

  void it('describes explicit custom args honestly, including login-shell args', () => {
    const base = initializeShellPolicy({ platform: 'linux', env: { SHELL: '/bin/bash' } });
    for (const argvPrefix of [['-lc'], ['--norc', '-c'], ['--login', '-c']]) {
      const custom = { ...base, argvPrefix };
      const invocation = shellInvocationForPolicy('<command>', custom);
      const suffix = shellPolicyDescription(custom);
      assert.ok(suffix.includes(`args: ${JSON.stringify(invocation.args)}`));
      assert.doesNotMatch(suffix, /never|-c,|non-login|No login-shell|not loaded/);
    }
    assert.match(shellPolicyDescription(base), /No login-shell flag is requested/);
  });

  void it('freezes activation selection, reflects a fresh selection, and never exposes wholesale env', () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: '/bin/bash',
      SECRET_TOKEN: 'do-not-leak-this-secret',
      PI_BG_FEATURES: 'removed-feature-value',
    };
    const first = initializeShellPolicy({ platform: 'linux', env });
    const before = shellPolicyDescription(first);
    env['SHELL'] = '/bin/zsh';
    assert.equal(shellPolicyDescription(first), before);
    const fresh = initializeShellPolicy({ platform: 'linux', env });
    assert.equal(first.executable, '/bin/bash');
    assert.equal(fresh.executable, '/bin/zsh');
    assert.ok(Object.isFrozen(first));
    assert.ok(Object.isFrozen(first.argvPrefix));
    assert.throws(() => Reflect.apply(Array.prototype.push, first.argvPrefix, ['-lc']), TypeError);
    assert.doesNotMatch(before, /SECRET_TOKEN|do-not-leak|PI_BG_FEATURES|removed-feature/);
  });

  void it('JSON-escapes unusual shell paths and arguments without changing launch bytes', () => {
    const base = initializeShellPolicy({ platform: 'linux', env: { SHELL: '/path with space/"shell"\nΩ' } });
    const custom = { ...base, argvPrefix: ['--argument=quote"\nΩ', '-c'] };
    const suffix = shellPolicyDescription(custom);
    const invocation = shellInvocationForPolicy('<command>', custom);
    assert.ok(suffix.includes(JSON.stringify(invocation.shell)));
    assert.ok(suffix.includes(JSON.stringify(invocation.args)));
    assert.ok(!suffix.includes('\n'));
  });

  void it('keeps shell selection failures loud rather than inventing a description', () => {
    assert.throws(
      () => initializeShellPolicy({ platform: 'linux', env: { PI_BG_POSIX_SHELL: 'invalid' } }),
      /PI_BG_POSIX_SHELL must be exactly/,
    );
  });

  void it('uses the same immutable selection for a real non-Windows shell launch', {
    skip: process.platform === 'win32' ? 'POSIX execution fixture' : false,
  }, () => {
    const policy = initializeShellPolicy({ platform: process.platform, env: { PI_BG_POSIX_SHELL: 'sh' } });
    const invocation = shellInvocationForPolicy('printf shell-description-ok', policy);
    const result = spawnSync(invocation.shell, invocation.args, { encoding: 'utf8' });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'shell-description-ok');
    const suffix = shellPolicyDescription(policy);
    assert.ok(suffix.includes(JSON.stringify(invocation.shell)));
    assert.ok(suffix.includes('args: ["-c","<command>"]'));
    assert.match(suffix, /command syntax: POSIX shell/);
  });
});
