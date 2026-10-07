import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Theme,
  type ExtensionAPI,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import backgroundTasksExtension from '../../src/extension.js';

async function registeredStatusTool(): Promise<ToolDefinition> {
  let status: ToolDefinition | undefined;
  const api: Pick<
    ExtensionAPI,
    'registerTool' | 'registerCommand' | 'registerShortcut' | 'registerMessageRenderer' | 'on' | 'events'
  > = {
    registerTool(tool) {
      if (tool.name === 'bg_status') status = tool as ToolDefinition;
    },
    registerCommand() {},
    registerShortcut() {},
    registerMessageRenderer() {},
    on: () => () => {},
    events: { on: () => () => {}, emit() {} },
  };
  // Registration alone starts no session, timer, shell task or file IO.
  await backgroundTasksExtension(api as ExtensionAPI);
  assert.ok(status);
  return status;
}

const theme = new Theme(
  {
    dim: '#777777',
    error: '#ff5555',
    success: '#55ff55',
    muted: '#aaaaaa',
    text: '#ffffff',
    thinkingXhigh: '#ffffff',
  } as ConstructorParameters<typeof Theme>[0],
  { selectedBg: '#000000' } as ConstructorParameters<typeof Theme>[1],
  'truecolor',
);

test('registered bg_status renders host lookup errors and successful task lists as width-safe cards', async () => {
  const tool = await registeredStatusTool();
  assert.ok(tool.renderResult);
  const context = {
    args: {},
    toolCallId: 'status-render-test',
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: true,
  } satisfies Parameters<NonNullable<ToolDefinition['renderResult']>>[3];
  const cases = [
    {
      text: 'Unknown background task ID: bmissing',
      details: {},
      isError: true,
      status: 'Unknown background task ID: bmissing',
    },
    {
      text: 'Ambiguous task ID prefix "b": b11111111, b22222222',
      details: {},
      isError: true,
      status: 'Ambiguous task ID prefix "b": b11111111, b22222222',
    },
    {
      text: 'Unknown background task ID: b\u0007\u001b]0;injected\u0007missing',
      details: {},
      isError: true,
      status: 'Unknown background task ID: bmissing',
    },
    { text: 'No background tasks.', details: { tasks: [] }, isError: false, status: '0 tasks' },
    {
      text: 'b11111111 running',
      details: { tasks: [{ id: 'b11111111', status: 'running' }] },
      isError: false,
      status: '1 task',
    },
    {
      text: 'b11111111 running\nb22222222 completed',
      details: { tasks: [{ id: 'b11111111', status: 'running' }, { id: 'b22222222', status: 'completed' }] },
      isError: false,
      status: '2 tasks',
    },
  ];
  for (const item of cases) {
    // Pi 1.0.4 reports thrown tool errors as text content with details: {}.
    // isError is in the fourth renderer argument, not the result or options.
    const card = tool.renderResult(
      { content: [{ type: 'text', text: item.text }], details: item.details },
      { expanded: false, isPartial: false },
      theme,
      { ...context, isError: item.isError },
    );
    for (const width of [1, 8, 40, 120]) {
      const lines = card.render(width);
      assert.ok(lines.length > 0);
      for (const line of lines) {
        assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`);
        assert.ok(!line.includes('\u0007'), 'no bell reaches the terminal');
        assert.ok(!line.includes('\u001b]'), 'no OSC reaches the terminal');
      }
      if (width === 120) {
        const plain = lines.map((line) => stripTerminalSequences(line).trimEnd());
        assert.equal(plain[0], `  ⎿ ${item.status}`);
        assert.ok(lines[0]?.includes(theme.fg(item.isError ? 'error' : 'success', item.status)));
        if (!item.isError) assert.deepEqual(plain.slice(1), item.text.split('\n'));
      }
    }
  }
});
