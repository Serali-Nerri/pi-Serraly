---
{
  "doc_id": "subsystems/background-task-runtime",
  "covers_sources": [
    "src/core/common.ts",
    "src/core/durable-fs.ts",
    "src/core/registry.ts",
    "src/core/reload-shell-owner.ts",
    "src/core/task-durable.ts",
    "src/core/windows-taskkill.ts"
  ],
  "covers_surfaces": []
}
---
# Background task runtime

The existing registry owns named shell processes, task resolution, bounded logs, termination and completion. Commands run in the current cwd/environment with local permissions: **not sandboxed**. No command inspection, model routing, authentication, or Pi JSON wrapping is performed. Stdout/stderr are logged raw, including control-looking or JSON-looking lines.

## Status, storage and bounds

States are `running`, `completed`, `failed`, `killed`. Zero exit completes; nonzero/spawn error/timeout/output overflow fails; user/shutdown stop normally kills. Resolution accepts exact IDs or unique prefixes and rejects unknown/ambiguous IDs. Killing an ended task fails.

Storage is `.pi/tasks/<session-id>-<host-pid>/<task-id>.output` and `.json`. Metadata uses atomic durable replacement (fsync/rename); ordinary output closes and waits for finish/close, with **no power-loss guarantee for its tail**. Logs are not deleted by in-memory pruning or `/bg-clear`.

Output defaults to 20 MiB; exceeding the cap kills/fails the task and records a diagnostic. Tool head/tail reads default/cap 50 KiB, with a truncation notice and full output path. UI has its own bounded tail reservoir. Recent finished retention is bounded at 100; running work is preserved. Old pending terminal publication cannot retain unbounded history.

## Admission and finalization

Shutdown closes admissions synchronously. In-flight starts are aborted/drained before the running snapshot is stopped; no late insertion escapes ownership. Only admission-committed live executions can transfer. Initial/terminal metadata errors and real output-stream close failures are surfaced.

Finalization closes output, writes terminal metadata, settles waiters and begins terminal publication/notification. Publication is independent from notification receipts. Its three-attempt listener-failure budget and pending/delivered/abandoned ledger survive reload; physical retries/gates do not keep the old activation alive. Reentrant emitter settlement cannot become contradictory delivered-and-abandoned truth. See [completion](../concepts/completion-delivery.md) and [EventBus](../api/eventbus-v2.md).

## Process-tree stopping

POSIX captures the detached process-group ID at spawn, sends SIGTERM (child-handle fallback if the group signal fails), and escalates at most once with SIGKILL after grace. Direct-child close is insufficient: the originally owned group must be observed absent before cleanup is claimed. Concurrent stops share escalation/proof. Force/proof uncertainty fails loudly with `Descendant processes may have leaked`; no fabricated successful cleanup or restored-PID signaling.

Windows uses `%SystemRoot%` (or `%WINDIR%`) `System32/taskkill.exe /PID <pid> /T`, then `/T /F` after grace. The soft helper is aborted on force; exit 128 tolerates the already-exited race. Helpers use structured argv, `shell:false`, bounded diagnostics and deadlines. Force errors are loud; there is no root-only `child.kill` fallback. Real Windows behavior requires the Windows suite; Linux mocks do not qualify it.

## Same-process reload, not recovery

Default reload stops tasks. `bg_run(..., surviveReload:true)` or `/bg --survive-reload ...` retains the **same** live child, ID/PID/output path, streams, absolute timeout, cumulative byte count/output cap and completion latch during a supported real reload with exact session ID and canonical cwd. All command text is treated alike, including a user-launched Pi CLI. New tasks use the fresh shell policy; surviving tasks keep the old one.

Ownership lives under `Symbol.for('pi-background-shell.reload-shell-owner.v1')`, with matching protocol, structurally checked methods and two-phase claim/commit. Audit metadata uses `pi-background-shell.reload-shell.v1`. The fixed 30-second handoff deadline is not extended by claim abort. Host closures detach synchronously; terminal work during the gap queues for the new adapter. No claimant (including extension removal/load failure) causes bounded retained-tree cleanup and loud expiry. Late terminal settlement releases minimal retained authority; a cleanup timeout does not invent process death.

No disk scan, PID/JSON adoption, daemon, cross-process restart/crash/power-loss recovery, or new/resume/fork/clone/quit survival. The fork cannot claim upstream executions. Stop upstream work before switching and do not load both packages together.

See [extension lifecycle](extension-lifecycle.md) for the supported SDK boundary and [configuration](../operations/configuration.md).
