# Local changelog

Local changes and their background, relative to upstream **4.0.4** (`a06eae4d141fae421a8d0108a4a560013d6508a8`). [UPSTREAM.md](./UPSTREAM.md) lists current local differences; [CHANGELOG.md](./CHANGELOG.md) retains upstream release history. The package version tracks the upstream baseline, not local revisions.

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
- Reapply PCC tool admission on every runtime sync and in historical model-message projection, including unchanged plans after tree navigation.
- Preserve eligible nested notes/history and external Notes ownership without admitting disabled PCC tools.

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
