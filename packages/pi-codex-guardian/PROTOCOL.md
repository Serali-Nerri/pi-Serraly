# Codex Guardian protocol mapping

This adapter maps Codex Guardian concepts onto public Pi provider APIs; it is not the Codex Rust runtime. The researched official reference is [`openai/codex` at `5943d7acdf01b293c950397844dd37aa70779df4`](https://github.com/openai/codex/tree/5943d7acdf01b293c950397844dd37aa70779df4/codex-rs). Provenance belongs to [UPSTREAM.md](UPSTREAM.md); configuration and commands belong to [README.md](README.md).

## Bundled decision policy

The reviewer uses Codex's bundled default policy, not the former short approval prompt:

- [src/policy.ts](src/policy.ts) derives from `codex-rs/prompts/templates/guardian/policy_template.md`. User Authorization Scoring, Base Risk Taxonomy, and Outcome Policy are preserved. Evidence handling maps to Pi's prepared `parent_context` and exact `pending_action`; investigation and execution-environment statements reflect a tool-less reviewer without an assumed OS sandbox. JSON-only response instructions match the assessment schema.
- [policy/policy.md](policy/policy.md) is the unchanged upstream `codex-rs/prompts/templates/guardian/policy.md`, used for the template's default security policy. No tenant-specific or extra policy is configured.

The template's trusted evidence maps to prepared user and system/developer content. Arbitrary tool-result claims of human approval are not promoted to trusted user authorization; this adapter has no native `request_user_input` attestation. This includes wait-mode `ask` replies that appear only as tool results: a normal user message is needed to establish approval. Read-only investigation in the policy means considering evidence already present, not executing reviewer tools. Missing state can therefore prevent an approval that native Codex could resolve with inspection.

Policy resources are bundled and loaded locally; they are not fetched at runtime. The default admission scope is all Pi tool calls, not Codex's sandbox escalation/execpolicy selection. It includes wrapper source and nested calls separately. Optional JSON rules change local admission scope or force blocking; they do not replace the reviewer's security policy. See [configuration](README.md#rules).

## Selected route and parent linkage

Review availability requires a selected `openai-codex-responses` model and configured authentication in Pi's model registry. The reviewer keeps the parent's provider and base URL, changes only the model identity to `codex-auto-review`, and obtains authentication through `modelRegistry.streamSimple`. This includes custom endpoints such as CPA. Gateway credentials are not redirected to the official ChatGPT endpoint. Local eligibility is not proof that a backend exposes the reviewer model.

Parent evidence comes from the prepared provider request, not reconstructed session history. Provider observers see raw events before normalization. Both parent binding and reviewer completion accept `response.completed` or `response.done` only with an explicit `status=completed` and valid response ID; missing status, failed, cancelled, and incomplete responses do not establish success. The observed parent ID must agree with the completed Pi assistant message that issued the tool call. Bindings stay on the selected session branch and model/provider/endpoint. Restored response IDs alone cannot authorize an action.

The issuing response ID goes only in `client_metadata.parent_response_id`. It is not `previous_response_id`: any transport continuation must use the reviewer's own previous response. The prompt cache key is `guardian:<parent-session-id>`; reviewer transport identity is separate from parent affinity.

## Native parent-credit eligibility

Requesting an assessment and requesting native parent credits are separate decisions. Credit eligibility additionally requires:

- Both model and effective provider base URLs normalize to the canonical ChatGPT Codex endpoint. Accepted bases are `https://chatgpt.com/backend-api`, that URL plus `/codex`, or plus `/codex/responses`.
- Pi selects stored subscription OAuth. An API-key handler, runtime credential source, legacy OAuth override, or legacy stream override does not qualify. Native provider registrations such as Conversion can qualify without those overrides.
- The ordinary parent is neither `codex-auto-review` nor marked `x-openai-subagent=guardian`.

While automatic review or explicit review rules are enabled, eligible ordinary requests receive `client_metadata.guardian_credits_requested="true"`. Stale credit and parent-response attribution is removed first. With `defaultAction: "pass"` and no review rules, Guardian neither observes parents nor requests credits. Reviewer requests never request parent credits. Provider names and JWT claims do not establish subscription eligibility; these predicates do not reveal the backend's billing decision.

## Evidence and budgets

The projection retains prepared `instructions`, system/developer constraints, configuration updates (such as reasoning-level changes), and genuine user text without shortening them. Assistant text and function/custom-tool calls and results are optional evidence, not authorization. Parent reasoning, `additional_tools`, and tool declarations are excluded. Opaque checkpoints, item references, unsupported modalities, or a parent request relying on `previous_response_id` cannot be projected intact and fail closed.

| Evidence                                                | UTF-8 text budget                                                                  |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| User text, system/developer constraints, pending action | Exact; never truncated to fit                                                      |
| Optional assistant/tool items                           | Up to 40 combined, newest first within these budgets; restored to transcript order |
| Assistant text                                          | 5,000 bytes per item; 20,000 bytes total                                           |
| Tool calls/results                                      | 1,000 bytes per item; 10,000 bytes total                                           |

Truncation is marked per item and omitted optional items are counted. The fully framed JSON request, including escaped evidence, policy, schema, action, metadata, and retained reviewer history, must fit `min(96 * 1024, parent.contextWindow - 2048)` UTF-8 bytes. The context-window count is used conservatively as a byte bound. If replay exceeds this budget, Guardian starts a fresh snapshot, then removes oldest optional items as needed. If mandatory evidence and the exact action still cannot fit, the action is blocked rather than shortening authorization.

## Reviewer session and body

One independent reviewer lane serializes reviews. The first request carries an evidence snapshot and exact `pending_action`; compatible later requests append only new evidence and their action. Compatibility requires the same parent session and model, identical instructions, and an unchanged evidence prefix. Successful assessments retain the raw completed reviewer response items, including reasoning items, within the replay budget. Prior assessments never authorize a different action.

Incompatible evidence or exhausted history budget starts a fresh snapshot; an active request failure clears the lane. Session/tree/fork/compaction/model changes and Guardian on/off/reload also reset it. Reset calls Pi's public `cleanupSessionResources` for the reviewer session. New turns and incoming user/system/custom messages invalidate current parent bindings and pending reviews without discarding an otherwise reusable reviewer lane.

The body is constructed independently of parent generation settings: `model=codex-auto-review`, `store=false`, `stream=true`, `reasoning.effort=low`, and `include=["reasoning.encrypted_content"]`. It sets `tools=[]`, `tool_choice=none`, and `parallel_tool_calls=false`. No output-token override, service tier, or arbitrary parent payload fields are inherited. There is no fallback model or reviewer tool execution.

The assessment format is `json_schema`, named `codex_output_schema`, with `strict=false`. It requires `outcome` and permits risk level, user authorization, and rationale. A denial, malformed result, error, cancellation, timeout, stale parent, or changed action blocks execution. The 30-second deadline includes queueing and authentication; Guardian requests zero inference retries.

## Identity and transport boundaries

Transport comes from `pi.getSettings().transport`, defaulting to `auto`. Guardian supplies a bounded full replay through public `onPayload` and header options. The selected provider owns sockets, delta selection, `previous_response_id`, and transport recovery; Guardian implements no custom socket or byte-level WebSocket interception.

Native Pi 1.5.2 compares non-input body fields including `client_metadata` when deciding continuation. Changing per-action metadata can therefore cause full replay even on a reused socket. Conversion currently excludes `client_metadata` from that comparison and can continue from the reviewer's own previous response ID. Reuse does not promise delta transmission for every provider, fewer billed tokens, or zero cost.

| Field family                  | Guardian-supplied state                                                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reviewer identity             | `x-codex-guardian=reviewer`, `x-openai-subagent=guardian`; the latter also appears in body metadata                                                                                                                            |
| Stable session/parent headers | Adapter-owned reviewer `session-id`, `thread-id`, `x-client-request-id`, `x-codex-window-id=<reviewer-session>:0`, and `x-codex-parent-thread-id` for the real Pi parent session                                               |
| Per-action metadata           | Fresh `turn_id`, turn environment, and actual `parent_response_id` in the body only; `x-codex-turn-metadata` is deliberately removed from headers so changing actions do not change socket identity                            |
| Harness identity              | Requests `originator=codex_cli_rs` and an OS/architecture-aware `codex_cli_rs ... pi-codex-guardian` User-Agent; does not invent a Rust runtime version                                                                        |
| Environment                   | Reports Pi's lack of a Codex sandbox (`sandbox=none`, `sandbox_mode=danger-full-access`), no REPL, recursive review, history ingestion, or analytics; invents no installation ID or ancestry                                   |
| Inherited claims              | Removes stale routing/turn state, response-session affinity, Lite/feature, attestation, installation, memory-generation, and tracing claims; omits service tier. A real configured residency header is not invented or removed |

For SSE, the final fetch wrapper checks the selected effective endpoint and POST method, bounds and decodes plain/zstd bodies, and compares the entire body against the action-bound payload. It reapplies Guardian headers, JSON/SSE content headers, and disables redirects before fetching. Authentication headers remain provider-owned.

For WebSockets, only public payload and header hooks are available here, not a final frame/handshake interception. The provider may add transport-required headers or override identity fields: Conversion currently supplies its own User-Agent and configured originator. Stable Guardian session/parent headers and body turn metadata are intentional, but a final wire-byte parity claim would exceed this boundary. Loaded providers and extensions remain trusted host code.

## Gateway boundary (CLIProxyAPI v8.0.69)

The source baseline is [CLIProxyAPI v8.0.69 at `f7ae8feeb3710319f524730849fbe32fde1751e4`](https://github.com/router-for-me/CLIProxyAPI/tree/f7ae8feeb3710319f524730849fbe32fde1751e4). Source analysis identifies forwarding boundaries; it does not establish live AI review success, failure, or billing. Guardian can submit reviews through this selected route without reading CPA account files or adding a separate reviewer connection.

- The [model catalog](https://github.com/router-for-me/CLIProxyAPI/blob/f7ae8feeb3710319f524730849fbe32fde1751e4/internal/registry/models/models.json#L2956-L2986) includes `codex-auto-review`. The [selector](https://github.com/router-for-me/CLIProxyAPI/blob/f7ae8feeb3710319f524730849fbe32fde1751e4/sdk/cliproxy/auth/selector.go#L1749-L1769) supports conditional Guardian parent-account affinity, not an unconditional issuing-account binding or reviewer-access guarantee.
- CPA replaces gateway authentication with a selected upstream account. Default [HTTP header construction](https://github.com/router-for-me/CLIProxyAPI/blob/f7ae8feeb3710319f524730849fbe32fde1751e4/internal/runtime/executor/codex_executor_request.go#L513-L622) does not forward all Guardian identity, parent-thread, or residency headers. Upstream forwarding and account policy remain the operator's responsibility, beyond Pi's final checks.
- The [stream request path](https://github.com/router-for-me/CLIProxyAPI/blob/f7ae8feeb3710319f524730849fbe32fde1751e4/internal/runtime/executor/codex_executor_stream.go#L81-L118) can transform the body after Pi. Image-tool injection and empty-tool normalization can change the tool-less payload. CPA's image passthrough setting prevents automatic image-tool injection without disabling explicit Images API requests; this package does not configure gateway policy.
- The [response translator](https://github.com/router-for-me/CLIProxyAPI/blob/f7ae8feeb3710319f524730849fbe32fde1751e4/internal/translator/codex/openai/responses/codex_openai-responses_response.go#L15-L39) retains upstream response events. HTTP removes top-level `previous_response_id`, not `client_metadata.parent_response_id`. Metadata passthrough is not native credit eligibility or a billing guarantee.

Local block rules do not depend on gateway forwarding or reviewer access.

## Deliberate differences from native Codex

Official Codex retains a reusable per-parent reviewer trunk, can fork committed snapshots for concurrent reviews, and advances a transcript cursor for deltas. Its WebSocket continuation uses the reviewer's own response history, not the issuing parent's response ID. It can resolve reviewer models with parent-model fallback and expose restricted read-only tools; its context budgeting can be elastic.

This adapter instead has one serialized lane, fixed `codex-auto-review`, no tools or fallback model, and default review of all Pi tool calls with optional local scope rules rather than Codex sandbox escalation. Its mandatory prepared authorization is never trimmed to fit. The bundled decision policy is reused with the Pi mappings described above; shared policy and protocol concepts do not imply full runtime parity.

## Pi admission boundary

Native tool calls and supported nested preflight calls share one decision owner; [README rules](README.md#rules) define matching and the default action. Local block decisions resolve before parent lookup or reviewer authentication. In rules-only mode, an unmatched wrapper retains a genuine parent binding when available so its later nested calls can be reviewed. Wrapper source is reviewed by default, or when its own review rule matches. Missing nested preflight blocks wrappers when automatic review or any rules are enabled.

Configured regexes execute in a bounded disposable Node process, never on Pi's event loop. Matching failures and unavailable Node fail closed. Revision, authorization, session, action, and trust checks reject stale matcher decisions and reviewer replies before admission. Rule files are startup or explicit-reload snapshots.

The session leaf is not itself an authorization version. The parent binding is anchored at the leaf where its request evidence was prepared, so context changes before a delayed nested call also invalidate that binding. During rule matching or review, the captured leaf must remain an ancestor and intervening entries must be ordinary assistant/tool results or non-model metadata (`custom`, `usage`, `label`, `session_info`). This permits normal yields and collection of their results. User/system/custom messages, context edits, compaction, branch summaries, and other entry types invalidate the pending decision. Boundary-appended edits are checked explicitly because Pi need not emit message or compaction extension events for them.

Parent branch-membership checks cache only the most recent leaf and result on each live parent binding. Calls on a new leaf are checked again; clearing the bindings releases their caches. Unmatched wrappers still propagate parent bindings for later nested calls.
