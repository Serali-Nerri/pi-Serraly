# Local changelog

Local changes and their background, relative to upstream **5.0.1** (`4006488d10e01b7da55c3ebac5b0a7913005ba00`). [UPSTREAM.md](./UPSTREAM.md) lists current local differences; [CHANGELOG.md](./CHANGELOG.md) retains upstream release history. The package version tracks the upstream baseline, not local revisions.

## Upstream 5.0.2 sync

- Move the host dependency line to Pi 1.6.0 and adopt the upstream Responses Lite image limits/cache, retry-after handling, transport/session continuity, tool-discovery guidance and bundled QuickJS runtime resolution. Retain local Notes ownership, voice/controller integration, native helper provenance and Code/Notebook rendering expansion.

## Upstream 5.0.1 sync

- Add conversation-local VM Code alongside the existing runtimes, GPT-6.2 Sol/Astra and pricing, instruction-change diagnostics and shorter tool guidance. Restore Acorn for VM parsing; keep the official Code host and nested Codex source pins unchanged.
- Adopt tsrs 0.25 and upstream Oxfmt/Oxlint static checks through the existing isolated workspace runners. Keep tests separate from static checks and omit upstream publication and browser-CDP sync hooks.
- Replace duplicated image rendering with upstream's shared media renderer, occurrence-count deduplication and row-owned UI caches. Retain independent click expansion, nested image-view title/error-only cards and scalar-only auxiliary render state. Updates lacking a trace snapshot retain current row caches.
- Keep local frame/checkpoint/image/transport/shell performance adaptations and native patch-summary/concurrent-read behavior. Preserve all six locally rebuilt patch and exec helpers with their original provenance; adopt upstream view-image binaries. Keep offline startup, inactive defaults, aborted-run guards, voice gateways, standalone Notes ownership and installation boundaries.
- Use the new upstream VM tests as disposable offline probes; do not add permanent coverage. Omit the image benchmark's absent-package/private-source coupling rather than expanding the workspace or public interfaces.

## Background shell completion delivery

- Deliver uncollected completions after normal tool results at completed turn boundaries, so the current run can use them instead of waiting for an idle wake. Keep the existing idle fallback, abort handling, batching and truncation behavior.

## Performance and resource retention

- Assemble fragmented Code host responses once per frame instead of recopying the entire pending payload on each stdout chunk. Preserve frame limits and release pending fragments on teardown.
- TS checkpoints avoid materialising typed-array index keys while preserving large-view checkpoints, aliases and extra-property rejection. Validation uses a temporary local Node inspector session, without opening a listener.
- Nested trace capture stops at either serialization budget; streamed and final snapshots retain status and result metadata without expanding omitted array tails.
- Reclaim closed and superseded Codex WebSocket routes without interrupting busy lanes or clearing native-compaction history. Reuse unchanged Responses Lite image normalization in a bounded cache; process images through cancellation-aware request-local pools.
- Detach completed shell replay tails from full command output, preserving UTF-16 content and immediate-result delivery.
- Let native shell reads wait concurrently across processes while preserving per-process sequence/decoding order and ordered mutations. Silent shells no longer block other output; no host polling sleeps are needed. Rebuild patch and exec helpers for all six bundled targets.
- Request summary-only native patch responses rather than copying full old/new file contents into an unused payload. Detailed helper consumers retain their existing response mode; explicit cross-target builds record the actual compiler host and artifact target.
- Auxiliary tool result cards retain only current error/image-display flags rather than the host render context, so Notebook and auto-reasoning redraws no longer retain previous components. Rendering and tool results are unchanged.

## Browser extension removal

- Remove the pi-browser runtime dependency and `/codex voice server connect` integration when removing that extension from this workspace.
- Keep the LAN voice server toggle, ensure/status receipts and manual browser voice access. Remove connect-only request bookkeeping and receipt fields without adding a replacement browser dependency.

## Upstream 5.0.0 sync

