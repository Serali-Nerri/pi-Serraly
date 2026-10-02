import { existsSync } from 'node:fs';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { formatSize } from '@earendil-works/pi-coding-agent';
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type OverlayOptions,
  type TUI,
} from '@earendil-works/pi-tui';
import {
  boundedRead,
  compactWhitespace,
  formatDuration,
  taskDisplayName,
  type BgTaskSnapshot,
} from '../core/common.js';
import { sanitizeDisplayText, TaskLogViewport } from './task-log-viewport.js';

export interface TaskManagerTheme {
  fg: Theme['fg'];
}

export type BackgroundTaskForUi = BgTaskSnapshot & { name: string; outputAbsPath: string };
type BgTask = BackgroundTaskForUi;

const STATUS_INTERVAL_MS = 1000;
// Detail-view scrollback reservoir. Larger than the model-facing log cap because
// this is a UI-only read; a local 128KiB tail read per second is negligible and
// gives thousands of lines of scrollback when the user pauses the live tail.
const DETAIL_TAIL_BYTES = 128 * 1024;
const OVERLAY_HEIGHT_PERCENT = 80;
const OVERLAY_MARGIN = 1;
const SIDEBAR_MIN_INNER_WIDTH = 104;
export const TASK_MANAGER_OVERLAY_OPTIONS = {
  anchor: 'center',
  width: '90%',
  minWidth: 40,
  maxHeight: `${OVERLAY_HEIGHT_PERCENT}%`,
  margin: OVERLAY_MARGIN,
} satisfies OverlayOptions;
const LIGHT_BLUE_BG = '\x1b[48;2;183;223;255m';
const LIGHT_BLUE_FG = '\x1b[38;2;11;70;110m';
const LIGHT_BLUE_BORDER = '\x1b[38;2;83;160;215m';
const ANSI_RESET = '\x1b[0m';

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString();
}

function formatCount(value: number): string {
  return value.toString();
}

function pluralSuffix(count: number): '' | 's' {
  return count === 1 ? '' : 's';
}

function formatExitCodeText(exitCode: BgTask['exitCode']): string {
  return typeof exitCode === 'number' ? ` exit=${formatCount(exitCode)}` : '';
}

function formatPidText(pid: BgTask['pid']): string {
  return typeof pid === 'number' ? ` · pid ${formatCount(pid)}` : '';
}

/** Normalize raw output bytes into display lines, dropping only the trailing empty line from a final newline. */
function toOutputLines(content: string): string[] {
  return content
    .replace(/\r/g, '')
    .split('\n')
    .filter((line, index, array) => line.length > 0 || index < array.length - 1);
}

function padAnsi(value: string, width: number): string {
  return truncateToWidth(value, Math.max(0, width), '', true);
}

function singleLine(value: string): string {
  return sanitizeDisplayText(value).replace(/\n/g, ' ');
}

function lightBlue(value: string): string {
  return `${LIGHT_BLUE_BG}${LIGHT_BLUE_FG}${value}${ANSI_RESET}`;
}

function blueBorder(value: string): string {
  return `${LIGHT_BLUE_BORDER}${value}${ANSI_RESET}`;
}

function statusLabel(status: BgTaskSnapshot['status']): string {
  if (status === 'completed') return 'done';
  if (status === 'failed') return 'error';
  if (status === 'killed') return 'stopped';
  return 'running';
}

function statusColor(
  theme: TaskManagerTheme,
  status: BgTaskSnapshot['status'],
  text = statusLabel(status),
): string {
  if (status === 'completed') return theme.fg('success', text);
  if (status === 'failed') return theme.fg('error', text);
  if (status === 'killed') return theme.fg('warning', text);
  return theme.fg('accent', text);
}

function taskAge(task: BgTask, now = Date.now()): string {
  return formatDuration((task.endTime ?? now) - task.startTime);
}

function sortTasksForUi(tasks: BgTask[]): BgTask[] {
  const rank = (task: BgTask) =>
    task.status === 'running' ? 0 : task.status === 'failed' ? 1 : task.status === 'killed' ? 2 : 3;
  return [...tasks].sort((a, b) => {
    const rankDiff = rank(a) - rank(b);
    if (rankDiff !== 0) return rankDiff;
    return (b.endTime ?? b.startTime) - (a.endTime ?? a.startTime);
  });
}

