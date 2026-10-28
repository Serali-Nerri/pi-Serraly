# Local changelog

Local changes and their background, relative to upstream **4.0.5** (`d67cb69b22decc4ea024236ba59dc4ddae9a2334`). [UPSTREAM.md](./UPSTREAM.md) lists current local differences; [CHANGELOG.md](./CHANGELOG.md) retains upstream release history. The package version tracks the upstream baseline, not local revisions.

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
