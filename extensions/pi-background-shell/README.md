# pi-background-shell

Private `pi-Serraly` workspace module, retaining the pure-shell fork of `pi-background-tasks`: named background processes, bounded logs, completion notifications, task UI, and opt-in **same-process** reload handoff. Development verification targets Pi **1.2.0**, TypeBox **1.3.27** and Node >=22.19.0; validation commands and platform limits are in [TESTING.md](TESTING.md).

This module owns background execution and its dock/renderers, independently of the UI module. The four `bg_*` tool cards use the shared `pi-ui-kit` card syntax through `src/ui/tool-cards.ts`, the one module the build bundles with that library inlined; task names, ids, output paths, byte counts, truncation and expanded logs stay this module's own display data. The `background-tasks` status and `background-task-notification` custom message remain stable. Installation and releases belong to the repository root documentation, not this module. Do not load the old fork or upstream together with this entry: names overlap, and the fork cannot adopt upstream processes. No global deployment is performed by module scripts.

## Interfaces

| Tools | Purpose |
| --- | --- |
| `bg_run` | Start a named shell command; return ID, PID and output path immediately. |
| `bg_status` | Inspect one task or running/recent tasks; unique ID prefixes accepted. |
| `bg_logs` | Bounded head/tail output, truncation notice and full output path. |
| `bg_kill` | Stop a running task/tree; unknown or ended tasks fail. |

`bg_status` lookup failures, including unknown or ambiguous task IDs, render a normal shared error card with the host's error text. Successful results retain the task count and status text, including an empty task list.

Commands: `/bg`, `/jobs`, `/logs`, `/kill`, `/tasks`, `/bg-tasks`, `/bg-clear`.

```text
/bg --name "Build" npm run build
/bg --survive-reload --name "Watcher" npm run watch
/jobs
/logs <id> 4096
/kill <id>
/tasks
```

`bg_run` defaults to notification **and** automatic follow-up; `/bg` defaults to notification without follow-up. After a tool launch, do independent work or end the turn—do not sleep/poll just to wait. With notification disabled, the trigger flag has no effect. See [completion delivery](docs/concepts/completion-delivery.md).

The TUI task dock supports fullscreen (Pi's default) and explicit regular mode (`"tuiMode": "regular"` or `--tui-mode regular`). It is a **centered floating panel**, using the full allocated width without a 118-column cap and adapting its height up to 80% of the terminal with a one-cell margin. Wide layouts pair a task sidebar with the selected task's log preview; narrow layouts start with the list, then Enter opens logs. `f` selects a log-only view; `i` toggles scrollable full task info, with compact metadata otherwise. The focused overlay captures keyboard input while background processes continue; it is not an always-on passive panel.

Logs soft-wrap by default; `w` toggles no-wrap mode, where Shift+Left/Right pans horizontally, `0` resets the pan and `$` goes to the last column. The UI follows a **128 KiB recent tail**, refreshed once per second: scrolling up freezes that reservoir, and reaching the bottom or `r`/`G` resumes follow. Wrapping does not provide full-file history or change the **50 KiB** tool/model log cap. See [dock controls and limits](docs/reference/shortcuts-and-dock.md) for task/log focus, scrolling and notice acknowledgement.

Stop, confirmed stop-all, rerun and output-path display remain available; `c`/`C` **displays** the path, not copies it. Dock shortcut: `PI_BG_DOCK_SHORTCUT=shift+down|ctrl+alt+b|off`; `/tasks` always remains available. Previewing a finished task in the sidebar does not acknowledge its notice; explicitly opening its logs or info does. `/bg-clear` acknowledges notices, **never deletes logs**. RPC/non-UI use status and logs instead of custom UI.

## Execution and limits

- Commands run with local permissions/environment, **not sandboxed**. Child text is never scanned or classified, including user-written `pi ...` commands.
- POSIX defaults to nonempty `SHELL`, otherwise `/bin/sh`, with `-c`. Explicit Bash/sh selection and validated paths are supported. Windows defaults to `ComSpec`/cmd; optional Bash selection is supported. See [shell configuration](docs/operations/configuration.md).
- Tool descriptions include the actual shell executable/args/syntax. No `promptSnippet`, `promptGuidelines`, or system-prompt injection.
- All four tools use `deferred` exposure in the `background-shell` namespace: registered but not declared, so the model loads them with `tool_search` (enable it with `"defaultTools": ["+tool_search"]`) or calls them from `codemode`. The slash commands, shortcuts and dock are unaffected and always available.
- Default output cap: **20 MiB** (`PI_BG_MAX_OUTPUT_BYTES` positive safe integer). Tool log reads: **50 KiB** maximum. Output/metadata live under `.pi/tasks/<session-id>-<host-pid>/`; pruning history does not delete files.
- Optional task timeouts accept 1–2,147,483 seconds, rounded down. Larger values fail instead of overflowing Node's timer and killing a task immediately.
- Metadata uses atomic fsync/rename. Output closes before terminal publication but has no power-loss tail guarantee.
- POSIX stops detached process groups; Windows uses `taskkill /T`, then `/T /F`. Unproven tree cleanup fails loudly.
- Reload normally kills tasks. `surviveReload:true` / `--survive-reload` keeps the **same** live child/PID/output path only across a supported same-process reload with the same session/cwd. No disk/PID adoption, restart/crash recovery or cross-session survival. SDK hosts need counted lifecycle bindings and awaited shutdown. See [runtime](docs/subsystems/background-task-runtime.md).

The fork removed delegation, Fusion, attested runs, Anthropic attribution, agent classification/usage telemetry, feature selection, and update checking; none is offered here. EventBus uses independent [fork v2](docs/api/eventbus-v2.md) channels/schema IDs.

[Documentation index](docs/INDEX.md) · [Testing](TESTING.md) · [Source provenance](UPSTREAM.md) · [ISC license](LICENSE)
