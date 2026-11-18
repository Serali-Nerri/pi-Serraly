# Pi Codex Guardian

Review pending Pi tool calls with Codex's bundled approval policy. Guardian reviews all calls by default; no rule file is required. Optional rules can block specific calls locally, or select calls for review when using rules-only mode. Native Pi and nested Code Mode and Notebook Mode calls share the same admission policy.

Guardian turns on when loaded. It requires Pi 1.5.0 or later and Node.js 22.19 or later. Reviews use the selected Codex Responses provider, endpoint, and Pi model-registry authentication, including gateway connections such as CPA. A current, intact parent response must have issued the action. Matching block calls never contact the reviewer and need no model or credentials. Code Mode and Notebook Mode additionally require Pi Codex Conversion 5.0.1 or later while guarding calls.

## Install

Prepare a separate installation workspace as described in [development](../../docs/development.md#本地安装工作区), then register this package with native Pi:

```sh
pi install ~/.pi/pi-Serraly/packages/pi-codex-guardian
```

Alternatively, enable the Guardian entry in the optional [pi-extensions](../pi-extensions/README.md) aggregate; do not register both. Registration takes effect on the next full Pi startup. No rules or authentication files are created.

Reviewed calls send selected parent evidence and the exact pending action to `codex-auto-review` through the selected connection. Parent reasoning and tool declarations are excluded. Installing alongside Conversion uses its currently registered provider automatically. Native Pi works without Conversion.

The bundled policy preserves Codex's risk levels, authorization scoring, and allow/deny thresholds, including its specific rules for sensitive egress, credential probing, security weakening, and destructive actions. Pi evidence and the tool-less execution environment are adapted explicitly. See [decision policy](PROTOCOL.md#bundled-decision-policy) for the source mapping. This does not reproduce Codex's sandbox or command-policy engine.

Parent observation runs while automatic review or review rules are enabled. Native parent-credit eligibility is a separate, narrower check; it does not decide whether a gateway can be asked for a review. See the [protocol mapping](PROTOCOL.md#native-parent-credit-eligibility) for that contract.

## Connection support

| Connection                                             | Local `block` rules | AI review                                              |
| ------------------------------------------------------ | ------------------- | ------------------------------------------------------ |
| Native ChatGPT Codex with configured authentication    | Supported           | Require a fresh, intact parent response                |
| Codex Responses through CPA or another custom endpoint | Supported           | Use the selected route; backend reviewer access needed |
| Other model APIs or missing authentication             | Supported           | Blocked as unavailable                                 |

The selected model must use `openai-codex-responses`, with configured authentication in Pi's model registry. Guardian keeps that provider and endpoint when selecting the reviewer model. It does not redirect gateway credentials to ChatGPT, read CPA account files, change `models.json`/`auth.json`, or fall back to an ordinary model. A provider name or JWT account claim alone does not establish native subscription credit eligibility.

CLIProxyAPI v8.0.69 includes `codex-auto-review` and Guardian-aware session affinity. Its upstream header forwarding, account selection, and payload transformations remain operator-owned. The [pinned source analysis](PROTOCOL.md#gateway-boundary-cliproxyapi-v8069) does not prove either live review success or failure. Use `/guardian status` to inspect local connection eligibility. Reviewer availability is backend-owned; Guardian makes no billing guarantee.

## Control

```text
/guardian status
/guardian on
/guardian off
/guardian reload
```

The setting persists in the selected session branch. New sessions default to on. `/guardian` without arguments shows status. Only the user command changes the setting. Guardian adds no agent tool or standing prompt.

Status shows the default action, loaded review and block counts, connection eligibility, whether nested preflight is available, and the last completed verdict. Eligibility is a local check, not a backend availability probe. With reviews enabled on an unsupported connection, the footer also shows `review unavailable`; those calls are blocked. Default review includes read-only calls and executable wrappers, so it adds reviewer requests even without rules. Review token counts are not charges. Guardian billing eligibility and per-review cost have not been established, so this package makes no zero-cost claim.

## Rules

Configuration is optional. Use either file:

- Global: `~/.pi/agent/pi-codex-guardian.json`, respecting `PI_CODING_AGENT_DIR`.
- Repo: `.pi/pi-codex-guardian.json` in the Pi session's working directory. Parent directories are not searched. Pi must trust the folder.

```json
{
	"defaultAction": "pass",
	"rules": [
		{
			"tool": "bash",
			"args": { "command": "\\brm\\b.*-rf" },
			"action": "block"
		},
		{
			"tool": "exec_command",
			"args": { "cmd": "\\brm\\b.*-rf" },
			"action": "block"
		}
	]
}
```

This rules-only example blocks native `bash` calls whose `command` matches the pattern and nested `exec_command` calls whose `cmd` matches it, without AI review. These are text patterns, not Codex's security policy or shell parsing. They do not identify every equivalent command or interpret command safety.

- `defaultAction` is `review` by default. Every call not blocked locally is reviewed, including calls with no matching rule. Use `pass` for rules-only mode: only matching `review` rules request AI review; unmatched calls pass without needing a parent. Both fields are optional; `rules` defaults to `[]`.
- An explicit `defaultAction: "review"` in either file wins over `pass`. Otherwise an explicit `pass` selects rules-only mode. With neither configured, the default is `review`.
- Existing rules-only configurations must add `defaultAction: "pass"` to retain their earlier scope. An empty rule list alone does not disable review. `/guardian off` disables admission checks for the session branch.

- `tool` is a literal tool name. No glob, regex, prefix, or category matching.
- Omit `args`, or use `{}`, to match every call to that tool.
- `args` keys are exact top-level argument properties. Values are JavaScript regex strings without flags or `/.../` delimiters. Matching uses substring search unless you add anchors.
- Every argument predicate in a rule must match. Missing, inherited, and non-string arguments do not match. Values are never coerced to strings.
- Any matching rule applies. `block` wins over `review` regardless of rule order or default action.
- Global and trusted repo rules add together. Repo rules cannot remove global restrictions.

Rules see prepared tool arguments. Supported aliases such as nested `exec_command`'s `command` are resolved to `cmd` before matching.

Default review covers `exec`, `wait`, and `notebook` wrappers and each nested call. With `defaultAction: "pass"`, an unmatched wrapper does not trigger an outer review; its nested calls still match their own rules. To review wrapper source in rules-only mode, add a rule such as `{ "tool": "exec", "action": "review" }`. Arbitrary wrapper code can perform effects without calling a nested tool.

Files load at session startup and through `/guardian reload`. Editing a file during a session does not change the active rules. Reload cancels pending matching and reviews. Invalid or unreadable configuration blocks actions while Guardian is on. Untrusted repo configuration is ignored. Revoking trust from loaded repo rules requires a reload before actions can continue. The former category configuration is not accepted.

Each file is limited to 64 KiB and 256 rules. Each regex is limited to 4,096 characters. Rules that cannot affect the decision are skipped: once review is certain, only potential block matches need evaluation. Remaining regex predicates run in isolated Node processes with a 32 MiB heap limit and a one-second deadline including startup. Each Guardian instance runs at most two matching processes; further requests wait in a cancellable FIFO queue. Queue time does not consume the process deadline. Argument strings sent to a process are limited to 1 MiB total per call, counting repeated predicates after pruning. Timeout, cancellation, memory exhaustion, or matching failure blocks that action rather than hanging Pi or silently passing it. Invalid regex syntax is reported when loading the file. If Pi runs on Bun, Node must also be available on `PATH`. Missing Node is reported in `/guardian status`, with no unbounded matching fallback.

## When an action is blocked

A denial, error, timeout, cancellation, malformed assessment, changed action, or stale parent stops that pending execution. Reviews have a 30-second deadline including queueing and authentication. They use Pi's transport setting, defaulting to `auto`; the selected provider owns WebSocket continuation and transport recovery. Guardian adds no inference retries or fallback model. The reviewer has no tools and never executes the candidate.

To clarify authorization after a denial, use a normal user message. Approval reported only in a tool result, including a wait-mode `ask` reply, is not treated as trusted user authorization; see [evidence mapping](PROTOCOL.md#bundled-decision-policy).

On an eligible connection, after installing, resuming, changing models, or navigating the session tree, request the action again so Guardian can observe a fresh parent response. Retrying does not make an unsupported connection eligible. If automatic review or any rules are enabled and nested preflight is unavailable, install or update Conversion before using Code Mode or Notebook Mode. In rules-only mode with zero rules, missing preflight does not block execution.

Guardian preserves all prepared user and system/developer text and the complete pending action. Optional assistant/tool evidence is bounded; parent reasoning and tool declarations are not sent. The complete review payload must fit within 96 KiB of UTF-8, or the smaller parent-context budget. Image, audio, file, opaque checkpoint, and referenced-history context is not supported. Start a shorter text-only session with complete authorization when mandatory evidence cannot fit. See [evidence and budgets](PROTOCOL.md#evidence-and-budgets) for exact limits.

## Boundaries

Guardian is an approval layer, not an operating-system sandbox. It reviews Pi tool calls and supported Conversion preflight calls. It does not intercept user shell commands, arbitrary extension side effects, already-running processes, or direct filesystem and network access outside those boundaries. A reviewed wrapper is not a blanket authorization for later nested actions.

Extensions remain trusted host code. Guardian captures the prepared parent request at Pi's provider hook. Later extensions that replace that payload or change admitted arguments are outside its guarantee. Session, tree, compaction, model, authorization, and shutdown changes cancel pending reviews. Old replies cannot authorize a changed action or context.

Normal tool yields and subsequent assistant/tool results on the same branch do not invalidate pending reviews. Context edits, summaries, injected instructions, and branch changes still reject an older assessment; see the [admission boundary](PROTOCOL.md#pi-admission-boundary).

Guardian retains an independent, serialized reviewer session while evidence remains append-compatible and within budget. Providers may send a full replay or a WebSocket delta; session reuse does not guarantee delta transport or reduced billing. Stable reviewer/parent identity is supplied in headers, while each action's turn metadata and genuine issuing parent response ID travel in the body. Final header handling depends on transport and provider; see the [protocol mapping](PROTOCOL.md#identity-and-transport-boundaries).

## Development

```sh
bun run build -- --package pi-codex-guardian
bun run check -- --package pi-codex-guardian
bun run test -- --package pi-codex-guardian
```

Guardian itself has no build step; the focused build prepares Conversion's public preflight export for development checks. See [UPSTREAM.md](UPSTREAM.md) for provenance and [CHANGELOG.local.md](CHANGELOG.local.md) for local history. Extension MIT licensing is retained in [LICENSE](LICENSE); Codex policy resources and the adapted template use [Apache-2.0](policy/LICENSE), with the upstream [NOTICE](policy/NOTICE).
