---
{
  "doc_id": "commands/logs",
  "covers_sources": [],
  "covers_surfaces": [
    "command:logs"
  ]
}
---
# `/logs`

`/logs <task-id-or-unambiguous-prefix> [maxBytes]`

Reads the current tail, default/cap 50 KiB. The byte request is normalized to an integer in `[1, MAX_LOG_BYTES]`; invalid numbers use the default. Head reads are available with [`bg_logs`](../tools/bg_logs.md) and `tail:false`.

Truncation notices preserve the complete output path under `.pi/tasks/`. Reads are bounded, not a polling/wait primitive. Missing, unknown, or ambiguous IDs and missing files fail loudly. ID completion returns up to 20 matches.
