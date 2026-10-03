---
{
  "doc_id": "commands/task-manager",
  "covers_sources": [],
  "covers_surfaces": [
    "command:tasks",
    "command:bg-tasks"
  ]
}
---
# `/tasks` and `/bg-tasks`

Aliases: `/tasks [exact-task-id]`, `/bg-tasks [exact-task-id]`. Without an ID, open with task focus; an exact ID opens that task's logs with log focus. This UI argument is not prefix-resolved.

The task manager opens a centered floating panel using the full allocated width (no 118-column cap), with adaptive height capped at 80% of the terminal and a one-cell margin. Wide layouts show a task sidebar and selected-task log preview; narrow layouts show the list until Enter/→ opens logs. Tab switches task/log focus; ← returns to task focus/list. `f` opens log-only view, and `i` toggles scrollable full task info instead of compact metadata.

The dock requires interactive TUI mode. RPC/print/non-UI callers get a message directing them to `/jobs`, `/logs`, `bg_status`, or `bg_logs`; no custom UI is opened. The task manager module is loaded lazily on dock use. While open, the focused overlay captures keyboard input and background processes continue; it is not a passive always-on panel.

Opening a finished task's logs or full info explicitly acknowledges that task's notice. Merely opening the list, selecting a task or seeing its wide log preview does not. Stop-all requires confirmation. Rerun starts a **new** execution, retaining reload opt-in but using current shell configuration, with notification on and automatic follow-up off. `c`/`C` displays the output path; it does not copy it.

Logs soft-wrap by default; `w` toggles no-wrap mode with Shift+Left/Right horizontal pan, `0` to reset and `$` to reach the last column. The UI is a bounded **128 KiB recent tail**, refreshed once per second while following, not full-file history. Scrolling up freezes the reservoir; reaching the bottom or `r`/`G` resumes follow. Resizing and wrap toggles preserve the paused source-log-line anchor. The **50 KiB tool/model log cap** and process runtime/reload mechanism are unchanged.

See [controls, footer and log limits](../reference/shortcuts-and-dock.md) for selection versus scrolling, oldest-retained-row navigation and the full task-info fields.