export type TaskManagerResult = 'closed';

export interface StopAllResult {
  stopped: number;
  failures: string[];
}

export interface TaskManagerOptions {
  initialTaskId?: string;
  getTasks: () => BgTask[];
  stopTask: (task: BgTask) => Promise<void>;
  stopAllRunning: () => Promise<StopAllResult>;
  rerunTask: (task: BgTask) => Promise<BgTask>;
  showOutputPath: (task: BgTask) => void;
  markSeen: (taskId: string) => void;
  markFinishedSeen: (taskIds: string[]) => void;
  isSeen: (taskId: string) => boolean;
}

export class BackgroundTasksManager implements Component {
  private mode: 'list' | 'detail' = 'list';
  private selectedIndex = 0;
  private selectedTaskId: string | undefined;
  private listScroll = 0;
  private listVisibleRows = 1;
  private lastRenderWidth = 80;
  private detailTaskId: string | undefined;
  private showHistory = false;
  private readonly logViewport = new TaskLogViewport();
  private previewVisible = false;
  private logsOnly = false;
  private showInfo = false;
  private infoRows: string[] = [];
  private infoScrollTop = 0;
  private infoVisibleRows = 1;
  private tailGeneration = 0;
  private tailReadInFlight: object | undefined;
  private tailBytesRead = 0;
  private tailTotalBytes = 0;
  private tailTruncated = false;
  private tailError: string | undefined;
  private actionMessage: string | undefined;
  private confirmStopAllArmed = false;
  private readonly lastBytesByTask = new Map<string, number>();
  private readonly recentActivityByTask = new Map<string, { delta: number; timestamp: number }>();
  private disposed = false;
  private refreshTimer: NodeJS.Timeout;