- Replace JS Notebook with upstream QuickJS Code, including fresh per-call VMs, four-cell concurrency and conversation-local JSON storage. Preserve old snapshot files without loading them; remove the obsolete Acorn dependency.
- Preserve local aborted-run guards, inactive tool defaults, offline startup, display behavior, Codex Live gateways and installation boundaries. Clarify QuickJS store lifetime and non-transactional writes in the README.

## Upstream 4.0.10 sync

- Adopt mixed-content output across all four cell runtimes, idle shell-completion notices, post-compaction shell inventory, lean patch results, terminal rejection handling and lower-allocation continuation comparison.
- Align Pi and native schema declarations with 1.5.2, Code host assets with 0.167.0, JS Notebook with Pi codemode 1.5.2 and TS Notebook with tsrs 0.23.0-ts7.1.0-beta. Preserve upstream native binaries and apply-patch provenance.
- Give exported shell-tool factories and notebook renderers explicit public types so declarations build against released Pi 1.5.2 without restoring a direct TypeBox dependency.
- Preserve local request timeouts, inactive tool defaults, offline startup, aborted-run guards, Codex Live gateways, maintained CDP helpers and Notes Compaction ownership. Combine upstream's stable nested-image cache with independent local card expansion and Pi-owned view_image display.

## Codex Live gateway routing

- Add `voice.codexLiveProvider` and `voice.codexLiveBaseUrl` gateway settings to the terminal, LAN interface and `host-settings`, without changing the chat or dictation route.
- Preserve invalid gateway strings across unrelated settings saves and in the editor; reject them when starting a call rather than switching routes.
- Distinguish configured `openai-codex` API keys from OAuth logins in authentication errors.

## Upstream 4.0.9 sync

- Adopt Pi 1.5 compatibility, incremental tool-call parsing, configured keybinding hints, transport recovery diagnostics, voice updates and the public global voice settings integration. Sync bundled native binaries and voice Rust sources with upstream; the dormant cancellation path remains disabled.
- Include the voice boolean fields in the public settings return type, matching the values returned at runtime.
- Update the JS Notebook runtime to Pi codemode 1.5 and the TS Notebook runtime to tsrs 0.21.0-ts7.1.0-beta. Keep the TypeBox development version at 1.3.27, matching the released Pi 1.5 runtime.
- Preserve Pi-aligned request timeouts, inactive-by-default tools, offline startup, aborted-run guards, Pi-owned image rendering and independent card expansion. Combine upstream's highlighting cache and configured hints with the local mouse wrappers without retaining render frames.
- Remove PCC's changelog extension and obsolete build hook; Pi owns extension update notices.

## Native Pi request timeouts

- Align normal Codex requests with released Pi 1.4.0/1.5.0: no implicit SSE response-header or SSE/WebSocket idle deadline. A positive `timeoutMs` limits SSE headers or WebSocket idle waits; zero disables it. SSE bodies remain cancellable without an idle timer.
- Remove the fixed 20-second SSE header timeout that could exhaust retries on slow requests. Keep existing recovery/advice budgets, retry policy and WebSocket setup/prewarm deadlines; stalled initial requests may require manual cancellation.

## Upstream 4.0.7 sync

- Adopt upstream voice, ordinary deferred-tool discovery, input preparation, tree-mode restoration and transport recovery changes. Discovery remains complementary to local announcement grouping and does not enable disabled tools.
- Tree navigation now reapplies the current adapter mode and tool settings instead of reviving an older adapter loadout; unrelated tool state remains Pi-owned.
- Preserve local expansion, Pi-owned image display, inactive-by-default structured tools, aborted-run guards and offline startup.
- Align the eight retained packages with Browser 0.0.13, Notes 0.0.13 and Shepherdr 0.2.25. Bootstrap Browser's public voice API declarations before PCC, then build its full extension; the aggregate uses Browser's public TS entry with Pi's host aliases. Host Pi remains 1.4.0.

## Image rendering ownership

- Leave top-level `view_image` result images to Pi instead of drawing a duplicate inside the card. The text-model description fallback reuses the existing image renderer only for its details-only preview and respects Pi's image-display setting.
- Keep nested title/path/error rendering, tool content and details unchanged.

## Tool registration after tree navigation

