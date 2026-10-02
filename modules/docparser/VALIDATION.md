# Docparser stage-two validation

## Final module result

`npm --prefix modules/docparser run verify` **PASS** on Linux x64/glibc,
Node `24.12.0`, root Pi/pi-ai `0.99.2`, TypeScript `5.9.3`, Node types
`24.10.1`, oxfmt `0.49.0`, oxlint `1.76.0`, LiteParse `2.10.1` with its
linux-x64-gnu optional binding, and host typebox `1.3.27`.

- Original formatting check, lint and strict TypeScript/JavaScript checking: pass.
- Full module test command: **63 passed, 0 failed, 0 skipped** (~82 seconds).
- Isolated factory import: pass.
- Native parse/search/screenshot on the local one-page `Hello Pi` fixture: pass.
- FIFO, queued/active cancellation, activation-only timeout, descendant cleanup,
  uncertain-teardown fail-closed behavior, disposal, protocol framing, parse
  publication and search/screenshot/preview budgets: pass.
- Actual Pi source-workspace discovery and compiled-factory loading: pass.
- Plain-JavaScript runtime worker outside the development dependency tree with a
  physically copied LiteParse/platform-binding closure and no host packages: pass.
- Missing `native-worker.mjs`, `native-protocol.mjs`, and `parse-output.mjs`
  diagnostics/containment: pass.

The module test runner reconstructs its child environment rather than inheriting
credentials/provider configuration: temporary HOME, Pi agent directory, caches,
OS tmp paths and an empty working folder. Synthetic/local fixtures only; real
parse/search calls explicitly disable OCR. No real auth/settings/session files,
model requests, deploy commands, root installs, system package-manager installs or
commits were used. `/docparser:doctor` registration is verified; its optional
installation flow was deliberately not executed.

## Red/green evidence and resolved failures

1. **Workspace discovery:** before manifest adaptation, the real Pi loader loaded
   the copied `parse-document` skill, and the manifest was not private: **2 failed**.
   The private manifest with `pi.skills: []` and root-owned dependencies made both
   tests pass. Final source and runtime discovery still register exactly the three
   deferred document tools plus `/docparser:doctor` without prompt metadata.
2. **Worker-startup containment:** new runtime missing-file tests initially failed
   in all three cases with unhandled `read ECONNRESET`. A focused executor test
   reproduced the same failure before the production fix. Consuming the extra
   stdio Duplex's unused-readable-side error event changed the focused test to
   **1 passed** and all three runtime missing-file cases to pass. The existing end
   callback and worker-exit/response handlers still own failure classification.
3. **Root host resolution:** a concurrent root dependency install overlapped the
   initial standalone manifest import and created an ignored workspace-local Pi
   `0.99.1` / TypeScript `6.0.3` tree. Earlier full runs are **not** Pi `0.99.2`
   acceptance. A new resolution regression failed on the module-local host path.
   Only the generated `modules/docparser/node_modules` tree was removed; the final
   manifest has no dev/runtime dependencies, and the regression plus full
   **63-test verify** pass using root Pi `0.99.2` and TypeScript `5.9.3`. Root's
   owner must reconcile stale lock/install entries; this agent did not edit them.
4. The initial runtime fixture copier encountered commander's non-exported
   `package.json` subpath (**5 fixture-setup failures**). It now locates metadata
   from the exported entry's containing package, with no production change.
   Package/native checks then passed. No failing test was removed or weakened.

## Limits and root-owned follow-up

- The module's offline runtime fixture validates build layout, actual worker/native
  resolution and host loader behavior. It does **not** establish that root's real
  npm-ci/locked release package has been installed or validated.
- Root can run these package tests against its actual assembled runtime using
  `PI_DOCPARSER_RUNTIME_ROOT=/absolute/runtime/package npm --prefix modules/docparser run test:package`.
  The supplied tree is copied before any destructive missing-file test.
- Root build, optional-binding installation/lock reconciliation, six-entry
  coexistence/selection, deployment/migration and release legal closure remain
  root-owned and were not run by this module agent.
- No OCR download/server, LibreOffice/real Office conversion, macOS/Windows,
  alternate native platforms, Node `22.19`, real user document or global install
  validation was attempted. These are untested, not silently passing claims.
- `codegraph_explore` was unavailable; source/docs reads were the fallback.
- Read-only source repo remains clean at
  `c9b1e3fcf3166c75fb15f8476c17895fcd5e5ed5`.
