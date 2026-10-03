---
{
  "doc_id": "api/eventbus-v2",
  "covers_sources": [
    "src/core/extension-api.ts"
  ],
  "covers_surfaces": []
}
---
# EventBus v2

This fork keeps BG_* export names in `src/core/extension-api.ts` but intentionally breaks upstream v1 wire compatibility.

| Constant | Value |
| --- | --- |
| `BG_REQUEST_CHANNEL` | `pi-background-shell:request:v2` |
| `BG_RESPONSE_CHANNEL` | `pi-background-shell:response:v2` |
| `BG_TERMINAL_CHANNEL` | `pi-background-shell:terminal:v2` |
| `BG_REQUEST_SCHEMA` | `pi-background-shell.extension-request.v2` |
| `BG_RESPONSE_SCHEMA` | `pi-background-shell.extension-response.v2` |
| `BG_TERMINAL_SCHEMA` | `pi-background-shell.extension-terminal.v2` |

Request envelope is closed: `{ schema_version, request_id, operation, payload }`. Operations are `capabilities`, `run`, `status`, `logs`, `kill`. IDs must be nonempty and bounded; unknown keys/operations/schema versions fail. Responses echo the request ID/operation and contain `ok:true,result` or `ok:false,error`.

Capabilities have `api_version:2`, `run`, `run_completion_trigger`, `status`, `logs`, `logs_bounded`, `kill`; no `run_is_agent`.

| Operation | Payload |
| --- | --- |
| capabilities | `{}` |
| run | Required `name`, `command`, `notifyOnCompletion`, `triggerOnCompletion`; optional integer `timeoutSeconds` from 1 to 2,147,483. No description or surviveReload field. |
| status | Optional `taskId`; exact ID/unique prefix, or all retained tasks. |
| logs | Required `taskId`; optional positive-integer `maxBytes` (clamped to cap), boolean `tail` (default true). |
| kill | Required `taskId`. Unknown/ended tasks fail. |

```json
{
  "schema_version": "pi-background-shell.extension-request.v2",
  "request_id": "local-build-1",
  "operation": "run",
  "payload": {
    "name": "Build",
    "command": "npm run build",
    "notifyOnCompletion": true,
    "triggerOnCompletion": false
  }
}
```

Run response precedes related terminal EventBus delivery, including immediate spawn failure/exit. Terminal envelope is `{ schema_version: BG_TERMINAL_SCHEMA, task: <snapshot> }`. It follows output close and terminal metadata. Synchronous listener failure may deliver to earlier listeners before throwing: retries are at-least-once, so deduplicate by task ID. Publication budget/ledger remains task-owned across supported reload; closed services and stale gates do not publish.

The service is activation-local; requests require an initialized context. Closed/shutdown requests fail rather than starting work. Notifications and automatic follow-up are separate from EventBus publication. See [generated exact contract](../reference/runtime-contracts.md), [runtime](../subsystems/background-task-runtime.md) and [completion](../concepts/completion-delivery.md).
