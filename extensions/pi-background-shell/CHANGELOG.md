# Changelog

## Workspace import

- Imported the clean local pure-shell fork at `86c52d3b5d9f9ab92b843868293495d17ec5d878` into private `pi-Serraly` as `modules/background-shell`, retaining business source, full tests and ISC provenance.
- Development verification targets Pi 1.2.0 and TypeBox 1.3.27; workspace scripts isolate HOME/agent/cwd and resolve hoisted development dependencies.
- Kept tsc runtime closure and lazy UI; root scripts own installation and release staging. CHANGELOG now ships with the module payload so provenance links remain valid. No global deployment or new runtime contract.
- The four `bg_*` tool cards use the shared `pi-ui-kit` header/status syntax. `src/ui/tool-cards.ts` is a stateless display leaf: it is the only module importing that library, the only one the build bundles (kit inlined, host peers external, multi-source map, library licenses copied), and it keeps task names, ids, output paths, byte counts, truncation and expanded logs as this module's own display data.

## 0.1.0

Forked from [`pi-background-tasks@2.6.8`](https://www.npmjs.com/package/pi-background-tasks/v/2.6.8),
commit [`471f1dc`](https://github.com/ismailsaleekh/pi-background-tasks/commit/471f1dcae7ff13d8f989e4c056bdff1e6b01f1ef).
The baseline npm source, entry and dist matched that commit; provenance in [UPSTREAM.md](UPSTREAM.md).

### Removed

- Delegate, Fusion and attested Pi runs, with their tools, commands, renderers, docs and tests.
- Anthropic attribution and its child extensions.
- Agent classification: `isAgent`, `--agent`, `--llm-agent`, `--script`, `--no-agent`, and the EventBus `run_is_agent` field.
- Pi usage telemetry: launch wrapping, JSON/control-line parsing, model/context/token/tool accounting, and update checking.
- `promptSnippet`, `promptGuidelines` and every system-prompt hook. Model guidance lives only in tool and parameter descriptions.

### Retained

- Tools `bg_run`, `bg_status`, `bg_logs`, `bg_kill`; commands `/bg`, `/jobs`, `/logs`, `/kill`, `/tasks`, `/bg-tasks`, `/bg-clear`; dock and shortcuts.
- Task states `running`/`completed`/`failed`/`killed`, bounded output and log reads, durable metadata, POSIX process-group and Windows `taskkill` termination.
- Completion notification with optional follow-up turn, task UI with rerun/stop-all/log follow, and opt-in same-process reload survival.
- A standalone EventBus v2 and this fork's own reload owner identity. Upstream v1 clients are not compatible.

### Changed

- The task manager uses a centered responsive floating panel, with a wide task sidebar/log preview and narrow list/detail layouts. Logs soft-wrap by default with optional horizontal pan; paused source-line/column anchors survive resize and reflow, and full task info is scrollable.
- Task selection, displayed logs and action targets stay aligned after rerun or completion. Log display strips terminal controls without modifying output files; the 128 KiB UI tail, 50 KiB tool/model log cap and process/reload ownership remain unchanged.
- All four tools use `codemode` exposure in the `background-shell` namespace: callable from scripts without discovery activation, but not directly declared by default. Commands, shortcuts and the dock are unaffected.
- Task timeouts are validated to 1–2,147,483 seconds so a Node timer cannot overflow into an immediate kill; output caps must be positive safe integers.
- Completion notifications report task facts only; the `<guidance>` instruction block was removed.
- Non-stale UI render failures are reported and isolated from child ownership instead of failing an admitted task.
