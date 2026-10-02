# Testing pi-background-shell

Use the root npm workspace dependencies with Node >=22.19.0. Development host packages are pinned to Pi **0.99.2** and TypeBox **1.3.27**; do not install a separate module dependency tree. Wildcard host peers are packaging policy, not a compatibility claim for other Pi versions. Dependency installation and release-tree staging belong to the repository root docs.

From the repository root:

```sh
npm run verify --workspace pi-background-shell
# Focused scripts (all retained):
npm run build:runtime --workspace pi-background-shell
npm run typecheck --workspace pi-background-shell
npm run test:type-safety --workspace pi-background-shell
npm run docs:generate --workspace pi-background-shell # after source/prose review
npm run docs:verify --workspace pi-background-shell
npm run test:docs --workspace pi-background-shell
npm run test:unit --workspace pi-background-shell
npm run test:sdk --workspace pi-background-shell
npm run test:rpc --workspace pi-background-shell
npm run test:component --workspace pi-background-shell
npm run test:package --workspace pi-background-shell
npm run test:agent-loop --workspace pi-background-shell
npm run test:pty --workspace pi-background-shell
npm run smoke --workspace pi-background-shell
npm run pack:dry-run --workspace pi-background-shell
npm run payload:check --workspace pi-background-shell
```

`npm test --workspace pi-background-shell` runs typecheck/type-safety and the full unit/SDK/RPC/component/package suites. `test:full` additionally runs PTY and scripted-provider tests; `verify` also runs docs verification, CLI smoke and payload checks. None of the retained tests was removed to adapt the workspace.

All test/SDK/provider/CLI-smoke scripts go through `scripts/test-isolated.mjs`: a temporary HOME/agent/session/config/cache tree, empty working directory, credential-free environment and offline Pi. The runner resolves test files and the tsx loader from the workspace, propagates failures, and removes its scratch tree. SDK fixtures use synthetic sessions and local auth paths; agent-loop fixtures use deterministic scripted providers, never a real request. Build and docs gates are data-only. Package tests resolve the actual hoisted dependencies rather than assuming module-local `node_modules`; offline pack/install checks remain outside the development tree with no private host peers.

`build:runtime` cleans the module-local ignored `dist` before compilation, preserving the complete tsc ESM module closure and literal lazy UI imports. Prepack builds and verifies docs/payload. The compiled factory is `dist/extensions/background-tasks.js`, reexporting `dist/src/extension.js`; the root build supplies its own thin `dist/pi-background-shell/index.js`. Never load the development dependency tree as the production package.

## Workspace verification record

Linux / Node 24.12.0 / root Pi 0.99.2 / TypeBox 1.3.27:

| Suite/gate | Actual result |
| --- | --- |
| Strict typecheck, clean tsc build and source/map/lazy closure | Passed |
| Unit (including two new isolation regressions) | 152 passed |
| SDK (including same-child reload and compiled/source dock loading) | 38 passed |
| RPC | 7 passed |
| Component | 48 passed |
| Package (includes the four type-safety cases) | 33 passed |
| Scripted-provider agent loop | 8 passed; no real provider requests |
| Standalone type-safety / docs reruns | 4 / 6 passed; overlap the suite counts above |
| Offline CLI smoke | Pi 0.99.2, four deferred tools/seven commands |
| Docs/payload/prepack dry-run | 15 surfaces, 14 production sources, 71 exact packed files |
| Original PTY suite | 8 explicitly skipped: `/usr/bin/expect` unavailable; not interaction evidence |
| Native Windows suite | 15 platform-precondition failures on Linux; not Windows qualification |

`verify` passed, with the PTY limitation above; the Windows-only script is separate and intentionally refuses Linux. Source `src/` and `extensions/` plus LICENSE remain byte-identical to fork HEAD `86c52d3`. No tests were deleted or weakened. Adaptation RED/GREEN evidence covered inherited module-local dependency paths, the pinned installed-host version, the isolated runner/failure propagation, runtime-only peers and asset resolution from the empty test cwd. Early baselines overlapped the parent's dependency reconciliation and are not final 0.99.2 evidence; the final parity assertion resolves the actual root dependencies and no module-local host copies remain.

## Important retained checks

