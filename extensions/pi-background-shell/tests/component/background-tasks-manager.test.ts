import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fsPromises, { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Theme, type ThemeColor } from '@earendil-works/pi-coding-agent';
import { TuiAltScreen, TuiMainScreen, visibleWidth, type ProgramStatus, type Terminal } from '@earendil-works/pi-tui';
import {
  BackgroundTasksManager,
  TASK_MANAGER_OVERLAY_OPTIONS,
  type BackgroundTaskForUi,
} from '../../src/ui/background-tasks-manager.js';
import { stripAnsi } from '../helpers/normalize.js';

const themeColors: readonly ThemeColor[] = [
  'accent',
  'border',
  'borderAccent',
  'borderMuted',
  'success',
  'error',
  'warning',
  'muted',
  'dim',
  'text',
  'thinkingText',
  'userMessageText',
  'customMessageText',
  'customMessageLabel',
  'toolTitle',
  'toolOutput',
  'mdHeading',
  'mdLink',
  'mdLinkUrl',
  'mdCode',
  'mdCodeBlock',
  'mdCodeBlockBorder',
  'mdQuote',
  'mdQuoteBorder',
  'mdHr',
  'mdListBullet',
  'toolDiffAdded',
  'toolDiffRemoved',
  'toolDiffContext',
  'syntaxComment',
  'syntaxKeyword',
  'syntaxFunction',
  'syntaxVariable',
  'syntaxString',
  'syntaxNumber',
  'syntaxType',
  'syntaxOperator',
  'syntaxPunctuation',
  'thinkingOff',
  'thinkingMinimal',
  'thinkingLow',
  'thinkingMedium',
  'thinkingHigh',
  'thinkingXhigh',
  'bashMode',
];
const themeBackgrounds = [
  'selectedBg',
  'userMessageBg',
  'customMessageBg',
  'toolPendingBg',
  'toolSuccessBg',
  'toolErrorBg',
] as const;
type ThemeForegrounds = ConstructorParameters<typeof Theme>[0];
type ThemeBackgrounds = ConstructorParameters<typeof Theme>[1];
const theme = new Theme(
  Object.fromEntries(themeColors.map((color) => [color, '#ffffff'])) as ThemeForegrounds,
  Object.fromEntries(themeBackgrounds.map((color) => [color, '#000000'])) as ThemeBackgrounds,
  'truecolor',
);

function task(overrides: Partial<BackgroundTaskForUi> = {}): BackgroundTaskForUi {
  const now = Date.now();
  return {
    id: 'b12345678',
    name: 'Component Task',
    command: 'printf component-ok',
    status: 'running',
    outputPath: '.pi/tasks/test/b12345678.output',
    outputAbsPath: join(tmpdir(), 'missing-output'),
    cwd: tmpdir(),
    startTime: now - 1000,
    bytesWritten: 0,
    surviveReload: false,
    notified: false,
    notifyOnCompletion: true,
    triggerOnCompletion: false,
    ...overrides,
  };
}

function manager(
  options: Partial<ConstructorParameters<typeof BackgroundTasksManager>[3]> = {},
  tasks: BackgroundTaskForUi[] = [task()],
  terminal = { rows: 40 },
) {
  let closed = false;
  let renders = 0;
  const stopped: string[] = [];
  const paths: string[] = [];
  const seen = new Set<string>();
  const instance = new BackgroundTasksManager(
    {
      terminal,
      requestRender: () => {
        renders++;
      },
    },
    theme,
    () => {
      closed = true;
    },
    {
      getTasks: () => tasks,
      stopTask: (t) => {
        stopped.push(t.id);
        t.status = 'killed';
        t.endTime = Date.now();
        return Promise.resolve();
      },
      stopAllRunning: () => {
        const running = tasks.filter((t) => t.status === 'running');
        for (const t of running) {
          stopped.push(t.id);
          t.status = 'killed';
          t.endTime = Date.now();
        }
        return Promise.resolve({ stopped: running.length, failures: [] });
      },
      rerunTask: (t) => {
        const overrides: Partial<BackgroundTaskForUi> = {
          id: `babcdef${String(tasks.length)}`,
          name: t.name,
          command: t.command,
          startTime: Date.now(),
        };
        if (t.description !== undefined) overrides.description = t.description;
        if (t.timeoutSeconds !== undefined) overrides.timeoutSeconds = t.timeoutSeconds;
        const rerun = task(overrides);
        tasks.unshift(rerun);
        return Promise.resolve(rerun);
      },
      showOutputPath: (t) => {
        paths.push(t.outputPath);
      },
      markSeen: (id) => {
        seen.add(id);
      },
      markFinishedSeen: (ids) => {
        for (const id of ids) seen.add(id);
      },
      isSeen: (id) => seen.has(id),
      ...options,
    },
  );
  return {
    instance,
    get closed() {
      return closed;
    },
    get renders() {
      return renders;
    },
    stopped,
    paths,
    seen,
    terminal,
  };
}

function assertWidth(lines: string[], width: number) {
  for (const line of lines) assert.ok(visibleWidth(stripAnsi(line)) <= width, line);
}

const keys = {
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  pageUp: '\x1b[5~',
  pageDown: '\x1b[6~',
  shiftLeft: '\x1b[1;2D',
  shiftRight: '\x1b[1;2C',
};

