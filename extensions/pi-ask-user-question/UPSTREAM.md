# ask-user-question upstream

## Imported baseline

- Read-only source: [`juicesharp/rpiv-mono`](https://github.com/juicesharp/rpiv-mono)
  at commit `68d9a0014b70006d7b04b57933752338a2716db7`.
- `packages/rpiv-ask-user-question` version 2.12.0 (entry `index.ts` plus the
  `tool/`, `state/` and `view/` closures and the `locales/` dictionaries).
- Upstream development host: Pi 0.80.6, TypeBox 1.3.6. This module targets the
  workspace baseline Pi 1.2.0 / TypeBox 1.3.27.
- Upstream `LICENSE` (MIT, Copyright (c) 2026 juicesharp) is retained
  byte-for-byte as [LICENSE](./LICENSE).

## Deliberate deviations

1. **One model-facing description.** `guidance.description` is the only prompt
   field; `guidance.promptSnippet` and `guidance.promptGuidelines` and their
   built-in texts are removed. The default description is rewritten to state the
   when-to-use, option, reserved-label, batching and preview rules in one place,
   since the system prompt no longer repeats them.
2. **No localization layer.** The optional `@juicesharp/rpiv-i18n` peer, the
   loader hook and the nine `locales/` dictionaries are removed; all UI strings
   are inline English, which is also upstream's behavior when that SDK is not
   installed. The module registers no locale resources.
3. **No second config dependency.** `@juicesharp/rpiv-config` is replaced by the
   workspace's `pi-config-core` bounded reader plus this module's own field
   policy. Only `collapseKey` and `guidance.description` remain. The file moves
   from `$XDG_CONFIG_HOME/rpiv-ask-user-question/config.json` to the agent
   directory as `ask-user-question.json`, matching the other workspace modules.
4. **No event contract.** The `rpiv:ask-user:prompt` and `rpiv:ask-user:blocked`
   events and `events.ts` are removed; no workspace module consumes them.
5. **No lazy-load failure envelope.** Because the artifact is one sealed bundle,
   the jiti store-churn workarounds — `loadQuestionnaireSession()`, the
   `session_load_failed`/`stale_module_cache` results and the 2-second prewarm
   timer — are removed. Those two error codes are gone from the result type.
6. **Model-only, sequential execution.** Upstream registers a default `direct`
   tool with no execution mode and a guideline telling the model not to call it
   twice. This module sets `exposure: "model-only"` (declared to the model,
   never callable from codemode or nested calls — the documented Pi exposure for
   user-asking tools) and `executionMode: "sequential"`.
7. **Strip-only reconciliation.** Upstream re-added the tool whenever `hasUI`
   was true, overriding an operator's removal. The reconciler only strips it in
   no-UI runs and never re-adds it.
8. **Abort support.** The `AbortSignal` is threaded through both render paths:
   an abort cancels the open TUI session, kills a running external editor and is
   passed to the RPC dialogs. Upstream discarded the signal.
9. **Defensive collapse-key validation.** `resolveCollapseKey` now takes
   `unknown`: upstream's `config.collapseKey?.trim()` threw a `TypeError` for a
   valid-JSON non-string value, contradicting its own never-an-error contract.
10. **Repo-shaped layout and tests.** `src/` with the workspace's strict
    NodeNext/no-emit TypeScript boundary, a `test/` suite on `node:test`, inline
    English strings instead of the i18n bridge, and no upstream test-utility
    dependency.

Retained upstream behavior: the `ask_user_question` schema and limits, the
tabular dialog with tab/Submit pages, previews, per-question and global notes,
multi-select, the appended `Type something.`/`Next` rows, reserved-label
validation, line-terminator normalization, the result envelope and `details`
shape, the terminal BEL, the external-editor flow, the RPC `select`/`input`
walker with its documented parity trade-offs, and the raw terminal listener that
reopens a collapsed overlay.

## Not migrated

The `locales/` dictionaries, `@juicesharp/rpiv-i18n` integration, the
`rpiv:*` events, the lazy-load/prewarm machinery and the optional
`@juicesharp/rpiv-config` dependency.
