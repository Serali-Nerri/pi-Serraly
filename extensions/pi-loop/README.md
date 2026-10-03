# loop

Session-local, fixed-interval prompt repetition for Pi 1.0.0. The module owns
`/loop` and the `local-loop` status entry; it does not depend on the UI module.

```text
/loop 5m 检查部署是否完成
/loop 检查部署是否完成 every 2 hours
/loop 检查部署是否完成
/loop list
/loop stop <ID>
```

## Syntax

A leading integer plus `s`, `m`, `h`, or `d` sets the interval. Alternatively,
append `every <integer> <unit>`; units accept seconds/sec/secs, minutes/min/mins,
hours/hr/hrs, days, their singular forms, and `s/m/h/d` (case-insensitive).
Leading units must immediately follow the number; trailing units may be spaced.

Intervals must be positive and between one minute and 24 hours. Seconds are
rounded **up** to a whole minute and creation reports when rounding occurred.
Without a recognized interval the entire input is a prompt, using a fixed ten
minutes. An empty command shows usage; a recognized interval without a prompt
is rejected. This is Claude Code `/loop`’s fixed-interval subset, not cron or
Claude’s dynamically chosen default cadence.

## Scheduling and management

- Creation reports an eight-hex-character ID and immediately requests one turn
  if the agent is idle and no messages are queued.
- At most 50 jobs live in a session. `/loop list` shows IDs, intervals, next due
  times or waiting-for-idle state, and a shortened single-line prompt preview.
- `/loop stop <ID>` removes that job and its interval timer. It does not abort
  a turn that has already been sent to Pi.
- Due jobs wait while busy or while user messages are queued. Missed intervals
  coalesce into one pending execution per job, not a backlog of turns.
- Pending jobs are considered in creation order. `agent_settled`, **not**
  `agent_end`, is the lifecycle trigger to consider the next pending job.
- Intervals are based on creation/current due time, not completion time.
  After a delayed timer, the next interval starts from the current time.
- Jobs expire after seven days, including while busy. Expiry removes the job
  and does not dispatch a final prompt.
- `local-loop` displays `loops: N` while jobs exist, and is cleared when empty.

Only loaded `/skill:…` commands or prompt templates may be repeated with a
slash prefix; built-in TUI commands and other extension commands are rejected.
Such allowed prompts set `expandPromptTemplates: true`; ordinary prompts do
not. Each real execution can incur model costs and tool side effects.

## Lifecycle and limits

State is in memory only. Session start/replacement, shutdown, and reload clear
jobs; restoring a session does not reconstruct them. Cleanup is idempotent and
owns both job timers and the pre-agent-start delivery watchdog. Timers are
unreferenced so they do not keep an otherwise exiting process alive.

The watchdog releases the dispatch guard after five seconds if the session is
still idle and no `agent_start` was observed. It is cancelled when the agent
starts/settles or the session is cleared. Synchronous delivery errors propagate
through the command promise without permanently locking dispatch.

See [UPSTREAM.md](UPSTREAM.md) for provenance and deliberate adaptations.
Installation, building, validation safety, and release staging are root-package
responsibilities.
