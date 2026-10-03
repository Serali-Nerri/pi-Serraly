import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  boundedRead,
  deriveTaskNameFromCommand,
  formatDuration,
  formatSnapshotList,
  normalizeMaxBytes,
  normalizeTaskName,
  normalizeTimeoutSeconds,
  MAX_TIMEOUT_SECONDS,
  parseBgCommandArgs,
  sanitizePathSegment,
  shellInvocation,
  TASK_STATUS_VALUES,
  taskDisplayName,
  TERMINAL_TASK_STATUS_VALUES,
  truncateChars,
} from '../../src/core/common.js';

void describe('core', () => {
  void it('parses /bg names, aliases, equals forms, quotes, and empty commands', () => {
    assert.deepEqual(parseBgCommandArgs('--name "Build Docs" npm run docs'), {
      name: 'Build Docs',
      command: 'npm run docs',
      surviveReload: false,
    });
    assert.deepEqual(parseBgCommandArgs('--name=Build npm test'), {
      name: 'Build',
      command: 'npm test',
      surviveReload: false,
    });
    assert.deepEqual(parseBgCommandArgs("-n 'Quoted Name' printf ok"), {
      name: 'Quoted Name',
      command: 'printf ok',
      surviveReload: false,
    });
    assert.deepEqual(parseBgCommandArgs('-n=One printf one'), {
      name: 'One',
      command: 'printf one',
      surviveReload: false,
    });
    assert.deepEqual(parseBgCommandArgs('--survive-reload --name Keep node server.js'), {
      name: 'Keep',
      command: 'node server.js',
      surviveReload: true,
    });
    assert.deepEqual(parseBgCommandArgs('-- --survive-reload literal'), {
      command: '--survive-reload literal',
      surviveReload: false,
    });
    assert.deepEqual(parseBgCommandArgs('echo ok'), {
      command: 'echo ok',
      surviveReload: false,
    });
    assert.deepEqual(parseBgCommandArgs("--name 'Only Name'"), {
      name: 'Only Name',
      command: '',
      surviveReload: false,
    });
    assert.throws(() => parseBgCommandArgs('--name'), /requires a task name/);
    assert.throws(() => parseBgCommandArgs('--name "unterminated'), /requires a task name/);
    assert.throws(
      () => parseBgCommandArgs('--survive-reload --survive-reload echo duplicate'),
      /pi_bg_survive_reload_invalid/u,
    );
    assert.throws(
      () => parseBgCommandArgs('--survive-reload=true echo assignment'),
      /pi_bg_survive_reload_invalid/u,
    );
    assert.throws(
      () => parseBgCommandArgs('--agent --survive-reload pi -p hi'),
      /no longer supported/u,
    );
  });

  void it('rejects retired leading /bg options without inspecting command text or child flags', () => {
    for (const flag of ['--agent', '--llm-agent', '--script', '--no-agent']) {
      for (const args of [
        flag,
        `${flag} echo ok`,
        `${flag}\tpi --mode json`,
        `${flag}\necho ok`,
        `${flag}=true echo ok`,
        `--name Task ${flag} echo ok`,
        `--survive-reload ${flag} echo ok`,
      ]) {
        assert.throws(() => parseBgCommandArgs(args), /no longer supported/u, args);
      }
      assert.deepEqual(parseBgCommandArgs(`node child.js ${flag}`), {
        command: `node child.js ${flag}`,
        surviveReload: false,
      });
      assert.deepEqual(parseBgCommandArgs(`-- ${flag} literal`), {
        command: `${flag} literal`,
        surviveReload: false,
      });
      assert.deepEqual(parseBgCommandArgs(`--name '${flag}' printf '${flag}'`), {
        name: flag,
        command: `printf '${flag}'`,
        surviveReload: false,
      });
    }
    assert.deepEqual(parseBgCommandArgs('--name Pi --survive-reload pi --mode json --agent'), {
      name: 'Pi',
      command: 'pi --mode json --agent',
      surviveReload: true,
    });
  });

  void it('normalizes task names and derives stable fallbacks', () => {
    assert.equal(normalizeTaskName(' "A   B" '), 'A B');
    assert.equal(normalizeTaskName('\n\t'), undefined);
    assert.equal(normalizeTaskName(123), undefined);
    assert.equal(normalizeTaskName('x'.repeat(100)), `${'x'.repeat(79)}…`);
    assert.equal(deriveTaskNameFromCommand('npm run test -- --watch'), 'npm run test');
    assert.equal(deriveTaskNameFromCommand('pnpm build && echo done'), 'pnpm build');
    assert.equal(deriveTaskNameFromCommand(''), 'Background task');
    assert.equal(
      taskDisplayName({ description: 'Longer description', command: 'echo ok' }),
      'Longer description',
    );
    assert.equal(
      taskDisplayName({ command: 'echo one two three four five six' }),
      'echo one two three four',
    );
    assert.equal(taskDisplayName({ id: 'b123' }), 'b123');
  });

  void it('bounds and rounds timeouts without allowing Node timer overflow', () => {
    assert.equal(normalizeTimeoutSeconds(undefined), undefined);
    assert.equal(normalizeTimeoutSeconds(1), 1);
    assert.equal(normalizeTimeoutSeconds(1.9), 1);
    assert.equal(normalizeTimeoutSeconds(MAX_TIMEOUT_SECONDS), MAX_TIMEOUT_SECONDS);
    for (const invalid of [null, '1', 0, -1, 0.5, Infinity, Number.NaN, MAX_TIMEOUT_SECONDS + 1]) {
      assert.throws(() => normalizeTimeoutSeconds(invalid), /timeoutSeconds.*no more than/);
    }
  });

  void it('formats durations, paths, snapshots, and byte limits', () => {
    assert.equal(formatDuration(999), '999ms');
    assert.equal(formatDuration(1000), '1s');
    assert.equal(formatDuration(65_000), '1m5s');
    assert.equal(formatDuration(3_660_000), '1h1m');
    assert.equal(sanitizePathSegment('a/b c'), 'a-b-c');
    assert.equal(sanitizePathSegment('///'), 'session');
    // Pin both dialects explicitly. The host default differs by platform:
    // cmd.exe requires the paired outer-quoted form, POSIX passes the command
    // through verbatim, so an unpinned assertion fails on Windows.
    assert.equal(shellInvocation('echo ok', 'linux', {}).args.includes('echo ok'), true);
    assert.deepEqual(shellInvocation('echo ok', 'win32', { ComSpec: 'cmd.exe' }).args, [
      '/d',
      '/s',
      '/c',
      '"echo ok"',
    ]);
    assert.equal(normalizeMaxBytes(-1, 123), 1);
    assert.equal(normalizeMaxBytes(Number.NaN, 123), 123);
    assert.equal(normalizeMaxBytes(1.9, 123), 1);
    assert.equal(truncateChars('abcdef', 4), 'abc…');
    assert.deepEqual([...TASK_STATUS_VALUES], ['running', 'completed', 'failed', 'killed']);
    assert.deepEqual([...TERMINAL_TASK_STATUS_VALUES], ['completed', 'failed', 'killed']);

    const text = formatSnapshotList(
      [
        {
          id: 'b12345678',
          name: 'Unit Task',
          command: 'echo ok',
          status: 'completed',
          outputPath: '.pi/tasks/run/b12345678.output',
          cwd: '/tmp',
          startTime: 1000,
          endTime: 2000,
          exitCode: 0,
          bytesWritten: 3,
          surviveReload: false,
          notified: true,
          notifyOnCompletion: true,
          triggerOnCompletion: false,

        },
        {
          id: 'b99999999',
          command: 'bad',
          status: 'failed',
          outputPath: '.pi/tasks/run/b99999999.output',
          cwd: '/tmp',
          startTime: 1000,
          endTime: 2000,
          exitCode: 1,
          bytesWritten: 0,
          surviveReload: false,
          error: 'x'.repeat(100),
          notified: false,
          notifyOnCompletion: true,
          triggerOnCompletion: true,
        },
      ],
      2000,
    );
    assert.match(text, /Unit Task/);
    assert.match(text, /✗ b99999999 failed/);
    assert.match(text, /output: \.pi\/tasks/);

  });

  void it('applies the Windows shell dialect policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-bg-shell-'));
    try {
      const bashPath = join(root, 'bash.exe');
      const cmdPath = join(root, 'cmd.com');
      await writeFile(bashPath, '', 'utf8');
      await writeFile(cmdPath, '', 'utf8');

      assert.deepEqual(
        shellInvocation('echo %USERPROFILE%', 'win32', {
          SHELL: bashPath,
          ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        }),
        {
          shell: 'C:\\Windows\\System32\\cmd.exe',
          args: ['/d', '/s', '/c', '"echo %USERPROFILE%"'],
          dialect: 'cmd',
          windowsVerbatimArguments: true,
        },
      );
      assert.deepEqual(shellInvocation('dir C:\\work', 'win32', {}), {
        shell: 'cmd.exe',
        args: ['/d', '/s', '/c', '"dir C:\\work"'],
        dialect: 'cmd',
        windowsVerbatimArguments: true,
      });
      assert.deepEqual(
        shellInvocation('printf ok', 'win32', {
          PI_BG_SHELL: 'bash',
          PI_BG_SHELL_PATH: bashPath,
        }),
        {
          shell: bashPath,
          args: ['-c', 'printf ok'],
          dialect: 'posix',
          windowsVerbatimArguments: false,
        },
      );
      assert.notDeepEqual(
        shellInvocation('printf ok', 'win32', {
          PI_BG_SHELL: 'bash',
          PI_BG_SHELL_PATH: bashPath,
        }).args,
        ['-lc', 'printf ok'],
      );
      assert.equal(
        shellInvocation('printf ok', 'win32', { PI_BG_SHELL: 'bash', PATH: root }).shell,
        bashPath,
      );
      assert.equal(
        shellInvocation('set X=1', 'win32', { PI_BG_SHELL: 'cmd', PI_BG_SHELL_PATH: cmdPath })
          .shell,
        cmdPath,
      );
      for (const value of ['', ' bash', 'bash ', 'zsh']) {
        assert.throws(() => shellInvocation('echo bad', 'win32', { PI_BG_SHELL: value }), /cmd or bash/);
      }
      assert.throws(
        () => shellInvocation('echo bad', 'win32', { PI_BG_SHELL_PATH: bashPath }),
        /requires PI_BG_SHELL/,
      );
      assert.throws(
        () =>
          shellInvocation('echo bad', 'win32', {
            PI_BG_SHELL: 'bash',
            PI_BG_SHELL_PATH: 'bash.exe',
          }),
        /absolute path/,
      );
      assert.deepEqual(
        shellInvocation('echo $SHELL', 'linux', {
          SHELL: '/bin/zsh',
          PI_BG_SHELL: 'cmd',
          PI_BG_SHELL_PATH: bashPath,
        }),
        {
          shell: '/bin/zsh',
          args: ['-c', 'echo $SHELL'],
          dialect: 'posix',
          windowsVerbatimArguments: false,
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('boundedRead supports head, tail, truncation, and empty files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-bg-unit-'));
    try {
      const f = join(dir, 'out');
      await writeFile(f, 'abcdef');
      assert.deepEqual(await boundedRead(f, 3, true), {
        content: 'def',
        truncated: true,
        bytesRead: 3,
        totalBytes: 6,
      });
      assert.deepEqual(await boundedRead(f, 3, false), {
        content: 'abc',
        truncated: true,
        bytesRead: 3,
        totalBytes: 6,
      });
      assert.deepEqual(await boundedRead(f, 99, false), {
        content: 'abcdef',
        truncated: false,
        bytesRead: 6,
        totalBytes: 6,
      });
      const empty = join(dir, 'empty');
      await writeFile(empty, '');
      assert.deepEqual(await boundedRead(empty, 3, true), {
        content: '',
        truncated: false,
        bytesRead: 0,
        totalBytes: 0,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