- Exactly four tools/seven commands; description-only tool metadata and actual shell suffix/spawn-policy parity; no system-prompt hook.
- Exit/spawn failure, timeout/output overflow, bounded head/tail, unknown/ambiguous IDs, kill-after-end failure, raw JSON/control-looking stdout/stderr.
- Notification/trigger combinations, close-before-terminal-metadata/publication, response-before-terminal ordering, deduplication and bounded listener retries.
- Start/shutdown races, repeated shutdown, session replacement/removal, default kill-on-reload and opted same-child handoff with unchanged timeout/output count. Fixed absolute handoff deadline is not extended by abort.
- Durable metadata and output-close distinction; POSIX process-group proof, shared escalation and loud uncertain cleanup; Windows helper mocks and Windows-only integration.
- Lazy dock import, UI controls/Unicode/narrow widths, non-TUI fallback, acknowledgement without deleting logs.
- AST docs/schema mutation detection, source ownership and generated freshness, exact package paths, compiled manifest entry/maps/deferred closure, no removed runtime/wrapper artifacts, no bundled duplicate host SDK.
- Isolated offline local tarball install and real host activation using host-provided libraries. npm HOME/cache/config/temp and Pi agent paths are fixture-local; tests do not change user settings.

SDK harnesses must bind extensions with counted bindings such as `onError` and shut down through `AgentSessionRuntime.dispose()` or an awaited `session_shutdown` path. Bare `AgentSession.dispose()` and empty/mode-only reload are not supported lifecycle proof.

## Targeted task-manager checks

Treat these as focused checks for the responsive dock changes, not a claim that every scenario already has automated coverage or has passed:

- **Responsive panel and compositors:** exercise both fullscreen and regular TUI compositors at wide, narrow and short terminal sizes. Check centering, the one-cell margin and adaptive height capped at 80% of terminal height. A wide allocation above 118 columns must not hit the old cap, and available log height must not stay fixed at 12 lines. Check resize and close for clipping, stale rows and restoration of the host display.
- **Layout and keyboard focus:** wide task sidebar plus selected-task log preview; narrow list then Enter/→ to logs; `f` log-only and `i` scrollable full info with all process fields. Check Tab and ←, task selection versus log/info scrolling with arrows and page keys, list history, stop/confirmed stop-all, rerun, output-path display (no clipboard copy), and all close keys. The overlay must capture keyboard input while child output continues, not act as a passive panel; shortcut configuration and non-TUI fallback remain unchanged.
- **Notice acknowledgement:** selecting or previewing a finished task in the wide layout must leave its notice unseen. Explicit entry into logs (including exact-ID command entry and log-only view) or full info acknowledges only that task; list viewing and closing must not clear all notices.
- **Long lines and Unicode:** verify default soft-wrap, `w` toggling, and no-wrap Shift+Left/Right pan, `0` reset and `$` last-column navigation. Include lines longer than the viewport, wide CJK characters, combining characters and emoji; check terminal-cell widths, wrap boundaries and panning for clipping or broken characters.
- **Resize, paused anchor and follow:** use a growing log larger than the UI reservoir. Scroll up and verify that the bounded 128 KiB recent tail freezes; preserve the same source-log-line anchor across wider/narrower resize and repeated wrap toggles. `g` reaches only the oldest retained row. Reaching the bottom, `r` or `G` resumes follow and one-second refresh. Soft-wrap must not become a full-file-history read or change the separate 50 KiB tool/model cap.
- **Runtime isolation:** retain the existing process, notification, timeout, output-cap and same-child reload checks. Dock layout, focus, wrap and pan must not alter child ownership or the reload mechanism.

## Platform boundaries

PTY tests need `/usr/bin/expect` and deliverable raw-mode stdin; unsupported hosts skip with an explicit reason. Deterministic component/SDK/RPC tests remain required. `npm run test:windows` must run on Windows for native quoting/tree/durability qualification. Linux mocks do not establish real Windows reload continuity.

No remote creation, publication, global settings changes or live-model certification is part of this fork. Test success must be reported from actual runs, not inferred from this checklist.

See [gate design](docs/subsystems/docs-freshness-gate.md), [lifecycle](docs/subsystems/extension-lifecycle.md), and [documentation index](docs/INDEX.md).
