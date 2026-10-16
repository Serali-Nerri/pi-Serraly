# Testing pi-background-shell

## Commands

Use the root npm workspace dependencies with Node >=22.19.0, Pi **1.3.0** and
TypeBox **1.3.27**. Do not install a separate module dependency tree. Wildcard
host peers are packaging policy, not a compatibility claim for other Pi versions.
Dependency installation and release staging belong to the root development guide.

For complete repository acceptance, run this once from the repository root:

```sh
npm run verify
```

Alternatively, for module-only verification (not an additional step after root verify):

```sh
npm run verify --workspace pi-background-shell
```

For focused debugging, build once after artifact-affecting changes, then run only
the affected suite. For example:

```sh
npm run build --workspace pi-background-shell
npm run test:sdk --workspace pi-background-shell
```

Other focused scripts are `typecheck`, `test:type-safety`, `test:unit`, `test:rpc`,
`test:component`, `test:package`, `test:agent-loop`, `test:docs` and
`smoke`. `pack:check` and `payload:check` inspect existing artifacts. Run
`docs:generate` after reviewing governed source/prose changes and `docs:verify` to
check freshness. These are alternatives by scope, not a checklist to execute in full.

`check` runs static TypeScript and docs verification only. `npm test --workspace
pi-background-shell` runs the unit/SDK/RPC/component/package suites; type-safety is
covered by the package suite and remains available as `test:type-safety` for focused
debugging. `test:full` also runs scripted-provider tests. Module `verify`
builds once, then runs `check`, `test:full` and CLI smoke; the build already validates
the sealed artifact and payload. Module-only commands do not replace root
verification and release integration.

## Isolation and build boundaries

Test/SDK/provider/CLI-smoke scripts use `scripts/test-isolated.mjs`: temporary
HOME/agent/session/config/cache paths, empty cwd, an allowlisted credential-free
environment and offline Pi. The runner resolves tests and tsx from the workspace,
propagates failures and removes its scratch tree. SDK sessions and auth paths are
synthetic/local; agent-loop providers are deterministic and send no real requests.
Build and docs gates are data-only. Package fixtures resolve hoisted dependencies
and use offline local tarball installation outside the development tree, without
physical host peers or changes to user settings.

`build` (also available as `build:runtime`) compiles the full tsc ESM closure and
literal lazy UI imports in a new sibling candidate directory, leaving live `dist`
untouched during compilation. The shared package builder then inlines the
manifest-declared `src/ui/tool-cards.ts` leaf,
with `pi-ui-kit` bundled and
host peers external, into the same `dist/src/ui/tool-cards.js`; the shipped source
leaf needs the workspace link, the bundled dist does not. `prepack` verifies docs
then builds once; the build validates the artifact and payload without a second
`pack:check`. The sealed candidate replaces live dist, with rollback if validation
fails. The compiled factory is `dist/extensions/background-tasks.js`, reexporting
`dist/src/extension.js`; there is no aggregate root-dist forwarding entry.
Never load the development dependency tree as a production package.

Tests and checks never rebuild implicitly. `test:sdk`, `test:package`, `smoke`,
`payload:check` and `pack:check` require current, explicitly built artifacts; missing
or stale artifacts must be fixed by running `build`, not by rerunning a test. The
aggregate test commands reuse that same build. Source-only focused tests and docs
verification need no runtime build; static typechecking uses existing workspace
library declarations.

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

Timeout tests wait for the failed terminal snapshot within the execution timeout
plus the registry's tree-stop/proof budget and a bounded metadata-settlement
margin. They retain the configured execution deadline and exact status/error/log
assertions; sending a termination signal alone is not terminal completion.

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

Component/SDK/RPC suites remain required. Interactive dock behavior has no
automated PTY suite; the manual checks above own that coverage.
Run `npm run test:windows --workspace pi-background-shell` on Windows for native
quoting/tree/durability qualification; that script intentionally refuses Linux.
Linux mocks do not establish native Windows behavior or reload continuity.

No live-model certification, remote publication, global settings changes or
deployment is part of these commands. Report passes, failures, platform skips and
manual observations from actual runs, not from this document.

See [gate design](docs/subsystems/docs-freshness-gate.md),
[lifecycle](docs/subsystems/extension-lifecycle.md) and
[documentation index](docs/INDEX.md).
