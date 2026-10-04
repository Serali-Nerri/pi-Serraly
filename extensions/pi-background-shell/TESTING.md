# Testing pi-background-shell

## Commands

Use the root npm workspace dependencies with Node >=22.19.0, Pi **1.0.0** and
TypeBox **1.3.27**. Do not install a separate module dependency tree. Wildcard
host peers are packaging policy, not a compatibility claim for other Pi versions.
Dependency installation and release staging belong to the root development guide.

From the repository root:

```sh
npm run verify
# Module-only debugging:
npm run verify --workspace pi-background-shell
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

`npm test --workspace pi-background-shell` runs typecheck/type-safety and the
unit/SDK/RPC/component/package suites. `test:full` also runs PTY and scripted-provider
tests; module `verify` adds docs verification, CLI smoke and payload checks.
Module-only commands do not replace root verification and release integration.

## Isolation and build boundaries

Test/SDK/provider/CLI-smoke scripts use `scripts/test-isolated.mjs`: temporary
HOME/agent/session/config/cache paths, empty cwd, an allowlisted credential-free
environment and offline Pi. The runner resolves tests and tsx from the workspace,
propagates failures and removes its scratch tree. SDK sessions and auth paths are
synthetic/local; agent-loop providers are deterministic and send no real requests.
Build and docs gates are data-only. Package fixtures resolve hoisted dependencies
and use offline local tarball installation outside the development tree, without
physical host peers or changes to user settings.

`build:runtime` cleans module-local ignored `dist` before compiling the full tsc
ESM closure and literal lazy UI imports. The shared package builder then inlines
the manifest-declared `src/ui/tool-cards.ts` leaf, with `pi-ui-kit` bundled and
host peers external, into the same `dist/src/ui/tool-cards.js`; the shipped source
leaf needs the workspace link, the bundled dist does not. Prepack checks docs and
payload. The compiled factory is `dist/extensions/background-tasks.js`,
reexporting `dist/src/extension.js`; root builds add
`dist/pi-background-shell/index.js`. Never load the development dependency tree as
a production package.

## What tests exercise

- Four tools/seven commands, deferred exposure, description-only metadata and
  actual shell description/spawn-policy parity; no system-prompt hook.
- Exit/spawn failure, timeouts/output overflow, bounded head/tail reads,
  unknown/ambiguous IDs, kill-after-end failures and uninterpreted stdout/stderr.
- Notification/trigger combinations, response-before-terminal ordering,
  close-before-publication, deduplication and bounded delivery retries.
- Start/shutdown races, repeated cleanup, session replacement/removal, default
  kill-on-reload and opt-in same-child handoff with unchanged PID, timeout and
  output count. Abort does not extend the absolute handoff deadline.
- Atomic metadata, output-close distinction, POSIX process-group proof and
  escalation, loud uncertain cleanup, Windows helper mocks and native Windows tests.
- Lazy dock loading, controls/Unicode/narrow widths, non-TUI fallback and notice
  acknowledgement without deleting logs.
- AST/schema mutation detection, source/prose ownership and hash freshness,
  exact packed paths, compiled entry/maps/lazy closure and real host loading
  without duplicate SDK copies.

SDK harnesses must use counted lifecycle bindings such as `onError` and await
`AgentSessionRuntime.dispose()` or another host path emitting `session_shutdown`.
Bare `AgentSession.dispose()` and empty/mode-only reload bindings do not establish
supported cleanup or reload continuity. Rebind after runtime session replacement.

## Manual dock checks

Pi defaults to fullscreen; also inspect explicit regular mode
(`"tuiMode": "regular"` or `--tui-mode regular`). Automated component bounds do not
certify visual appearance, focus, mouse behavior or resize restoration in a real terminal.

- **Layout:** wide/narrow/short sizes, centering, one-cell margin, adaptive height
  capped at 80%, and no old 118-column width cap or fixed 12-line log height.
- **Focus and controls:** wide sidebar/log preview, narrow list-to-logs navigation,
  `f` log-only, `i` full info, Tab/arrow/page keys, stop/stop-all, rerun, path display
  (not clipboard copy), close keys and shortcuts while child output continues.
- **Acknowledgement:** sidebar preview leaves a notice unseen; explicit logs/info
  entry acknowledges only that task. Viewing/closing the list must not clear all.
- **Text:** default soft-wrap, `w` toggle, Shift+Left/Right pan, `0` reset and `$`
  last column; long lines, CJK, combining characters and emoji stay cell-bounded.
- **Follow:** scrolling up freezes the 128 KiB tail; preserve the source-line anchor
  across resize/wrap changes. Bottom, `r` or `G` resumes one-second refresh. `g`
  reaches only retained history, not the full file; the tool/model cap stays 50 KiB.

## Platform and acceptance limits

PTY tests require `/usr/bin/expect` and deliverable raw-mode stdin; missing support
produces an explicit skip reason. Component/SDK/RPC suites remain required.
Run `npm run test:windows --workspace pi-background-shell` on Windows for native
quoting/tree/durability qualification; that script intentionally refuses Linux.
Linux mocks do not establish native Windows behavior or reload continuity.

No live-model certification, remote publication, global settings changes or
deployment is part of these commands. Report passes, failures, platform skips and
manual observations from actual runs, not from this document.

See [gate design](docs/subsystems/docs-freshness-gate.md),
[lifecycle](docs/subsystems/extension-lifecycle.md) and
[documentation index](docs/INDEX.md).