- Extend upstream's inactive-by-default registration to `apply_patch`, `exec_command`, `write_stdin` and `view_image`. Pi no longer automatically adds these never-declared tools when restoring a Code or Notebook branch. Structured and extra-tool modes still explicitly enable their selected tools.
- Correct the existing navigation checks to reject those extra declarations. Explicit historical activations remain Pi-owned; this does not restore the former runtime-admission or historical-declaration filters or repair earlier recorded activations.

## Deferred-tool grouping

- Group tool announcements by declared namespace, falling back to the registering extension entry so tools from one extension stay together. Namespace descriptions appear once per announcement; Added/Changed notices share the same layout.
- Keep flat calls, deferred loading, full contracts in `ALL_TOOLS`, persisted snapshots and append-only history unchanged. Unchanged snapshots incur no source lookup or grouping; source labels require no filesystem or network access.

## Upstream 4.0.5 sync

- Adopt upstream's inactive-by-default tool registration in place of the local runtime-admission and historical-declaration filters. Pi's recorded branch tool state is respected after `/tree` navigation.
- Notes and shared context now belong to `pi-notes-compaction`. The `context-sharing` export is replaced by the generic `compaction` and `agent-relationship` exports; legacy Notes-enabled configurations require Notes or an explicit continuity setting change.
- Preserve aborted-run guards, independent card expansion and `view_image` presentation/cache behavior through the upstream delegate-runtime split. Keep the local workspace installation instructions, static-only check, public exports, dependency alignment and no startup npm polling.

## 2026-10-25

### Nested tool cards

- Background: The existing user-requested local controls covered scripts, console output and patches; ordinary nested calls still toggled the whole card. This completes the local interaction rather than introducing it.
- Each nested call expands and collapses independently, including repeated calls to the same tool. Script and console output keep their existing behavior; Ctrl+O still controls the whole card.
- Notifications without a trace snapshot preserve expansion choices. Completed generic results can collapse while the outer script continues running.
- Nested `view_image` calls show title/path and errors only. Pi displays script-emitted images; hidden image results no longer occupy the nested result cache. Model-visible content is unchanged.

## 2026-10-24

### `c0e1d46` — Context from aborted runs

- Background: With no request snapshot yet, `pi-context-view` runs a silent probe for `/context` and deliberately aborts it at `turn_start`. PCC's context hook previously propagated cancellation from briefing providers as an extension error (`This operation was aborted`). The fullscreen preview could hide that chat error until Esc closed it; Esc itself did not cause the abort.
- Discard context briefings and Notebook startup status when their owning run has aborted, rather than reporting cancellation as an extension failure. Live-run failures retain their existing handling.

### `e1f7ec7` — Tool admission after tree navigation

- Background: Pi's `/tree` navigation restores branch tool declarations and can reactivate PCC tools disabled by the current configuration, such as `notes`, `history` and `change_reasoning`. The unchanged-plan sync previously left them admitted, and historical declarations could expose them to the model again.
- The former local change reapplied PCC tool admission on runtime sync and filtered historical model-message declarations. It was superseded by upstream's inactive-by-default registration in the 4.0.5 sync above.

### Repository metadata only

- `fe2f6b9`: changed the root workspace version from `0.4.0-preview.4` to `0.4.0`; no package runtime change.
- `d40e40d`: documented that retained package versions track their synchronized upstream baseline; no package runtime change.

## 2026-10-23

### `4707035` / `760385c` — Local expansion in this package

- `4707035` imported the earlier local tool-card work into the retained package, including independent script, console-output and patch-call controls.
- `760385c` restored upstream renderers, preview budgets and Display defaults while retaining those local click regions. Ctrl+O remained the host's whole-card control.

## 2026-10-21

### `eda7385` / `effbf4c` — Origin of local click-to-expand

- Background: The user requested opening one script, nested input/result or output region without expanding everything else. This was local work in the former `pi-ui` implementation, not an upstream PCC feature.
- `eda7385` introduced independent codemode card sections. `effbf4c` later simplified them to script, console-output and per-patch controls; that implementation became the source for this package's local expansion.
