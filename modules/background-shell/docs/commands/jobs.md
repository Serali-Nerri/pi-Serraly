---
{
  "doc_id": "commands/jobs",
  "covers_sources": [],
  "covers_surfaces": [
    "command:jobs"
  ]
}
---
# `/jobs`

Lists in-memory running and recent tasks: ID, name, status, age, PID/exit code when available, error and output path. Statuses are `running`, `completed`, `failed`, `killed`. This is a point-in-time snapshot, not a wait operation.

Finished-task retention is bounded; running tasks are preserved. Pruning does not delete disk logs. Use [logs](logs.md), [kill](kill.md), or [task UI](task-manager.md).
