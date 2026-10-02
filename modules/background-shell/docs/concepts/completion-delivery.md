---
{
  "doc_id": "concepts/completion-delivery",
  "covers_sources": [],
  "covers_surfaces": [
    "renderer:background-task-notification"
  ]
}
---
# Completion delivery

| Surface | Notify default | Trigger follow-up default |
| --- | --- | --- |
| `bg_run` | true | true |
| `/bg` and dock rerun | true | false |

Notification-disabled work cannot wake a follow-up turn: `triggerOnCompletion` has no effect when `notifyOnCompletion:false`. EventBus requires both flags explicitly.

After default `bg_run`, continue independent useful work or acknowledge and end the turn. Do not sleep, poll status, or repeatedly read logs merely to wait. On `<background-task-notification>`, status is already terminal; read logs only if output bytes are needed.

The custom message includes task ID/name, status, exit code/error when available, summary and output path. Task details contain delivery facts. Output has closed and terminal metadata has been written before publication; ordinary output bytes are not fsynced. Completion delivery is not system-prompt injection.

Notification receipt and EventBus delivery are separate. EventBus delivery can be pending, delivered or abandoned without rewriting durable status. Failed send is logged rather than reported as delivered. Ordinary shutdown suppresses notifications; opted reload survivors retain their delivery latch and queue terminal work during the hostless gap. A successful send is not duplicated on reload. EventBus listener failures can deliver at least once; consumers deduplicate by task ID.

See [runtime lifecycle](../subsystems/background-task-runtime.md) and [EventBus](../api/eventbus-v2.md).
