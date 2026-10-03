import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import { TaskLogViewport } from '../../src/ui/task-log-viewport.js';

function viewport(width: number, height: number, lines: readonly string[]): TaskLogViewport {
  const instance = new TaskLogViewport();
  instance.resize(width, height);
  instance.setLines(lines);
  return instance;
}

function assertFits(instance: TaskLogViewport): void {
  const rows = instance.render();
  assert.ok(rows.length <= instance.height);
  for (const row of rows) {
    assert.ok(visibleWidth(row) <= instance.width, JSON.stringify(row));
    assert.doesNotMatch(row, /[\x00-\x1f\x7f]/u);
  }
}

void describe('TaskLogViewport', () => {
  void it('defaults to soft wrap and live tail, with plain unpadded rows', () => {
    const v = viewport(12, 6, ['abc', '', 'tail']);
    assert.equal(v.wrap, true);
    assert.equal(v.follow, true);
    assert.equal(v.width, 12);
    assert.equal(v.height, 6);
    assert.equal(v.lineCount, 3);
    assert.equal(v.rowCount, 3);
    assert.deepEqual(v.render(), ['abc', '', 'tail']);
    assertFits(v);
  });

  void it('keeps every character of a long JSON line reachable through vertical wrapping', () => {
    const json = JSON.stringify({ payload: '0123456789'.repeat(40), suffix: 'JSON-END-MARKER' });
    const v = viewport(17, 1, [json]);
    assert.equal(v.rowCount, Math.ceil(json.length / 17));
    v.scrollToStart();
    assert.equal(v.follow, false);
    const chunks: string[] = [];
    for (let row = 0; row < v.rowCount; row++) {
      assertFits(v);
      chunks.push(v.render().join(''));
      v.scrollBy(1);
    }
    assert.equal(chunks.join(''), json);
    assert.match(chunks.join(''), /JSON-END-MARKER/);
    assert.doesNotMatch(chunks.join(''), /…/u);
  });

  void it('pans without wrap, clamps at both ends, and exposes the complete suffix', () => {
    const line = `HEAD-${'x'.repeat(100)}-JSON-END`;
    const v = viewport(12, 2, [line, 'short']);
    v.toggleWrap();
    assert.equal(v.wrap, false);
    assert.equal(v.rowCount, 2);
    assert.deepEqual(v.render(), [line.slice(0, 12), 'short']);
    v.panBy(5);
    assert.equal(v.offset, 5);
    assert.equal(v.render()[0], line.slice(5, 17));
    v.panToEnd();
    const atEnd = v.render();
    assert.equal(v.offset, line.length - v.width);
    assert.equal(atEnd[0], line.slice(-12));
    assert.equal(atEnd[1], '');
    v.panBy(10000);
    assert.deepEqual(v.render(), atEnd);
    v.panToStart();
    assert.equal(v.offset, 0);
    assert.equal(v.render()[0], line.slice(0, 12));
    v.panBy(-10000);
    assert.equal(v.render()[0], line.slice(0, 12));
    assertFits(v);
  });

  void it('clamps vertical scrolling and resumes follow only when scrolled to the end', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i}`);
    const v = viewport(20, 4, lines);
    assert.deepEqual(v.render(), lines.slice(-4));
    v.scrollBy(-2);
    assert.equal(v.follow, false);
    assert.deepEqual(v.render(), lines.slice(14, 18));
    v.scrollBy(-10000);
    assert.deepEqual(v.render(), lines.slice(0, 4));
    assert.equal(v.follow, false);
    v.scrollBy(10000);
    assert.deepEqual(v.render(), lines.slice(-4));
    assert.equal(v.follow, true);
    v.scrollToStart();
    v.scrollToEnd();
    assert.equal(v.follow, true);
    assert.deepEqual(v.render(), lines.slice(-4));
  });

  void it('does not pause follow for an upward scroll when all output fits', () => {
    const v = viewport(30, 5, ['one', 'two', 'three']);
    v.scrollBy(-1);
    v.scrollBy(-100);
    assert.equal(v.follow, true);
    assert.deepEqual(v.render(), ['one', 'two', 'three']);
  });

  void it('preserves a paused logical-line anchor through width and height changes', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `LINE-${i}: ${'x'.repeat(45)}`);
    const v = viewport(80, 5, lines);
    v.scrollToStart();
    v.scrollBy(15);
    const anchor = v.firstLine;
    const original = v.render()[0];
    assert.ok(original);
    assert.equal(v.follow, false);
    v.resize(20, 9);
    assert.equal(v.firstLine, anchor);
    assert.equal(v.follow, false);
    assert.match(v.render()[0] ?? '', /LINE-15:/);
    assertFits(v);
    v.resize(120, 3);
    assert.equal(v.firstLine, anchor);
    assert.equal(v.render()[0], original);
    assert.equal(v.follow, false);
  });

  void it('preserves the paused column within a wrapped source line when resized', () => {
    const line = Array.from({ length: 100 }, (_, i) => String(i).padStart(3, '0')).join('');
    const v = viewport(12, 3, [line]);
    v.scrollToStart();
    v.scrollBy(5);
    const anchorLine = v.firstLine;
    const anchorChunk = v.render()[0];
    assert.ok(anchorChunk);
    v.resize(17, 3);
    assert.equal(v.firstLine, anchorLine);
    assert.ok(v.render().join('').includes(anchorChunk), 'resized rows include the paused column');
    assert.equal(v.follow, false);
    assertFits(v);
  });

  void it('preserves a paused wrapped-row column through a wrap off/on round trip', () => {
    const line = Array.from({ length: 100 }, (_, i) => String(i).padStart(3, '0')).join('');
    const v = viewport(12, 3, [line]);
    v.scrollToStart();
    v.scrollBy(5);
    const original = v.render();
    const row = v.firstRow;
    v.toggleWrap();
    assert.equal(v.follow, false);
    v.toggleWrap();
    assert.equal(v.follow, false);
    assert.equal(v.firstRow, row);
    assert.deepEqual(v.render(), original);
  });

  void it('keeps the original source column through repeated non-aligned reflows', () => {
    const v = viewport(5, 2, ['abcdefghijklmnopqrst', 'tail']);
    v.scrollBy(-2);
    const original = v.render();
    assert.equal(original[0], 'fghij');
    for (const width of [7, 9, 6, 5]) v.resize(width, 2);
    assert.deepEqual(v.render(), original);
    assert.equal(v.follow, false);
    v.toggleWrap();
    assert.equal(v.render()[0], 'fghij');
    v.panBy(2);
    v.toggleWrap();
    assert.equal(v.render()[0], 'fghij', 'the wrapped row contains the explicitly panned source column');
  });

  void it('strips all standard CSI finals without consuming following printable text', () => {
    const v = viewport(200, 8, [
      '\x1b[1Aimportant',
      '\x1b[2Bprogress\x1b[?25l_VALUE',
      '\x1b[12;5rscroll-region\x1b[1 qcursor-style',
      '\x9b1AC1-important',
      'partial\x1b[12;',
      '\x1b]0;title\x07visible\x1b_hidden\x1b\\tail',
    ]);
    assert.deepEqual(v.render(), [
      'important',
      'progress_VALUE',
      'scroll-regioncursor-style',
      'C1-important',
      'partial',
      'visibletail',
    ]);
    assertFits(v);
  });

  void it('preserves a paused logical line when wrap is toggled off and back on', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `LINE-${i}: ${'x'.repeat(70)}`);
    const v = viewport(80, 4, lines);
    v.scrollToStart();
    v.scrollBy(10);
    const anchor = v.firstLine;
    const original = v.render();
    v.toggleWrap();
    assert.equal(v.wrap, false);
    assert.equal(v.firstLine, anchor);
    assert.equal(v.follow, false);
    v.resize(20, 4);
    v.toggleWrap();
    assert.equal(v.wrap, true);
    assert.equal(v.firstLine, anchor);
    assert.equal(v.follow, false);
    v.resize(80, 4);
    assert.deepEqual(v.render(), original);
  });

  void it('does not resume follow merely because a taller resize exposes the bottom', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i}`);
    const v = viewport(20, 3, lines);
    v.scrollBy(-2);
    const first = v.firstLine;
    v.resize(20, 8);
    assert.equal(v.follow, false);
    assert.equal(v.firstLine, first);
    assert.equal(v.render().at(-1), 'line-9');
    v.resize(20, 3);
    assert.equal(v.follow, false);
    assert.equal(v.firstLine, first);
    v.scrollToEnd();
    assert.equal(v.follow, true);
    assert.equal(v.render().at(-1), 'line-9');
  });

  void it('allows an explicit downward scroll at a resize-exposed bottom to resume follow', () => {
    const v = viewport(20, 3, Array.from({ length: 10 }, (_, i) => `line-${i}`));
    v.scrollBy(-1);
    v.resize(20, 8);
    assert.equal(v.follow, false);
    v.scrollBy(1);
    assert.equal(v.follow, true);
  });

  void it('updates a following tail without moving a paused source-line anchor on setLines', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line-${i}`);
    const v = viewport(20, 4, lines);
    v.setLines([...lines, 'new-tail']);
    assert.equal(v.render().at(-1), 'new-tail');
    v.scrollBy(-5);
    const first = v.firstLine;
    const paused = v.render();
    v.setLines([...lines, 'new-tail', 'even-newer-tail']);
    assert.equal(v.follow, false);
    assert.equal(v.firstLine, first);
    assert.deepEqual(v.render(), paused);
    v.scrollToEnd();
    assert.equal(v.render().at(-1), 'even-newer-tail');
  });

  void it('sanitizes ANSI, OSC and control text and normalizes tabs without mutating input', () => {
    const lines = Object.freeze([
      'before\x1b[31mred\x1b[0m\x1b]0;hidden-title\x07 after\x00\x07\tend',
      'plain',
    ]);
    const original = [...lines];
    const v = viewport(100, 5, lines);
    const text = v.render().join('\n');
    assert.match(text, /beforered after +end/);
    assert.doesNotMatch(text, /hidden-title|\x1b|\x00|\x07|\t/u);
    assert.deepEqual(lines, original);
    assertFits(v);
  });

  void it('keeps Unicode graphemes and their display-cell widths intact in both modes', () => {
    const line = '输出Ω😀e\u0301👩‍💻'.repeat(20);
    const v = viewport(12, 1, [line]);
    v.scrollToStart();
    const chunks: string[] = [];
    for (let row = 0; row < v.rowCount; row++) {
      assertFits(v);
      const chunk = v.render().join('');
      assert.doesNotMatch(chunk, /^[\u0300-\u036f\u200d\udc00-\udfff]/u);
      assert.doesNotMatch(chunk, /\u200d$/u);
      chunks.push(chunk);
      v.scrollBy(1);
    }
    assert.equal(chunks.join(''), line);
    v.toggleWrap();
    for (let i = 0; i < 30; i++) {
      v.panBy(1);
      assertFits(v);
      const panned = v.render().join('');
      assert.doesNotMatch(panned, /\ufffd/u);
      assert.doesNotMatch(panned, /^[\u0300-\u036f\u200d\udc00-\udfff]/u);
      assert.doesNotMatch(panned, /\u200d$/u);
    }
    v.panToEnd();
    assertFits(v);
  });

  void it('fits tiny and wide dimensions during wrap, pan and scrolling', () => {
    const v = viewport(30, 5, ['输出 😀 e\u0301 '.repeat(60), 'x'.repeat(500), 'last']);
    for (const height of [1, 2, 5, 12, 24, 40, 60]) {
      for (const width of [1, 2, 3, 8, 24, 50, 64, 90, 120, 300]) {
        v.resize(width, height);
        assertFits(v);
        v.scrollToStart();
        assertFits(v);
        v.scrollToEnd();
        v.toggleWrap();
        v.panToEnd();
        assertFits(v);
        v.panToStart();
        v.toggleWrap();
      }
    }
  });

  void it('reclamps horizontal pan when the viewport grows past the longest source line', () => {
    const line = 'HEAD-' + 'x'.repeat(50) + '-TAIL';
    const v = viewport(10, 3, [line]);
    v.toggleWrap();
    v.panToEnd();
    assert.equal(v.offset, line.length - 10);
    v.resize(20, 3);
    assert.equal(v.offset, line.length - 20);
    assert.equal(v.render()[0], line.slice(-20));
    v.resize(100, 3);
    assert.equal(v.offset, 0);
    assert.deepEqual(v.render(), [line]);
  });

  void it('reports source-line and rendered-row ranges consistent with the visible output', () => {
    const v = viewport(20, 4, Array.from({ length: 20 }, (_, i) => `line-${i}`));
    assert.equal(v.lastRow - v.firstRow, v.render().length - 1);
    assert.equal(v.lastLine - v.firstLine, v.render().length - 1);
    const firstRow = v.firstRow;
    const firstLine = v.firstLine;
    v.scrollBy(-2);
    assert.equal(v.firstRow, firstRow - 2);
    assert.equal(v.firstLine, firstLine - 2);
    v.reset();
    assert.equal(v.rowCount, 0);
    assert.equal(v.firstRow, v.lastRow);
    assert.equal(v.firstLine, v.lastLine);
  });

  void it('reset clears output and pan, resumes follow, and preserves the wrap preference', () => {
    const v = viewport(10, 2, Array.from({ length: 20 }, (_, i) => `HEAD-${i}-${'x'.repeat(60)}`));
    v.toggleWrap();
    v.scrollToStart();
    v.panToEnd();
    assert.equal(v.follow, false);
    v.reset();
    assert.equal(v.wrap, false);
    assert.equal(v.follow, true);
    assert.equal(v.lineCount, 0);
    assert.deepEqual(v.render(), []);
    v.setLines(['new-HEAD-' + 'x'.repeat(40)]);
    assert.equal(v.render()[0], 'new-HEAD-x');
    v.toggleWrap();
    v.reset();
    assert.equal(v.wrap, true);
    assert.equal(v.follow, true);
  });
});
