---
{
  "doc_id": "commands/kill",
  "covers_sources": [],
  "covers_surfaces": [
    "command:kill"
  ]
}
---
# `/kill`

`/kill <task-id-or-unambiguous-prefix>`

Stops a running task and its tracked process tree. Unknown/ambiguous IDs and already-ended tasks fail. ID completion lists running tasks only. Output and metadata remain available.

POSIX uses the detached process group with SIGTERM then bounded SIGKILL escalation/proof. Windows uses `taskkill /T`, then `/T /F`, never root-only fallback. Unproven cleanup is a loud failure, not a successful kill. See [runtime safety](../subsystems/background-task-runtime.md) and [`bg_kill`](../tools/bg_kill.md).