function renderText(instance: BackgroundTasksManager, width: number): string {
  return stripAnsi(instance.render(width).join('\n'));
}

function outputNumbers(text: string): number[] {
  return [...text.matchAll(/LINE-(\d{3})/gu)].map((match) => Number(match[1]));
}

function panelHeight(rows: number): number {
  return Math.max(1, Math.min(Math.floor(rows * 0.8), rows - 2));
}

class MemoryTerminal implements Terminal {
  columns = 120;
  rows = 24;
  kittyProtocolActive = false;
  writes: string[] = [];
  start(_onInput: (data: string) => void, _onResize: () => void): void {}
  stop(): void {}
  drainInput(): Promise<void> { return Promise.resolve(); }
  write(data: string): void { this.writes.push(data); }
  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}
  setProgramStatus(_status: ProgramStatus): void {}
}

/** Render also starts a wide-layout preview read; wait for real asynchronous file IO. */
async function waitForOutput(
  instance: BackgroundTasksManager,
  width: number,
  expected: string,
): Promise<string> {
  const deadline = Date.now() + 2000;
  let text = '';
  do {
    text = renderText(instance, width);
    if (text.includes(expected)) return text;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.ok(text.includes(expected), `Expected ${JSON.stringify(expected)} in:\n${text}`);
  return text;
}

function numberedOutput(count: number, suffix = ''): string {
  return Array.from({ length: count }, (_, i) =>
    `LINE-${String(i + 1).padStart(3, '0')}${suffix}`,
  ).join('\n') + '\n';
}

async function withOutputTasks(
  contents: readonly string[],
  run: (tasks: BackgroundTaskForUi[]) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-bg-responsive-'));
  try {
    const tasks: BackgroundTaskForUi[] = [];
    for (const [index, content] of contents.entries()) {
      const outputAbsPath = join(dir, `${index}.output`);
      await writeFile(outputAbsPath, content, 'utf8');
      tasks.push(task({
        id: `bfixture${index}`,
        name: `Fixture Task ${index}`,
        startTime: Date.now() - index * 1000,
        outputAbsPath,
        outputPath: `.pi/tasks/test/${index}.output`,
        bytesWritten: Buffer.byteLength(content),
      }));
    }
    await run(tasks);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

void describe('BackgroundTasksManager component', () => {
  void it('passes the selected survival flag to dock rerun and accepts a new id/nonce', async () => {
    const original = task({
      id: 'bsurvive1',
      surviveReload: true,
      reloadSurvival: {
        schemaVersion: 'pi-background-shell.reload-shell.v1',
        authority: 'same-process-live-owner',
        hostPid: process.pid,
        sessionId: 'component',
        cwdRealpath: tmpdir(),
        launchNonce: '1'.repeat(32),
        completionId: 'bsurvive1:1',
        spawnedAt: 1,
        childPid: 100,
        outputCapBytes: 1024,
        leaseGeneration: 1,
        handoffCount: 0,
      },
    });
    let rerunInput: BackgroundTaskForUi | undefined;
    const h = manager(
      {
        rerunTask: (selected) => {
          rerunInput = selected;
          return Promise.resolve(
            task({
              ...selected,
              id: 'bsurvive2',
              reloadSurvival: {
                ...selected.reloadSurvival!,
                launchNonce: '2'.repeat(32),
                completionId: 'bsurvive2:1',
              },
            }),
          );
        },
      },
      [original],
    );
    try {
      h.instance.handleInput('R');
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(rerunInput?.id, original.id);
      assert.equal(rerunInput?.surviveReload, true);
      assert.match(stripAnsi(h.instance.render(90).join('\n')), /Reran as .*\(bsurvive2\)/u);
    } finally {
      h.instance.dispose();
    }
  });

  void it('renders list within width and handles selection/actions', async () => {
    const baseTime = Date.now();
    const tasks = [
      task({ id: 'b11111111', name: 'First Task', startTime: baseTime + 1000 }),
      task({ id: 'b22222222', name: 'Second Task', startTime: baseTime }),
    ];
    const h = manager({}, tasks);
    try {
      const lines = h.instance.render(90);
      assert.match(stripAnsi(lines.join('\n')), /bg tasks focused/);
      assert.match(stripAnsi(lines.join('\n')), /First Task/);
      assertWidth(lines, 90);

      h.instance.handleInput('\x1b[B');
      h.instance.handleInput('k');
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(h.stopped, ['b22222222']);

      h.instance.handleInput('h');
      h.instance.handleInput('R');
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.ok(tasks.some((candidate) => candidate.id.startsWith('babcdef')));

      h.instance.handleInput('c');
      assert.ok(h.paths.length >= 1);

      h.instance.handleInput('x');
      assert.equal(h.closed, true);
    } finally {
      h.instance.dispose();
    }
  });

  void it('shows process facts and output-byte activity without telemetry rows or placeholders', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-bg-shell-ui-'));
    try {
      const outputAbsPath = join(dir, 'task.output');
      await writeFile(outputAbsPath, 'shell-output\n', 'utf8');
      const selected = task({
        name: 'Shell Task',
        description: 'Plain shell execution',
        pid: 12345,
        outputAbsPath,
        bytesWritten: 24,
      });
      const h = manager({}, [selected]);
      try {
        let text = stripAnsi(h.instance.render(90).join('\n'));
        assert.match(text, /Shell Task/);
        assert.match(text, /running/);
        assert.doesNotMatch(text, /ctx |model |tok |tools |not reported by/);
        selected.bytesWritten += 1024;
        text = stripAnsi(h.instance.render(90).join('\n'));
        assert.match(text, /\+\S+ ↑/);
        assert.match(stripAnsi(h.instance.render(90).join('\n')), /\+\S+ ↑/);
        h.instance.handleInput('\r');
        await new Promise((resolve) => setTimeout(resolve, 20));
        text = stripAnsi(h.instance.render(110).join('\n'));
        assert.match(text, /shell-output/);
        assert.doesNotMatch(text, /Description:|Command:|Started:|Output:/);
        h.instance.handleInput('i');
        text = stripAnsi(h.instance.render(110).join('\n'));
        assert.match(text, /Name: Shell Task/);
        assert.match(text, /Status: running/);
        assert.match(text, /pid 12345/);
        assert.match(text, /Description: Plain shell execution/);
        assert.match(text, /Command: printf component-ok/);
        assert.match(text, /Started:/);
        assert.match(text, /Output:/);
        assert.doesNotMatch(text, /Model:|Context:|Tokens:|Tools:|not reported by/);
      } finally {
        h.instance.dispose();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  void it('fits narrow widths and Unicode names/output in list and detail', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-bg-unicode-ui-'));
    try {
      const outputAbsPath = join(dir, 'task.output');
      await writeFile(outputAbsPath, '输出 Ω 😀 e\u0301 '.repeat(20) + '\n', 'utf8');
      const h = manager({}, [task({
        name: '后台任务 Ω 😀 e\u0301 '.repeat(12),
        description: 'Unicode 描述 '.repeat(30),
        command: 'printf 你好 '.repeat(30),
        outputAbsPath,
      })]);
      try {
        const widths = [0, 1, 2, 3, 8, 24, 50, 64, 90, 120, 300];
        for (const width of widths) assertWidth(h.instance.render(width), width);
        h.instance.handleInput('\r');
        await new Promise((resolve) => setTimeout(resolve, 20));
        for (const width of widths) assertWidth(h.instance.render(width), width);
        assert.match(stripAnsi(h.instance.render(120).join('\n')), /输出 Ω 😀/);
      } finally {
        h.instance.dispose();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  void it('does not request late renders from an output read after disposal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-bg-dispose-ui-'));
    try {
      const outputAbsPath = join(dir, 'task.output');
      await writeFile(outputAbsPath, 'late-output\n', 'utf8');
      const h = manager({ initialTaskId: 'b12345678' }, [task({ outputAbsPath })]);
      h.instance.dispose();
      h.instance.dispose();
      const renders = h.renders;
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(h.renders, renders);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  void it('opens detail, reads bounded tail, refreshes, acts, and returns to list', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-bg-component-'));
    try {
      const outputAbsPath = join(dir, 'task.output');
      await writeFile(outputAbsPath, 'line one\ncomponent-tail\n', 'utf8');
      const tasks = [task({ outputAbsPath, bytesWritten: 24 })];
      const h = manager({ initialTaskId: 'b12345678' }, tasks);
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        let text = stripAnsi(h.instance.render(100).join('\n'));
        assert.match(text, /bg: Component Task/);
        assert.match(text, /component-tail/);
        assert.ok(h.seen.has('b12345678'));

        h.instance.handleInput('r');
        h.instance.handleInput('c');
        h.instance.handleInput('k');
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.deepEqual(h.paths, ['.pi/tasks/test/b12345678.output']);
        assert.deepEqual(h.stopped, ['b12345678']);
        h.instance.handleInput('R');
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.ok(tasks.some((candidate) => candidate.id.startsWith('babcdef')));

        h.instance.handleInput('\x1b[D');
        text = stripAnsi(h.instance.render(100).join('\n'));
        assert.match(text, /bg tasks focused/);
      } finally {
        h.instance.dispose();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  void it('scrolls the detail output tail with arrows/pages and resumes follow at the bottom', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-bg-scroll-'));
    try {
      const outputAbsPath = join(dir, 'task.output');
      const fileLines = Array.from(
        { length: 40 },
        (_, i) => `LINE-${String(i + 1).padStart(3, '0')}`,
      );
      await writeFile(outputAbsPath, `${fileLines.join('\n')}\n`, 'utf8');
      const h = manager({ initialTaskId: 'b12345678' }, [
        task({ outputAbsPath, bytesWritten: 400 }),
      ]);
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        let text = stripAnsi(h.instance.render(100).join('\n'));
        const initialVisible = outputNumbers(text);
        assert.ok(initialVisible.length > 12, 'a 40-row terminal uses more than 12 log rows');
        assert.match(text, /following tail/);
        assert.match(text, /LINE-040/);
        assert.doesNotMatch(text, /LINE-001/);

        // Compute the expected range from the actual responsive viewport.
        for (let i = 0; i < 5; i++) h.instance.handleInput(keys.up);
        text = stripAnsi(h.instance.render(100).join('\n'));
        assert.deepEqual(outputNumbers(text), initialVisible.map((line) => line - 5));
        assert.doesNotMatch(text, /following tail/);
        assert.doesNotMatch(text, /LINE-040/);

        // PageUp reaches the top of the buffer.
        h.instance.handleInput(keys.pageUp);
        text = stripAnsi(h.instance.render(100).join('\n'));
        assert.equal(outputNumbers(text)[0], 1);
        assert.match(text, /LINE-001/);

        // Paging back past the end resumes the live tail.
        h.instance.handleInput('\x1b[6~');
        h.instance.handleInput('\x1b[6~');
        h.instance.handleInput('\x1b[6~');
        await new Promise((resolve) => setTimeout(resolve, 20));
        text = stripAnsi(h.instance.render(100).join('\n'));
        assert.match(text, /following tail/);
        assert.match(text, /LINE-040/);
      } finally {
        h.instance.dispose();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  void it('does not enter scroll mode when the output fits the detail window', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-bg-noscroll-'));
    try {
      const outputAbsPath = join(dir, 'task.output');
      await writeFile(outputAbsPath, 'only-line-a\nonly-line-b\nonly-line-c\n', 'utf8');
      const h = manager({ initialTaskId: 'b12345678' }, [
        task({ outputAbsPath, bytesWritten: 33 }),
      ]);
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        h.instance.handleInput('\x1b[A');
        h.instance.handleInput('\x1b[A');
        const text = stripAnsi(h.instance.render(100).join('\n'));
        assert.match(text, /only-line-c/);
        assert.match(text, /following tail/);
        assert.doesNotMatch(text, /lines \d+\u2013\d+ of/);
      } finally {
        h.instance.dispose();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  void it('requires confirmation before stopping all running tasks and reports no-op clearly', async () => {
    const tasks = [task({ id: 'b11111111' }), task({ id: 'b22222222' })];
    const h = manager({}, tasks);
    try {
      h.instance.handleInput('a');
      assert.deepEqual(h.stopped, []);
      assert.match(stripAnsi(h.instance.render(100).join('\n')), /Press a\/K again/);
      h.instance.handleInput('a');
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(h.stopped.sort(), ['b11111111', 'b22222222']);
      h.instance.handleInput('a');
      assert.match(stripAnsi(h.instance.render(100).join('\n')), /No running background tasks/);
    } finally {
      h.instance.dispose();
    }
  });

  void it('shows empty and history states, unread badges, and does not auto-clear finished notices on close', () => {
    const h = manager({}, []);
    try {
      const text = stripAnsi(h.instance.render(72).join('\n'));
      assert.match(text, /No background tasks/);
      h.instance.handleInput('h');
      assert.match(stripAnsi(h.instance.render(72).join('\n')), /No background tasks/);
    } finally {
      h.instance.dispose();
    }

    const finished = [
      task({
        id: 'bfailed01',
        name: 'Failed Task',
        status: 'failed',
        error: 'boom',
        endTime: Date.now(),
        exitCode: 1,
      }),
    ];
    const hf = manager({}, finished);
    try {
      const text = stripAnsi(hf.instance.render(80).join('\n'));
      assert.match(text, /1 failed/);
      assert.match(text, /1 unread/);
      assert.match(text, /●/);
      hf.instance.handleInput('x');
      assert.equal(hf.seen.has('bfailed01'), false);
    } finally {
      hf.instance.dispose();
    }
  });

  void it('handles non-running stop, output read failures, paging, long text, and close aliases', async () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      task({
        id: `b${String(i).padStart(8, '0')}`,
        name: `Very Long Component Task Name ${String(i)} ${'x'.repeat(80)}`,
        command: `printf ${String(i)}`,
        startTime: Date.now() - i * 1000,
      }),
    );
    const firstTask = many[0];
    assert.ok(firstTask);
    firstTask.status = 'completed';
    firstTask.endTime = Date.now();
    const h = manager({}, many);
    try {
      h.instance.handleInput('\x1b[6~');
      h.instance.handleInput('\x1b[5~');
      const lines = h.instance.render(50);
      assertWidth(lines, 50);
      h.instance.handleInput('h');
      h.instance.handleInput('\x1b[5~');
      assertWidth(h.instance.render(64), 64);
      h.instance.handleInput('\r');
      await new Promise((resolve) => setTimeout(resolve, 20));
      let text = stripAnsi(h.instance.render(80).join('\n'));
      assert.match(text, /Output file not found|No output yet|bg:/);
      h.instance.handleInput('\x1b[D');
      h.instance.handleInput('h');
      h.instance.handleInput('k');
      await new Promise((resolve) => setTimeout(resolve, 0));
      text = stripAnsi(h.instance.render(90).join('\n'));
      assert.match(text, /nothing to stop|Stopped/);
      h.instance.handleInput('q');
      assert.equal(h.closed, true);
    } finally {
      h.instance.dispose();
    }

    const esc = manager({}, [task()]);
    try {
      esc.instance.handleInput('\x1b');
      assert.equal(esc.closed, true);
    } finally {
      esc.instance.dispose();
    }
  });
});

void describe('BackgroundTasksManager responsive log panel regressions', () => {
  for (const mode of ['regular', 'fullscreen'] as const) {
    void it(`composites centered frames without host clipping in ${mode} mode across resizes`, async () => {
      await withOutputTasks(['ENGINE-LOG-END\n'], async (tasks) => {
        const terminal = new MemoryTerminal();
        const ui = mode === 'regular' ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
        const h = manager({ initialTaskId: tasks[0]!.id }, tasks, terminal);
        ui.addChild({ render: () => ['Underlying transcript'], invalidate: () => undefined });
        ui.start();
        const handle = ui.showOverlay(h.instance, TASK_MANAGER_OVERLAY_OPTIONS);
        try {
          await waitForOutput(h.instance, 108, 'ENGINE-LOG-END');
          for (const [columns, rows] of [[300, 40], [80, 24], [120, 12], [120, 5], [240, 60]]) {
            assert.ok(columns !== undefined && rows !== undefined);
            terminal.columns = columns;
            terminal.rows = rows;
            terminal.writes = [];
            ui.renderNow(true);
            const bounds = handle.getBounds();
            assert.ok(bounds);
            const width = Math.max(1, Math.min(Math.max(Math.floor(columns * 0.9), 40), columns - 2));
            assert.equal(bounds.width, width);
            assert.equal(bounds.height, panelHeight(rows));
            assert.equal(bounds.col, 1 + Math.floor((columns - 2 - width) / 2));
            assert.equal(bounds.row, 1 + Math.floor((rows - 2 - bounds.height) / 2));
            const output = stripAnsi(terminal.writes.join(''));
            assert.match(output, /ENGINE-LOG-END/);
            assert.match(output, /╰─+╯/u);
            if (bounds.height >= 4) assert.match(output, /x close/);
          }
        } finally {
          handle.hide();
          ui.stop({ preserveScreen: true });
          h.instance.dispose();
        }
      });
    });
  }

  void it('exports centered responsive overlay bounds', () => {
    assert.equal(TASK_MANAGER_OVERLAY_OPTIONS.anchor, 'center');
    assert.equal(TASK_MANAGER_OVERLAY_OPTIONS.width, '90%');
    assert.equal(TASK_MANAGER_OVERLAY_OPTIONS.minWidth, 40);
    assert.equal(TASK_MANAGER_OVERLAY_OPTIONS.maxHeight, '80%');
    assert.equal(TASK_MANAGER_OVERLAY_OPTIONS.margin, 1);
  });

  void it('uses the supplied 240- and 300-column widths instead of a 118-column cap', async () => {
    await withOutputTasks(['wide-log\n'], async (tasks) => {
      const h = manager({}, tasks);
      try {
        for (const width of [240, 300]) {
          await waitForOutput(h.instance, width, 'wide-log');
          const lines = h.instance.render(width);
          assertWidth(lines, width);
          assert.equal(Math.max(...lines.map((line) => visibleWidth(stripAnsi(line)))), width);
          assert.equal(visibleWidth(stripAnsi(lines[0] ?? '')), width);
          assert.ok(lines.length <= panelHeight(h.terminal.rows));
        }
      } finally {
        h.instance.dispose();
      }
    });
  });

  void it('fits the terminal height and supplied width in list, logs and task-info views', async () => {
    await withOutputTasks([numberedOutput(80, ' 输出 😀 e\u0301 ' + 'x'.repeat(140))], async (tasks) => {
      const h = manager({}, tasks);
      try {
        for (const view of ['list', 'logs', 'info']) {
          h.terminal.rows = 40;
          h.instance.render(90);
          if (view === 'logs') {
            h.instance.handleInput('\r');
            await waitForOutput(h.instance, 90, 'LINE-080');
          } else if (view === 'info') {
            h.instance.handleInput('i');
          }
          for (const rows of [1, 2, 5, 12, 24, 40, 60]) {
            h.terminal.rows = rows;
            for (const width of [0, 1, 2, 3, 8, 24, 50, 64, 90, 120, 300]) {
              const lines = h.instance.render(width);
              assertWidth(lines, width);
              assert.ok(
                lines.length <= panelHeight(rows),
                `${view}: ${width} columns, ${rows} terminal rows produced ${lines.length} rows`,
              );
            }
          }
        }
      } finally {
        h.instance.dispose();
      }
    });
  });

  void it('retains the bottom border and close controls when there is room', async () => {
    await withOutputTasks([numberedOutput(80)], async (tasks) => {
      const h = manager({ initialTaskId: tasks[0]!.id }, tasks);
      try {
        await waitForOutput(h.instance, 90, 'LINE-080');
        for (const view of ['logs', 'info', 'list']) {
          if (view === 'info') h.instance.handleInput('i');
          if (view === 'list') h.instance.handleInput(keys.left);
          for (const rows of [24, 40, 60]) {
            h.terminal.rows = rows;
            for (const width of [90, 120, 300]) {
              const lines = h.instance.render(width).map(stripAnsi);
              assert.match(lines.at(-1) ?? '', /^╰─+╯$/u);
              assert.match(lines.slice(-4, -1).join('\n'), /close/iu);
              assert.ok(lines.length <= panelHeight(rows));
              assertWidth(lines, width);
            }
          }
        }
      } finally {
        h.instance.dispose();
      }
    });
  });

  void it('reaches a long JSON suffix by wrapped vertical scrolling and by horizontal pan', async () => {
    const json = JSON.stringify({ prefix: 'JSON-START', payload: 'x'.repeat(4000), suffix: 'JSON-END' });
    await withOutputTasks([`${json}\n`], async (tasks) => {
      const h = manager({ initialTaskId: tasks[0]!.id }, tasks);
      try {
        await waitForOutput(h.instance, 90, 'JSON-END');
        h.instance.handleInput('g');
        assert.match(renderText(h.instance, 90), /JSON-START/);
        assert.doesNotMatch(renderText(h.instance, 90), /JSON-END/);
        h.instance.handleInput(keys.pageDown);
        assert.doesNotMatch(renderText(h.instance, 90), /JSON-START/);
        h.instance.handleInput('G');
        assert.match(renderText(h.instance, 90), /JSON-END/);
        assert.match(renderText(h.instance, 90), /following tail/);

        h.instance.handleInput('w');
        h.instance.handleInput('0');
        assert.match(renderText(h.instance, 90), /JSON-START/);
        assert.doesNotMatch(renderText(h.instance, 90), /JSON-END/);
        for (let i = 0; i < 20; i++) h.instance.handleInput(keys.shiftRight);
        assert.doesNotMatch(renderText(h.instance, 90), /JSON-START/);
        for (let i = 0; i < 20; i++) h.instance.handleInput(keys.shiftLeft);
        assert.match(renderText(h.instance, 90), /JSON-START/);
        h.instance.handleInput('$');
        assert.match(renderText(h.instance, 90), /JSON-END/);
        h.instance.handleInput('0');
        assert.match(renderText(h.instance, 90), /JSON-START/);
        assertWidth(h.instance.render(90), 90);
        assert.equal(await readFile(tasks[0]!.outputAbsPath, 'utf8'), `${json}\n`);
      } finally {
        h.instance.dispose();
      }
    });
  });

  void it('preserves the paused source-line anchor across narrow/wide and height resizes and wrap toggles', async () => {
    await withOutputTasks([numberedOutput(100, ' ' + 'x'.repeat(160))], async (tasks) => {
      const h = manager({ initialTaskId: tasks[0]!.id }, tasks);
      try {
        await waitForOutput(h.instance, 240, 'LINE-100');
        h.instance.handleInput('g');
        for (let i = 0; i < 15; i++) h.instance.handleInput(keys.down);
        const anchor = outputNumbers(renderText(h.instance, 240))[0];
        assert.equal(anchor, 16);
        for (const [width, rows] of [[90, 40], [240, 12], [64, 24], [300, 60], [120, 40]]) {
          assert.ok(width !== undefined && rows !== undefined);
          h.terminal.rows = rows;
          const text = renderText(h.instance, width);
          assert.equal(outputNumbers(text)[0], anchor, `${width} columns, ${rows} rows`);
          assert.doesNotMatch(text, /following tail/);
          assertWidth(h.instance.render(width), width);
          assert.ok(h.instance.render(width).length <= panelHeight(rows));
        }
        h.instance.handleInput('w');
        assert.equal(outputNumbers(renderText(h.instance, 120))[0], anchor);
        h.instance.handleInput('w');
        assert.equal(outputNumbers(renderText(h.instance, 120))[0], anchor);
        assert.doesNotMatch(renderText(h.instance, 120), /following tail/);
      } finally {
        h.instance.dispose();
      }
    });
  });

  void it('freezes a paused buffer on append until G explicitly resumes the live tail', async () => {
    await withOutputTasks([numberedOutput(100)], async (tasks) => {
      const selected = tasks[0]!;
      const h = manager({ initialTaskId: selected.id }, tasks);
      try {
        await waitForOutput(h.instance, 90, 'LINE-100');
        h.instance.handleInput('g');
        const paused = outputNumbers(renderText(h.instance, 90));
        assert.equal(paused[0], 1);
        const appended = 'LINE-101\nLINE-102\n';
        await appendFile(selected.outputAbsPath, appended, 'utf8');
        selected.bytesWritten += Buffer.byteLength(appended);
        // Exercise at least one real one-second status refresh while paused.
        await new Promise((resolve) => setTimeout(resolve, 1100));
        const text = renderText(h.instance, 90);
        assert.deepEqual(outputNumbers(text), paused);
        assert.doesNotMatch(text, /LINE-101|LINE-102|following tail/);
        h.instance.handleInput('G');
        const following = await waitForOutput(h.instance, 90, 'LINE-102');
        assert.match(following, /following tail/);
      } finally {
        h.instance.dispose();
      }
    });
  });

  void it('shows the selected preview at the wide-layout threshold without acknowledging notices', async () => {
    await withOutputTasks(['FIRST-PREVIEW\n', 'SECOND-PREVIEW\n', 'THIRD-PREVIEW\n'], async (tasks) => {
      for (const [index, selected] of tasks.entries()) {
        selected.status = 'completed';
        selected.endTime = Date.now() - index * 1000;
      }
      const h = manager({}, tasks);
      try {
        // The panel has two border columns: 105 => inner 103, 106 => inner 104.
        assert.doesNotMatch(renderText(h.instance, 105), /FIRST-PREVIEW/);
        let text = await waitForOutput(h.instance, 106, 'FIRST-PREVIEW');
        assert.match(text, /Fixture Task 0/);
        assert.match(text, /Fixture Task 1/);
        assert.equal(h.seen.size, 0);
        h.instance.handleInput(keys.down);
        text = await waitForOutput(h.instance, 106, 'SECOND-PREVIEW');
        assert.doesNotMatch(text, /FIRST-PREVIEW/);
        assert.equal(h.seen.size, 0);

        h.instance.handleInput('\r');
        await waitForOutput(h.instance, 106, 'SECOND-PREVIEW');
        assert.deepEqual([...h.seen], [tasks[1]!.id]);
        h.instance.handleInput('i');
        assert.match(renderText(h.instance, 106), /Command:/);
        assert.equal(h.seen.has(tasks[1]!.id), true);
        h.instance.handleInput(keys.left);
        h.instance.handleInput(keys.up);
        await waitForOutput(h.instance, 106, 'FIRST-PREVIEW');
        assert.equal(h.seen.has(tasks[0]!.id), false);
        h.instance.handleInput('\t');
        assert.equal(h.seen.has(tasks[0]!.id), true, 'explicit log focus acknowledges the preview');
        h.instance.handleInput(keys.left);
        h.instance.handleInput(keys.down);
        h.instance.handleInput(keys.down);
        await waitForOutput(h.instance, 106, 'THIRD-PREVIEW');
        assert.equal(h.seen.has(tasks[2]!.id), false);
        h.instance.handleInput('i');
        assert.match(renderText(h.instance, 106), /Command:/);
        assert.equal(h.seen.has(tasks[2]!.id), true, 'explicit task-info view acknowledges the preview');
      } finally {
        h.instance.dispose();
      }
    });
  });

  void it('uses Tab to switch between selecting tasks and scrolling the selected logs', async () => {
    await withOutputTasks([numberedOutput(80), 'SECOND-TASK-OUTPUT\n'], async (tasks) => {
      const h = manager({}, tasks);
      try {
        await waitForOutput(h.instance, 140, 'LINE-080');
        const following = outputNumbers(renderText(h.instance, 140));
        h.instance.handleInput('\t');
        h.instance.handleInput(keys.up);
        const paused = outputNumbers(renderText(h.instance, 140));
        assert.deepEqual(paused, following.map((line) => line - 1));
        h.instance.handleInput('c');
        assert.equal(h.paths.at(-1), tasks[0]!.outputPath);
        h.instance.handleInput('\t');
        h.instance.handleInput(keys.down);
        await waitForOutput(h.instance, 140, 'SECOND-TASK-OUTPUT');
        h.instance.handleInput('c');
        assert.equal(h.paths.at(-1), tasks[1]!.outputPath);
        h.instance.handleInput('\t');
        h.instance.handleInput(keys.left);
        assert.match(renderText(h.instance, 140), /bg tasks focused/);
      } finally {
        h.instance.dispose();
      }
    });
  });

  void it('does not display the previous task when its asynchronous read finishes after switching', { timeout: 5000 }, async (t) => {
    await withOutputTasks(['STALE-FIRST-TASK\n', 'CURRENT-SECOND-TASK\n'], async (tasks) => {
      const originalOpen = fsPromises.open;
      let release!: () => void;
      let opened!: () => void;
      let finished!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const firstOpened = new Promise<void>((resolve) => { opened = resolve; });
      const firstFinished = new Promise<void>((resolve) => { finished = resolve; });
      // Only delay open's resolution. Both reads still use real temporary files.
      t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof fsPromises.open>) => {
        const file = await originalOpen(...args);
        if (args[0] === tasks[0]!.outputAbsPath) {
          const originalClose = file.close.bind(file);
          t.mock.method(file, 'close', async () => {
            await originalClose();
            finished();
          });
          opened();
          await gate;
        }
        return file;
      });
      syncBuiltinESMExports();
      const h = manager({ initialTaskId: tasks[0]!.id }, tasks);
      try {
        await firstOpened;
        h.instance.handleInput(keys.left);
        h.instance.render(90);
        h.instance.handleInput(keys.down);
        h.instance.handleInput('\r');
        await waitForOutput(h.instance, 90, 'CURRENT-SECOND-TASK');
        release();
        await firstFinished;
        await new Promise((resolve) => setTimeout(resolve, 0));
        const text = renderText(h.instance, 90);
        assert.match(text, /CURRENT-SECOND-TASK/);
        assert.doesNotMatch(text, /STALE-FIRST-TASK/);
      } finally {
        release();
        h.instance.dispose();
        await firstFinished;
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
    });
  });

  void it('scrolls task info to the end of a long command and output path', async () => {
    await withOutputTasks(['ordinary-log\n'], async (tasks) => {
      const selected = tasks[0]!;
      selected.description = 'An intentionally verbose description '.repeat(30);
      selected.command = 'printf ' + 'command-fragment '.repeat(100) + 'COMMAND-END';
      selected.outputPath = '.pi/tasks/' + 'path-segment/'.repeat(100) + 'PATH-END.output';
      const h = manager({ initialTaskId: selected.id }, tasks, { rows: 24 });
      try {
        await waitForOutput(h.instance, 90, 'ordinary-log');
        assert.doesNotMatch(renderText(h.instance, 90), /Description:|Command:|Started:|Output:/);
        h.instance.handleInput('i');
        h.instance.handleInput('g');
        let allInfo = '';
        for (let page = 0; page < 100; page++) {
          const lines = h.instance.render(90);
          assertWidth(lines, 90);
          assert.ok(lines.length <= panelHeight(h.terminal.rows));
          allInfo += '\n' + stripAnsi(lines.join('\n'));
          h.instance.handleInput(keys.pageDown);
        }
        assert.match(allInfo, /Description:/);
        assert.match(allInfo, /Command:/);
        assert.match(allInfo, /COMMAND-END/);
        assert.match(allInfo, /Started:/);
        assert.match(allInfo, /Output:/);
        assert.match(allInfo, /PATH-END\.output/);
        h.instance.handleInput('g');
        assert.match(renderText(h.instance, 90), /Name:/);
        h.instance.handleInput('i');
        assert.match(renderText(h.instance, 90), /ordinary-log/);
      } finally {
        h.instance.dispose();
      }
    });
  });

  void it('toggles a wide log-only layout without losing the selected log', async () => {
    await withOutputTasks(['SELECTED-LOG\n', 'OTHER-LOG\n'], async (tasks) => {
      const h = manager({ initialTaskId: tasks[0]!.id }, tasks);
      try {
        let text = await waitForOutput(h.instance, 150, 'SELECTED-LOG');
        assert.match(text, /Fixture Task 1/);
        h.instance.handleInput('f');
        text = renderText(h.instance, 150);
        assert.match(text, /SELECTED-LOG/);
        assert.doesNotMatch(text, /Fixture Task 1|OTHER-LOG/);
        h.instance.handleInput('f');
        text = renderText(h.instance, 150);
        assert.match(text, /Fixture Task 1/);
        assert.match(text, /SELECTED-LOG/);
        assertWidth(h.instance.render(150), 150);
      } finally {
        h.instance.dispose();
      }
    });
  });

  void it('keeps A and K as confirmed stop-all aliases rather than immediate actions', async () => {
    for (const alias of ['A', 'K']) {
      const h = manager({}, [task({ id: 'bfirst000' }), task({ id: 'bsecond00' })]);
      try {
        h.instance.handleInput(alias);
        assert.deepEqual(h.stopped, []);
        assert.match(renderText(h.instance, 90), /again/);
        h.instance.handleInput(alias);
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.deepEqual(h.stopped.sort(), ['bfirst000', 'bsecond00']);
      } finally {
        h.instance.dispose();
      }
    }
  });

  void it('couples the sidebar, logs and action target when rerunning from log focus', async () => {
    await withOutputTasks(['ORIGINAL-RUN-OUTPUT\n', 'NEW-RUN-OUTPUT\n'], async (tasks) => {
      const original = tasks[0]!;
      const rerun = task({
        id: 'brerunnew',
        name: 'Rerun Selected',
        outputPath: '.pi/tasks/test/brerunnew.output',
        outputAbsPath: tasks[1]!.outputAbsPath,
      });
      const h = manager({
        initialTaskId: original.id,
        rerunTask: () => {
          tasks.unshift(rerun);
          return Promise.resolve(rerun);
        },
      }, tasks);
      try {
        await waitForOutput(h.instance, 150, 'ORIGINAL-RUN-OUTPUT');
        h.instance.handleInput('R');
        const text = await waitForOutput(h.instance, 150, 'NEW-RUN-OUTPUT');
        assert.match(text, /bg: Rerun Selected/);
        assert.match(text, /›.*Rerun Selected/);
        assert.doesNotMatch(text, /ORIGINAL-RUN-OUTPUT/);
        h.instance.handleInput('c');
        assert.equal(h.paths.at(-1), rerun.outputPath);
        h.instance.handleInput('k');
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.deepEqual(h.stopped, [rerun.id]);
        assert.equal(original.status, 'running');
      } finally { h.instance.dispose(); }
    });
  });

  void it('keeps a finished viewed task selected while another task remains running', async () => {
    await withOutputTasks(['VIEWED-TASK-OUTPUT\n', 'OTHER-TASK-OUTPUT\n'], async (tasks) => {
      const selected = tasks[0]!;
      const h = manager({ initialTaskId: selected.id }, tasks);
      try {
        await waitForOutput(h.instance, 150, 'VIEWED-TASK-OUTPUT');
        selected.status = 'completed';
        selected.endTime = Date.now();
        const text = renderText(h.instance, 150);
        assert.match(text, /›.*Fixture Task 0/);
        assert.match(text, /VIEWED-TASK-OUTPUT/);
        assert.doesNotMatch(text, /OTHER-TASK-OUTPUT/);
        h.instance.handleInput('c');
        assert.equal(h.paths.at(-1), selected.outputPath);
        h.instance.handleInput('k');
        assert.deepEqual(h.stopped, []);
        assert.match(renderText(h.instance, 150), /nothing to stop/);
      } finally { h.instance.dispose(); }
    });
  });
});