  constructor(
    private readonly tui: Pick<TUI, 'requestRender'> & {
      terminal: Pick<TUI['terminal'], 'rows'>;
    },
    private readonly theme: TaskManagerTheme,
    private readonly done: (result: TaskManagerResult) => void,
    private readonly options: TaskManagerOptions,
  ) {
    if (options.initialTaskId) {
      this.detailTaskId = options.initialTaskId;
      this.selectedTaskId = options.initialTaskId;
      this.mode = 'detail';
      if (this.detailTask()?.status !== 'running') this.showHistory = true;
      this.options.markSeen(options.initialTaskId);
      void this.refreshTail();
    } else {
      const allTasks = options.getTasks();
      const hasRunning = allTasks.some((task) => task.status === 'running');
      const hasFinished = allTasks.some((task) => task.status !== 'running');
      if (!hasRunning && hasFinished) this.showHistory = true;
    }
    this.refreshTimer = setInterval(() => {
      if (this.disposed) return;
      if (this.mode === 'detail' || this.previewVisible) void this.refreshTail();
      this.tui.requestRender();
    }, STATUS_INTERVAL_MS);
    this.refreshTimer.unref();
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.refreshTimer);
  }

  invalidate(): void {
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    const stopAllKey = data === 'a' || data === 'A' || data === 'K';
    if (!stopAllKey) this.confirmStopAllArmed = false;
    this.actionMessage = undefined;

    if (
      matchesKey(data, 'escape') ||
      data === 'q' ||
      data === 'Q' ||
      data === 'x' ||
      data === 'X'
    ) {
      this.close();
      return;
    }

    // Navigation can arrive before the first paint after opening details, or
    // after a terminal-height change. Scroll against the current viewport,
    // never the log helper's not-yet-laid-out one-cell defaults.
    this.render(this.lastRenderWidth);
    if (stopAllKey) {
      void this.stopAllFromUi();
      return;
    }
    if (matchesKey(data, 'tab')) {
      if (this.mode === 'detail') this.returnToList();
      else {
        const tasks = this.currentTasks();
        this.normalizeSelection(tasks);
        const task = tasks[this.selectedIndex];
        if (task) this.openDetail(task.id);
      }
      return;
    }
    if (data === 'i' || data === 'f') {
      if (this.mode === 'list') {
        const tasks = this.currentTasks();
        this.normalizeSelection(tasks);
        const task = tasks[this.selectedIndex];
        if (!task) return;
        this.openDetail(task.id);
      }
      if (data === 'i') {
        this.showInfo = !this.showInfo;
        this.infoScrollTop = 0;
      } else {
        this.logsOnly = !this.logsOnly;
      }
      this.tui.requestRender();
      return;
    }
    if (this.mode === 'detail' || this.previewVisible) {
      if (data === 'w') {
        this.logViewport.toggleWrap();
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, 'shift+left') || matchesKey(data, 'shift+right')) {
        const step = Math.max(1, Math.floor(this.logViewport.width / 2));
        this.logViewport.panBy(matchesKey(data, 'shift+left') ? -step : step);
        this.tui.requestRender();
        return;
      }
      if (data === '0' || data === '$') {
        if (data === '0') this.logViewport.panToStart();
        else this.logViewport.panToEnd();
        this.tui.requestRender();
        return;
      }
    }

    if (this.mode === 'detail') {
      this.handleDetailInput(data);
      return;
    }
    this.handleListInput(data);
  }

  render(width: number): string[] {
    const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    if (safeWidth === 0) return [];
    this.lastRenderWidth = safeWidth;
    const terminalRows = Number.isFinite(this.tui.terminal.rows)
      ? Math.max(1, Math.floor(this.tui.terminal.rows))
      : 1;
    // Keep this budget derived from the same constants as the host's options.
    // maxHeight is a top-slice, not a scrolling viewport.
    const height = Math.max(1, Math.min(
      Math.floor(terminalRows * OVERLAY_HEIGHT_PERCENT / 100),
      terminalRows - OVERLAY_MARGIN * 2,
    ));
    return this.renderPanel(safeWidth, height).map((line) =>
      truncateToWidth(line, safeWidth, '', true),
    );
  }

  private close(): void {
    this.dispose();
    this.done('closed');
  }

  private handleListInput(data: string): void {
    const tasks = this.currentTasks();
    this.normalizeSelection(tasks);
    if (tasks.length === 0) {
      if (matchesKey(data, 'return')) this.close();
      if (data === 'h' || data === 'H') {
        this.showHistory = !this.showHistory;
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, 'up')) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.selectedTaskId = tasks[this.selectedIndex]?.id;
      this.ensureSelectionVisible();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, 'down')) {
      this.selectedIndex = Math.min(tasks.length - 1, this.selectedIndex + 1);
      this.selectedTaskId = tasks[this.selectedIndex]?.id;
      this.ensureSelectionVisible();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, 'pageUp')) {
      this.selectedIndex = Math.max(0, this.selectedIndex - this.listVisibleRows);
      this.selectedTaskId = tasks[this.selectedIndex]?.id;
      this.ensureSelectionVisible();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, 'pageDown')) {
      this.selectedIndex = Math.min(tasks.length - 1, this.selectedIndex + this.listVisibleRows);
      this.selectedTaskId = tasks[this.selectedIndex]?.id;
      this.ensureSelectionVisible();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, 'return') || matchesKey(data, 'right')) {
      const task = tasks[this.selectedIndex];
      if (!task) return;
      this.openDetail(task.id);
      return;
    }
    if (data === 'k') {
      const task = tasks[this.selectedIndex];
      if (task) void this.stopTaskFromUi(task);
      return;
    }
    if (data === 'R') {
      const task = tasks[this.selectedIndex];
      if (task) void this.rerunTaskFromUi(task);
      return;
    }
    if (data === 'c' || data === 'C') {
      const task = tasks[this.selectedIndex];
      if (task) this.showOutputPathFromUi(task);
      return;
    }
    if (data === 'h' || data === 'H') {
      this.showHistory = !this.showHistory;
      this.selectedIndex = 0;
      this.selectedTaskId = undefined;
      this.listScroll = 0;
      this.tui.requestRender();
    }
  }

  private handleDetailInput(data: string): void {
    const task = this.detailTask();
    if (matchesKey(data, 'left')) {
      this.returnToList();
      return;
    }
    if (matchesKey(data, 'up')) {
      this.scrollDetail(-1);
      return;
    }
    if (matchesKey(data, 'down')) {
      this.scrollDetail(1);
      return;
    }
    if (matchesKey(data, 'pageUp')) {
      this.scrollDetail(-(this.showInfo ? this.infoVisibleRows : this.logViewport.height));
      return;
    }
    if (matchesKey(data, 'pageDown')) {
      this.scrollDetail(this.showInfo ? this.infoVisibleRows : this.logViewport.height);
      return;
    }
    if (data === 'g' || data === 'G') {
      if (this.showInfo) {
        this.infoScrollTop = data === 'g' ? 0 : Math.max(0, this.infoRows.length - this.infoVisibleRows);
      } else if (data === 'g') {
        this.logViewport.scrollToStart();
      } else {
        this.logViewport.scrollToEnd();
        void this.refreshTail();
      }
      this.tui.requestRender();
      return;
    }
    if (data === 'r') {
      this.logViewport.scrollToEnd();
      void this.refreshTail();
      this.tui.requestRender();
      return;
    }
    if (data === 'R' && task) {
      void this.rerunTaskFromUi(task);
      return;
    }
    if (data === 'k' && task) {
      void this.stopTaskFromUi(task);
      return;
    }
    if ((data === 'c' || data === 'C') && task) {
      this.showOutputPathFromUi(task);
    }
  }

  private currentTasks(): BgTask[] {
    const allTasks = this.options.getTasks();
    let visible = this.showHistory
      ? allTasks
      : allTasks.filter((task) => task.status === 'running');
    if (
      !this.showHistory &&
      visible.length === 0 &&
      allTasks.some((task) => task.status !== 'running')
    ) {
      this.showHistory = true;
      visible = allTasks;
    }
    return sortTasksForUi(visible);
  }

  private detailTask(): BgTask | undefined {
    return this.options.getTasks().find((task) => task.id === this.detailTaskId);
  }

  private openDetail(taskId: string): void {
    const task = this.options.getTasks().find((candidate) => candidate.id === taskId);
    if (task && task.status !== 'running') this.showHistory = true;
    this.selectedTaskId = taskId;
    this.mode = 'detail';
    this.selectLogTask(taskId);
    this.options.markSeen(taskId);
    this.tui.requestRender();
  }

  private selectLogTask(taskId: string | undefined): void {
    if (this.detailTaskId === taskId) return;
    this.detailTaskId = taskId;
    this.tailGeneration++;
    this.tailReadInFlight = undefined;
    this.logViewport.reset();
    this.tailBytesRead = 0;
    this.tailTotalBytes = 0;
    this.tailTruncated = false;
    this.tailError = undefined;
    this.showInfo = false;
    this.infoRows = [];
    this.infoScrollTop = 0;
    if (taskId) void this.refreshTail();
  }

  private returnToList(): void {
    this.mode = 'list';
    this.logsOnly = false;
    this.showInfo = false;
    this.tui.requestRender();
  }

  private normalizeSelection(tasks: BgTask[]): void {
    const index = tasks.findIndex((task) => task.id === this.selectedTaskId);
    if (index >= 0) this.selectedIndex = index;
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, tasks.length - 1));
    this.selectedTaskId = tasks[this.selectedIndex]?.id;
    this.ensureSelectionVisible();
  }

  private ensureSelectionVisible(): void {
    if (this.selectedIndex < this.listScroll) this.listScroll = this.selectedIndex;
    if (this.selectedIndex >= this.listScroll + this.listVisibleRows)
      this.listScroll = this.selectedIndex - this.listVisibleRows + 1;
  }

  private async stopTaskFromUi(task: BgTask): Promise<void> {
    if (task.status !== 'running') {
      this.actionMessage = `${taskDisplayName(task)} is ${task.status}; nothing to stop.`;
      this.tui.requestRender();
      return;
    }
    this.actionMessage = `Stopping ${taskDisplayName(task)}…`;
    this.tui.requestRender();
    try {
      await this.options.stopTask(task);
      this.actionMessage = `Stopped ${taskDisplayName(task)}.`;
    } catch (error) {
      this.actionMessage = `Stop failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.tui.requestRender();
  }

  private async stopAllFromUi(): Promise<void> {
    const running = this.options.getTasks().filter((task) => task.status === 'running');
    if (running.length === 0) {
      this.actionMessage = 'No running background tasks to stop.';
      this.tui.requestRender();
      return;
    }
    if (!this.confirmStopAllArmed) {
      this.confirmStopAllArmed = true;
      this.actionMessage = `Press a/K again to stop all ${formatCount(running.length)} running task${pluralSuffix(running.length)}.`;
      this.tui.requestRender();
      return;
    }

    this.confirmStopAllArmed = false;
    this.actionMessage = `Stopping ${formatCount(running.length)} running task${pluralSuffix(running.length)}…`;
    this.tui.requestRender();
    try {
      const result = await this.options.stopAllRunning();
      this.actionMessage =
        result.failures.length > 0
          ? `Stopped ${formatCount(result.stopped)}; ${formatCount(result.failures.length)} failed: ${result.failures.join('; ')}`
          : `Stopped ${formatCount(result.stopped)} running task${pluralSuffix(result.stopped)}.`;
    } catch (error) {
      this.actionMessage = `Stop-all failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.tui.requestRender();
  }

  private async rerunTaskFromUi(task: BgTask): Promise<void> {
    const fromDetail = this.mode === 'detail';
    const generation = this.tailGeneration;
    this.actionMessage = `Rerunning ${taskDisplayName(task)}…`;
    this.tui.requestRender();
    try {
      const rerun = await this.options.rerunTask(task);
      if (this.disposed) return;
      const sameTarget = fromDetail
        ? this.mode === 'detail' && this.detailTaskId === task.id && this.tailGeneration === generation
        : this.mode === 'list' && this.selectedTaskId === task.id;
      if (sameTarget) {
        this.showHistory = false;
        this.selectedTaskId = rerun.id;
        if (fromDetail) this.openDetail(rerun.id);
        const index = this.currentTasks().findIndex((candidate) => candidate.id === rerun.id);
        if (index >= 0) {
          this.selectedIndex = index;
          this.ensureSelectionVisible();
        }
      }
      this.actionMessage = `Reran as ${taskDisplayName(rerun)} (${rerun.id}).`;
    } catch (error) {
      this.actionMessage = `Rerun failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.tui.requestRender();
  }

  private showOutputPathFromUi(task: BgTask): void {
    this.options.showOutputPath(task);
    this.actionMessage = `Output path shown for ${taskDisplayName(task)}.`;
    this.tui.requestRender();
  }

  /** Scroll the detail output window. Scrolling up pauses the live tail; reaching the bottom resumes it. */
  private scrollDetail(delta: number): void {
    if (this.showInfo) {
      this.infoScrollTop = Math.max(0, Math.min(
        Math.max(0, this.infoRows.length - this.infoVisibleRows),
        this.infoScrollTop + delta,
      ));
    } else {
      const wasFollowing = this.logViewport.follow;
      this.logViewport.scrollBy(delta);
      if (!wasFollowing && this.logViewport.follow) void this.refreshTail();
    }
    this.tui.requestRender();
  }

  private async refreshTail(): Promise<void> {
    const task = this.detailTask();
    if (!task || this.disposed) return;
    // While the user has scrolled up, the buffer is frozen so their view stays stable.
    if (!this.logViewport.follow || this.tailReadInFlight) return;
    const generation = this.tailGeneration;
    const token = {};
    this.tailReadInFlight = token;
    const isCurrent = () =>
      !this.disposed &&
      this.detailTaskId === task.id &&
      this.tailGeneration === generation &&
      this.logViewport.follow;
    try {
      if (!existsSync(task.outputAbsPath)) {
        this.tailBytesRead = 0;
        this.tailTotalBytes = 0;
        this.tailTruncated = false;
        this.tailError = `Output file not found: ${task.outputPath}`;
        this.logViewport.setLines([this.tailError]);
        return;
      }
      const read = await boundedRead(task.outputAbsPath, DETAIL_TAIL_BYTES, true);
      // A read admitted for an old selection/follow state must never replace
      // the new task's buffer or the user's frozen scrollback.
      if (!isCurrent()) return;
      this.logViewport.setLines(toOutputLines(read.content));
      this.tailBytesRead = read.bytesRead;
      this.tailTotalBytes = read.totalBytes;
      this.tailTruncated = read.truncated;
      this.tailError = undefined;
    } catch (error) {
      if (!isCurrent()) return;
      this.tailError = `Output read failed: ${error instanceof Error ? error.message : String(error)}`;
      this.logViewport.setLines([this.tailError]);
    } finally {
      if (this.tailReadInFlight === token) this.tailReadInFlight = undefined;
      if (isCurrent()) this.tui.requestRender();
    }
  }

  private activityLabel(task: BgTask): string {
    if (task.status !== 'running') return '';
    const now = Date.now();
    const previous = this.lastBytesByTask.get(task.id);
    this.lastBytesByTask.set(task.id, task.bytesWritten);
    if (previous !== undefined && task.bytesWritten > previous) {
      const delta = task.bytesWritten - previous;
      this.recentActivityByTask.set(task.id, { delta, timestamp: now });
      return `+${formatSize(delta)} ↑`;
    }
    const recent = this.recentActivityByTask.get(task.id);
    if (recent && now - recent.timestamp < 3000) return `+${formatSize(recent.delta)} ↑`;
    return '';
  }

  private listSummary(): string {
    const allTasks = this.options.getTasks();
    const allRunning = allTasks.filter((task) => task.status === 'running').length;
    const historyCount = allTasks.length - allRunning;
    const unseenFailed = allTasks.filter(
      (task) => task.status === 'failed' && !this.options.isSeen(task.id),
    ).length;
    const unseenStopped = allTasks.filter(
      (task) => task.status === 'killed' && !this.options.isSeen(task.id),
    ).length;
    const unseenDone = allTasks.filter(
      (task) => task.status === 'completed' && !this.options.isSeen(task.id),
    ).length;
    const unread = unseenFailed + unseenStopped + unseenDone;
    const subtitleParts = this.showHistory
      ? [`${formatCount(allRunning)} active`, `${formatCount(historyCount)} history`]
      : allRunning > 0
        ? [`${formatCount(allRunning)} active shell${pluralSuffix(allRunning)}`]
        : ['No active shells'];
    if (unseenFailed) subtitleParts.push(`${formatCount(unseenFailed)} failed`);
    if (unseenStopped) subtitleParts.push(`${formatCount(unseenStopped)} stopped`);
    if (unseenDone) subtitleParts.push(`${formatCount(unseenDone)} done`);
    if (unread) subtitleParts.push(`${formatCount(unread)} unread`);
    return subtitleParts.join(' · ');
  }

  private renderPanel(width: number, height: number): string[] {
    const inner = Math.max(0, width - 2);
    const top = blueBorder(`╭${'─'.repeat(inner)}╮`);
    const bottom = blueBorder(`╰${'─'.repeat(inner)}╯`);
    if (height === 1) return [top];
    if (height === 2) return [top, bottom];
    const row = (content = '') =>
      `${blueBorder('│')}${padAnsi(content, inner)}${blueBorder('│')}`;
    const focusedTask = this.mode === 'detail' ? this.detailTask() : undefined;
    if (focusedTask) {
      this.selectedTaskId = focusedTask.id;
      // A completed viewed task must remain in the sidebar rather than moving
      // the pointer onto another running task while actions still address it.
      if (focusedTask.status !== 'running') this.showHistory = true;
    }
    const tasks = this.currentTasks();
    this.normalizeSelection(tasks);
    if (this.mode === 'detail' && !this.detailTask()) this.returnToList();
    const split = inner >= SIDEBAR_MIN_INNER_WIDTH && !this.logsOnly;
    this.previewVisible = split && this.mode === 'list';
    if (this.previewVisible) this.selectLogTask(tasks[this.selectedIndex]?.id);

    const hasHeader = height >= 5;
    const hasSubtitle = height >= 8;
    const hasStatus = height >= 6;
    const hasFooter = height >= 4;
    const bodyRows = height - 2 - Number(hasHeader) - Number(hasSubtitle)
      - Number(hasStatus) - Number(hasFooter);
    const task = this.detailTask();
    const title = this.mode === 'list'
      ? 'bg tasks focused'
      : `bg: ${singleLine(task ? taskDisplayName(task) : 'Task')}`;
    const subtitle = this.mode === 'list'
      ? this.listSummary()
      : task
        ? `${task.id} · ${statusColor(this.theme, task.status)} · ${taskAge(task)}${formatPidText(task.pid)}`
        : '';
    const lines = [top];
    if (hasHeader) lines.push(row(lightBlue(padAnsi(` ${title}`, inner))));
    if (hasSubtitle) lines.push(row(` ${subtitle}`));

    if (split) {
      const sidebarWidth = Math.min(36, Math.max(24, Math.floor(inner * 0.26)));
      const sidebarHeading = ` Tasks · Tab ${this.mode === 'list' ? 'logs' : 'list'}`;
      const sidebar = bodyRows > 1
        ? [this.theme.fg('dim', sidebarHeading), ...this.renderTaskRows(tasks, sidebarWidth, bodyRows - 1, true)]
        : this.renderTaskRows(tasks, sidebarWidth, bodyRows, true);
      const logWidth = inner - sidebarWidth - 1;
      const logs = this.renderLogPane(logWidth, bodyRows);
      for (let i = 0; i < bodyRows; i++) {
        lines.push(row(
          padAnsi(sidebar[i] ?? '', sidebarWidth) + blueBorder('│')
          + padAnsi(logs[i] ?? '', logWidth),
        ));
      }
    } else {
      const body = this.mode === 'list'
        ? this.renderTaskRows(tasks, inner, bodyRows, false)
        : this.renderLogPane(inner, bodyRows);
      for (let i = 0; i < bodyRows; i++) lines.push(row(body[i]));
    }

    if (hasStatus) {
      const message = this.actionMessage
        ? this.theme.fg('warning', singleLine(this.actionMessage))
        : this.mode === 'detail' || this.previewVisible
          ? this.outputStatusLine()
          : tasks.length > 0
            ? `Showing ${this.listScroll + 1}–${Math.min(tasks.length, this.listScroll + this.listVisibleRows)} of ${tasks.length}`
            : this.listSummary();
      lines.push(row(` ${this.theme.fg('dim', message)}`));
    }
    if (hasFooter) lines.push(row(` ${this.theme.fg('dim', this.footer())}`));
    lines.push(bottom);
    return lines;
  }

  private renderTaskRows(tasks: BgTask[], width: number, height: number, compact: boolean): string[] {
    this.listVisibleRows = Math.max(1, height);
    this.listScroll = Math.min(this.listScroll, Math.max(0, tasks.length - this.listVisibleRows));
    this.ensureSelectionVisible();
    if (tasks.length === 0) {
      return [this.theme.fg('dim', ' No background tasks in this session.')];
    }
    return tasks.slice(this.listScroll, this.listScroll + height).map((task, index) => {
      const selected = this.listScroll + index === this.selectedIndex;
      const pointer = selected ? '›' : ' ';
      const unread = task.status !== 'running' && !this.options.isSeen(task.id)
        ? this.theme.fg('warning', '●')
        : ' ';
      const status = statusColor(this.theme, task.status);
      const activity = this.activityLabel(task);
      const suffix = compact
        ? ` ${status}`
        : ` ${this.theme.fg('dim', task.id)} · ${status}${formatExitCodeText(task.exitCode)} ${this.theme.fg('dim', `${taskAge(task)} ${formatSize(task.bytesWritten)}`)}${activity ? ` ${this.theme.fg('warning', activity)}` : ''}`;
      const nameWidth = Math.max(1, width - 5 - visibleWidth(suffix));
      const name = truncateToWidth(singleLine(taskDisplayName(task)), nameWidth);
      const content = ` ${pointer} ${unread} ${this.theme.fg('text', name)}${suffix}`;
      return selected && this.mode === 'list'
        ? lightBlue(padAnsi(content, width))
        : padAnsi(content, width);
    });
  }

  private renderLogPane(width: number, height: number): string[] {
    const task = this.detailTask();
    if (!task) return [this.theme.fg('dim', ' Select a task to see logs.')];
    const hasHeading = height >= 3;
    const contentWidth = Math.max(1, width - 2);
    const contentRows = Math.max(1, height - Number(hasHeading));
    this.logViewport.resize(contentWidth, contentRows);
    this.infoVisibleRows = contentRows;
    const heading = this.showInfo
      ? 'Task info: · i logs'
      : `Output tail: ${singleLine(taskDisplayName(task))}${this.mode === 'list' ? ' · Enter logs' : ''}`;
    const lines = hasHeading ? [` ${this.theme.fg('toolTitle', truncateToWidth(heading, contentWidth))}`] : [];
    if (this.showInfo) {
      this.infoRows = this.taskInfo(task).flatMap((line) =>
        wrapTextWithAnsi(sanitizeDisplayText(line), contentWidth),
      );
      this.infoScrollTop = Math.min(
        this.infoScrollTop,
        Math.max(0, this.infoRows.length - contentRows),
      );
      lines.push(...this.infoRows.slice(this.infoScrollTop, this.infoScrollTop + contentRows)
        .map((line) => ` ${this.theme.fg('text', line)}`));
    } else if (this.logViewport.lineCount === 0) {
      lines.push(` ${this.theme.fg('dim', 'No output yet')}`);
    } else {
      lines.push(...this.logViewport.render().map((line) =>
        ` ${this.theme.fg(this.tailError ? 'error' : 'toolOutput', line)}`,
      ));
    }
    return lines;
  }

  private taskInfo(task: BgTask): string[] {
    const name = taskDisplayName(task);
    const exit = formatExitCodeText(task.exitCode);
    const lines = [
      `Name: ${name}`,
      `ID: ${task.id}`,
      `Status: ${statusLabel(task.status)}${exit}`,
      `Runtime: ${taskAge(task)}${formatPidText(task.pid)}`,
      `Started: ${formatTime(task.startTime)}${task.endTime ? ` · ended ${formatTime(task.endTime)}` : ''}`,
      `Output: ${task.outputPath}`,
    ];
    if (task.description && compactWhitespace(task.description) !== compactWhitespace(name)) {
      lines.push(`Description: ${task.description}`);
    }
    lines.push(`Command: ${task.command}`);
    if (task.error) lines.push(`Error: ${task.error}`);
    return lines;
  }

  private outputStatusLine(): string {
    if (this.showInfo) {
      return `Info rows ${this.infoScrollTop + 1}–${Math.min(this.infoRows.length, this.infoScrollTop + this.infoVisibleRows)} of ${this.infoRows.length} · ↑/↓ scroll · i logs`;
    }
    const viewport = this.logViewport;
    const mode = viewport.wrap
      ? 'wrap on · w toggle'
      : `wrap off · col ${viewport.offset + 1} · ⇧←/→ pan · 0/$`;
    if (!viewport.follow && viewport.lineCount > 0) {
      const wrapped = viewport.rowCount !== viewport.lineCount
        ? ` · rows ${viewport.firstRow}–${viewport.lastRow} of ${viewport.rowCount}`
        : '';
      return `lines ${viewport.firstLine}–${viewport.lastLine} of ${viewport.lineCount}${wrapped} · ${mode}`;
    }
    const suffix = this.tailTruncated ? ` of ${formatSize(this.tailTotalBytes)}` : '';
    return `following tail ${formatSize(this.tailBytesRead)}${suffix} · ${mode}`;
  }

  private footer(): string {
    return this.mode === 'list'
      ? `x close · ↑/↓ select · Enter/Tab logs · h ${this.showHistory ? 'hide' : 'show'} history · k stop · a stop all · R rerun · c path`
      : 'x close · ↑/↓ PgUp/PgDn scroll · ←/Tab list · w wrap · i info · f logs only · g/G top/tail · r refresh · k stop · R rerun · c path';
  }
}
