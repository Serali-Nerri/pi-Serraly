# Local changes

## Unreleased

- Preserve pending admission across normal same-branch tool yields and results, while rejecting context edits, injected authorization, summaries, and branch changes. Cache repeated parent membership checks per leaf.
- Accept successful raw `response.done` and `response.completed` events consistently for parent binding and review, retaining explicit status and final-result validation.
- Skip redundant review regexes once review is certain, retain block precedence, and cap matching at two disposable Node processes with cancellable FIFO queueing.
- Add requested regression tests for yielded admission, terminal aliases, rule pruning, process scheduling/cancellation, and branch caching.
- Reuse the official Codex default security policy and approval template, adapting only Pi evidence, reviewer capabilities, and JSON output. Bundle its Apache-2.0 license and notice.
- Review all tool calls by default without requiring a rule file. Add optional `defaultAction: "pass"` for rules-only scope; preserve local block precedence and document migration from explicit-only rules.
- Import upstream Guardian 0.0.1 as an independent workspace package and optional aggregate entry.
- Separate selected Codex provider/gateway review availability from native parent-credit eligibility; use Pi model-registry authentication without redirecting gateway credentials.
- Project prepared parent evidence with exact user/system/developer text and action, bounded optional assistant/tool evidence, and no parent reasoning or tool declarations.
- Retain a serialized reviewer session with evidence appends, raw reviewer response history, bounded full replay, Pi-selected transport, and public session cleanup. Keep socket headers stable and per-action turn metadata in the body; providers own WebSocket deltas and recovery.
- Preserve reasoning-level configuration updates in evidence and compare SSE bodies structurally after provider serialization.
- Document alignment with official Codex `5943d7acdf01b293c950397844dd37aa70779df4`, CLIProxyAPI v8.0.69 forwarding boundaries, and local installation.
- Validate with released Pi 1.5.2 and CPA in an isolated Docker Sandbox: real consecutive TUI tool turns, local blocking, reviewer WebSocket deltas, full replay after connection loss followed by new-response continuation, and SSE review. Billing and upstream-header transparency are not established by this acceptance.
