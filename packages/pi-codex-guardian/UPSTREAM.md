# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/c3b422c60256907f5a4499cc44e4d055ac3cc28a/packages/pi-codex-guardian
- Baseline version: 0.0.1
- Upstream history and license: CHANGELOG.md and LICENSE are retained unchanged.
- The Codex protocol reference and CPA compatibility baseline are pinned in [PROTOCOL.md](PROTOCOL.md).
- The earlier Codex reference `822e58cc3d` resolves to [`822e58cc3d666166c7446c5b1ea2e52f5d09594c`](https://github.com/openai/codex/commit/822e58cc3d666166c7446c5b1ea2e52f5d09594c); the current alignment uses the researched official revision `5943d7acdf01b293c950397844dd37aa70779df4`.

## Bundled Codex policy

Source: [`openai/codex` at `5943d7acdf01b293c950397844dd37aa70779df4`](https://github.com/openai/codex/tree/5943d7acdf01b293c950397844dd37aa70779df4).

| Local path         | Upstream path                                            | Treatment                                                                                                                                         |
| ------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/policy.ts`    | `codex-rs/prompts/templates/guardian/policy_template.md` | Adapted to Pi evidence, no reviewer tools or assumed sandbox, and JSON output; authorization scoring, risk taxonomy, and outcome policy unchanged |
| `policy/policy.md` | `codex-rs/prompts/templates/guardian/policy.md`          | Unchanged default security policy                                                                                                                 |
| `policy/LICENSE`   | `LICENSE`                                                | Unchanged Apache-2.0 license                                                                                                                      |
| `policy/NOTICE`    | `NOTICE`                                                 | Unchanged upstream notice                                                                                                                         |

These files are distributed with the package. `src/policy.ts` carries its modification notice; the extension's original MIT license remains unchanged. Policy behavior and Pi mappings belong to [PROTOCOL.md](PROTOCOL.md#bundled-decision-policy).

## Current local differences

- package.json removes npm packing/publishing configuration and ships provenance and local history. The optional local aggregate forwards this package's public entry.
- `src/parents.ts` separates selected-route review availability from native parent-credit eligibility. Status and unavailable-review messages use that decision; gateway reviews retain the selected provider, endpoint, and model-registry authentication.
- `src/evidence.ts` projects the prepared request into exact mandatory authorization and bounded optional assistant/tool evidence, excluding parent reasoning and tool declarations.
- `src/review.ts` retains a serialized, append-compatible reviewer session and raw reviewer responses within a full-request budget. Public Pi transport hooks own continuation and recovery; resets use public session-resource cleanup. `src/wire.ts` keeps session/parent headers stable and per-action turn attribution in the body.
- `src/policy.ts` and `policy/` replace the short approval prompt with the pinned Codex default policy. `src/scope.ts` defaults unmatched calls to review; explicit `defaultAction: "pass"` retains rules-only scope, with local block precedence unchanged.
- `src/branch.ts` distinguishes normal result appends from context changes during admission; parent membership caches are leaf-scoped. `src/response.ts` validates both supported successful terminal aliases. The matcher prunes redundant rules and limits concurrent Node processes. Focused regression tests cover these boundaries.
- README documents installation, rules, connection availability, and billing boundaries. PROTOCOL owns evidence, session, transport, native-alignment, and CPA forwarding boundaries. AGENTS.md records fragile admission and invalidation ordering.

Explicit rules, genuine parent binding, cancellation, and fail-closed behavior are retained. No gateway configuration, fallback model, reviewer tools, shell-policy parser, or OS sandbox is added. Source alignment is not live acceptance or proof of billing treatment. Usage belongs to [README.md](README.md); local history belongs to [CHANGELOG.local.md](CHANGELOG.local.md).
