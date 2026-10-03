---
{
  "doc_id": "reference/shortcuts-and-dock",
  "covers_sources": [
    "src/ui/background-tasks-manager.ts",
    "src/ui/task-log-viewport.ts"
  ],
  "covers_surfaces": [
    "shortcut:shift+down",
    "shortcut:ctrl+alt+b",
    "shortcut:ctrl+alt+c"
  ]
}
---
# Shortcuts and dock

| `PI_BG_DOCK_SHORTCUT` | Key | Footer hint |
| --- | --- | --- |
| `shift+down` (default) | Shift+Down | Shift↓ |
| `ctrl+alt+b` | Ctrl+Alt+B | CtrlAltB |
| `off` | none | /tasks |

Ctrl+Alt+C is separate: acknowledge finished notices, with `/bg-clear` as the terminal-independent fallback. Invalid/blank/whitespace-bearing config fails extension load.

Footer counts show running, failed, stopped (`killed`), done (`completed`). Finished badges persist until that task's logs or full info are explicitly opened, or `/bg-clear` acknowledges them. Merely selecting a task for the wide log preview does **not** mark its notice seen. Dock focus replaces the entry hint with `focused`; closing or viewing the list does not acknowledge all notices.

## Layout and focus

The dock is a **centered floating panel**, not a bottom-anchored strip. It uses the full width allocated by the host, with no 118-column cap. Height adapts to the available space, capped at 80% of terminal height with a one-cell margin; the log viewport is not fixed to 12 output lines.

- **Wide:** a task sidebar and the selected task's log preview share the panel. Task focus selects tasks; log focus scrolls the selected task's output.
- **Narrow:** start with the task list; Enter/→ opens the selected task's log detail, and ← returns to the list.
- `f` opens a log-only view. `i` toggles a scrollable full task-info view; metadata is compact by default.

The full info view exposes name, ID, status, runtime, PID, start time, output path, description, command and error. It shows process facts, not model/usage telemetry.

The open overlay captures keyboard input; background processes continue to run. It is not an always-on passive panel. Only TUI opens custom UI. Stale contexts are treated as closed; unrelated action failures remain visible.

## Controls

| Key | Action |
| --- | --- |
| ↑/↓, PgUp/PgDn | Select tasks in task focus; scroll output in log focus, or full info when that view is open. |
| Enter/→ | Open the selected task's logs with log focus. |
| Tab | Switch task/log focus. |
| ← | Return to task focus or the narrow task list. |
| `f` | Open the log-only view. |
| `i` | Toggle the scrollable full task-info view. |
| `h` | Toggle history in the task list. |
| `w` | Toggle default soft-wrap and no-wrap log display. |
| Shift+Left/Right | Pan horizontally in no-wrap mode. |
| `0`, `$` | Reset horizontal pan or go to the last column, respectively, in no-wrap mode. |
| `g`, `G` | In logs, go to the oldest retained row or resume the live tail, respectively. |
| `r` | Refresh logs and resume follow. |
| `k` | Stop the selected running task. |
| `a`/`A`/`K` | Stop all after a second confirmation. |
| `R` | Rerun as a new shell task, preserving reload opt-in. |
| `c`/`C` | Display the output path; this does **not** copy it to the clipboard. |
| Esc, `q`/`Q`, `x`/`X` | Close the dock. |

## Bounded log viewport

Logs soft-wrap by default. In no-wrap mode, horizontal pan reveals long lines without changing the log data. While paused, the source-log-line anchor is preserved across resizing and wrap toggles, rather than treating a reflowed display row as a new position.

The task/log UI uses a **UI-only 128 KiB recent-tail reservoir**, refreshed once per second while following. Scrolling up freezes the reservoir, so new output does not displace the paused view. Reaching the bottom, `r`, or `G` refreshes and resumes follow. `g` means the oldest row still retained in this reservoir, **not** the beginning of the output file. Soft-wrap does not load full-file history.

This viewport is separate from the unchanged **50 KiB tool/model log cap**. Output-path display provides the path for full-file inspection; UI layout and navigation do not change process ownership, runtime or reload behavior.

See [task commands](../commands/task-manager.md) and [lifecycle](../subsystems/extension-lifecycle.md).
