import {
  sliceByColumn,
  stripTerminalSequences,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';

interface LogRow {
  text: string;
  line: number;
  column: number;
}

/** Display-only normalization. The retained output file is never changed. */
export function sanitizeDisplayText(text: string): string {
  // Pi 0.99.1's stripper only recognizes a subset of CSI final bytes and can
  // otherwise scan into printable text. Consume the standard byte grammar
  // first; leave its OSC/APC handling in charge of terminal string sequences.
  const withoutCsi = text
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*/g, '');
  return stripTerminalSequences(withoutCsi)
    .replace(/\t/g, '    ')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

/**
 * A bounded log viewport independent of file I/O, task ownership and themes.
 * Scroll anchors refer to source lines/columns, not width-dependent wrapped rows.
 */
export class TaskLogViewport {
  private lines: string[] = [];
  private rows: LogRow[] = [];
  private contentWidth = 1;
  private viewportHeight = 1;
  private wrapEnabled = true;
  private following = true;
  private scrollTop = 0;
  private horizontalOffset = 0;
  private pausedAnchor: Pick<LogRow, 'line' | 'column'> | undefined;
  private maxLineWidth = 0;

  get follow(): boolean { return this.following; }
  get wrap(): boolean { return this.wrapEnabled; }
  get width(): number { return this.contentWidth; }
  get height(): number { return this.viewportHeight; }
  get offset(): number { return this.horizontalOffset; }
  get lineCount(): number { return this.lines.length; }
  get rowCount(): number { return this.rows.length; }
  get firstRow(): number { return this.rows.length > 0 ? this.scrollTop + 1 : 0; }
  get lastRow(): number { return Math.min(this.rows.length, this.scrollTop + this.viewportHeight); }
  get firstLine(): number {
    const row = this.rows[this.scrollTop];
    return row ? row.line + 1 : 0;
  }
  get lastLine(): number {
    const row = this.rows[this.lastRow - 1];
    return row ? row.line + 1 : 0;
  }

  reset(): void {
    this.following = true;
    this.scrollTop = 0;
    this.horizontalOffset = 0;
    this.pausedAnchor = undefined;
    this.setLines([]);
  }

  setLines(lines: readonly string[]): void {
    const normalized = lines.flatMap((line) => sanitizeDisplayText(line).split('\n'));
    if (
      normalized.length === this.lines.length &&
      normalized.every((line, index) => line === this.lines[index])
    ) return;
    const anchor = this.anchor();
    this.lines = normalized;
    this.maxLineWidth = this.lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
    this.rebuild(anchor);
  }

  resize(width: number, height: number): void {
    const nextWidth = this.dimension(width);
    const nextHeight = this.dimension(height);
    if (nextWidth === this.contentWidth && nextHeight === this.viewportHeight) return;
    const anchor = this.anchor();
    const widthChanged = nextWidth !== this.contentWidth;
    this.contentWidth = nextWidth;
    this.viewportHeight = nextHeight;
    if (widthChanged && this.wrapEnabled) this.rebuild(anchor);
    else this.restoreAnchor(anchor);
    this.clampPan();
  }

  toggleWrap(): void {
    const anchor = this.anchor();
    this.wrapEnabled = !this.wrapEnabled;
    this.horizontalOffset = !this.wrapEnabled && !this.following ? anchor?.column ?? 0 : 0;
    this.rebuild(anchor);
  }

  scrollBy(delta: number): void {
    if (!Number.isFinite(delta)) return;
    const movement = Math.trunc(delta);
    if (movement === 0) return;
    const maxTop = this.maxTop();
    const start = this.following ? maxTop : this.scrollTop;
    if (movement > 0) {
      this.scrollTop = Math.min(maxTop, start + movement);
      this.following = this.scrollTop === maxTop;
    } else {
      this.scrollTop = Math.max(0, start + movement);
      this.following = this.following && maxTop === 0;
    }
    this.updateNavigationAnchor();
    // Resizing/reflow alone never resumes follow. Explicit navigation does.
  }

  scrollToStart(): void {
    this.scrollTop = 0;
    this.following = this.maxTop() === 0;
    this.updateNavigationAnchor();
  }

  scrollToEnd(): void {
    this.following = true;
    this.pausedAnchor = undefined;
    this.scrollTop = this.maxTop();
  }

  panBy(delta: number): void {
    if (this.wrapEnabled || !Number.isFinite(delta)) return;
    this.horizontalOffset += Math.trunc(delta);
    this.clampPan();
    this.updateNavigationAnchor();
  }

  panToStart(): void {
    this.horizontalOffset = 0;
    if (!this.wrapEnabled) this.updateNavigationAnchor();
  }

  panToEnd(): void {
    if (!this.wrapEnabled) {
      this.horizontalOffset = this.maxPan();
      this.updateNavigationAnchor();
    }
  }

  render(): string[] {
    return this.rows.slice(this.scrollTop, this.scrollTop + this.viewportHeight).map((row) =>
      this.wrapEnabled
        ? visibleWidth(row.text) <= this.contentWidth
          ? row.text
          : sliceByColumn(row.text, 0, this.contentWidth, true)
        : sliceByColumn(row.text, this.horizontalOffset, this.contentWidth, true),
    );
  }

  private dimension(value: number): number {
    return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
  }

  private maxTop(): number {
    return Math.max(0, this.rows.length - this.viewportHeight);
  }

  private maxPan(): number {
    return Math.max(0, this.maxLineWidth - this.contentWidth);
  }

  private clampPan(): void {
    this.horizontalOffset = Math.max(0, Math.min(this.maxPan(), this.horizontalOffset));
  }

  private anchor(): Pick<LogRow, 'line' | 'column'> | undefined {
    return this.pausedAnchor ?? this.rows[this.scrollTop];
  }

  private updateNavigationAnchor(): void {
    const row = this.rows[this.scrollTop];
    this.pausedAnchor = !this.following && row
      ? { line: row.line, column: this.wrapEnabled ? row.column : this.horizontalOffset }
      : undefined;
  }

  private restoreAnchor(anchor: Pick<LogRow, 'line' | 'column'> | undefined): void {
    if (this.following) {
      this.pausedAnchor = undefined;
      this.scrollTop = this.maxTop();
      return;
    }
    if (anchor) {
      let index = this.rows.findIndex((row) => row.line >= anchor.line);
      if (index < 0) index = this.rows.length - 1;
      while (true) {
        const next = this.rows[index + 1];
        if (!next || next.line !== anchor.line || next.column > anchor.column) break;
        index++;
      }
      this.scrollTop = Math.max(0, index);
      const row = this.rows[this.scrollTop];
      // Preserve the exact source column across repeated reflows, even when
      // the nearest new wrapped row starts earlier than that column.
      this.pausedAnchor = row?.line === anchor.line
        ? { line: anchor.line, column: anchor.column }
        : row ? { line: row.line, column: row.column } : undefined;
    }
    // A taller/wider paused viewport may have blank rows below its anchor.
    // Keep that source position rather than snapping upward to fill the pane.
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, this.rows.length - 1));
  }

  private rebuild(anchor: Pick<LogRow, 'line' | 'column'> | undefined): void {
    this.rows = [];
    for (const [line, source] of this.lines.entries()) {
      if (!this.wrapEnabled) {
        this.rows.push({ text: source, line, column: 0 });
        continue;
      }
      const wrapped = wrapTextWithAnsi(source, this.contentWidth);
      let consumed = 0;
      let column = 0;
      for (const text of wrapped) {
        // Word wrapping can omit separating whitespace. Account for that when
        // translating a visual row back into its original source-column anchor.
        const found = source.indexOf(text, consumed);
        const offset = found < 0 ? consumed : found;
        column += visibleWidth(source.slice(consumed, offset));
        this.rows.push({ text, line, column });
        consumed = offset + text.length;
        column += visibleWidth(text);
      }
      if (wrapped.length === 0) this.rows.push({ text: '', line, column: 0 });
    }
    this.restoreAnchor(anchor);
    this.clampPan();
  }
}
