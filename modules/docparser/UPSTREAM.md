# Docparser provenance and workspace boundary

- Imported read-only reference: `/home/thelya/Work/Scripts/pi-docparser`.
- Original repository: <https://github.com/maxedapps/pi-docparser>.
- Exact baseline: `c9b1e3fcf3166c75fb15f8476c17895fcd5e5ed5` (clean working tree).
- Upstream package version: `4.0.0`; original copyright and MIT `LICENSE` are retained unchanged.
- Parent backup/hash manifest: `/tmp/pi-serraly-stage-two-sources-20261002-000556/manifest.json`.

## Import inventory

The initial 41-file import was checked against the parent's SHA-256 manifest.
It contains the complete `extensions/docparser/` TypeScript source and three native
`.mjs` files, all `tests/` and local PDF fixtures/helpers, `skills/parse-document/`
source, `assets/`, `licenses/`, README, changelog, MIT license, third-party notices,
AGENTS instructions, TypeScript/format configuration and Git text/binary policy.

Excluded: `.git/`, `node_modules/`, generated `dist/`, `.pi/`, private `.plans/` and
`.reviews/`, old `pnpm-lock.yaml` and `pnpm-workspace.yaml`, standalone
`scripts/build.mjs`, global `scripts/deploy.mjs` / `scripts/undeploy.mjs`, and the
standalone pnpm CI workflow. Building, runtime installation, deployment and root
CI integration belong to pi-Serraly, not this workspace.

## Intentional migration differences

- The manifest is private; development and LiteParse runtime dependencies are
  installed/locked at root. Actual host imports remain `"*"` peers only.
- The workspace exposes the existing factory but explicitly disables companion
  skill discovery. The root runtime manifest must declare extensions only.
- Original 2-space source formatting, lint and strict TypeScript/JavaScript checks
  are preserved. Root-installed tooling replaces standalone Bun/pnpm invocation.
- Tests run in a fresh temporary HOME, Pi agent directory, cache and empty cwd.
  The native integration fixture is now resolved relative to the test module,
  not the process cwd. Schemas, results, budgets and worker protocol are unchanged.
- New missing-worker-file regressions found an inherited containment bug: early
  worker exit emitted an unhandled `ECONNRESET` on the unused readable side of
  Node's request-pipe Duplex. `native-executor.ts` now consumes that error event;
  the existing write callback/worker-exit/response paths still classify failures.
  This is the only production-source change. It prevents a worker startup failure
  from taking down the host without changing FIFO/cancellation/timeout semantics.
- Standalone publication/version assertions and network-dependent packed-install
  tests are replaced with actual Pi workspace discovery, source archive closure,
  offline physical runtime staging, real plain-JavaScript native operations,
  compiled-factory execution through Pi's host loader, and missing-worker-file
  diagnostics. Native FIFO/cancellation/timeout/crash/budget tests are retained.
- The test-only runtime fixture can be bypassed with
  `PI_DOCPARSER_RUNTIME_ROOT=/absolute/runtime/package` to validate root's actual
  assembled runtime package. Tests copy it before destructive missing-file cases.
  Root owns npm-ci/lock/platform-optional installation and full six-entry tests.
- README installation/deployment advice is replaced by the workspace boundary;
  tool/config/native operation details and attribution remain here.

## Root build contract

Factory: `modules/docparser/extensions/docparser/index.ts`.
Compiled entry: `dist/pi-docparser/index.js` (ESM bundle, Node >=22.19).
Keep `import.meta.url` intact and externalize `@earendil-works/*`, `typebox` and
`@llamaindex/liteparse`. Place `native-worker.mjs`, `native-protocol.mjs`, and
`parse-output.mjs` from the factory's source directory beside the compiled entry.
The executor resolves `./native-worker.mjs` against that entry; the worker imports
`./native-protocol.mjs` and `./parse-output.mjs` and resolves LiteParse from the new
runtime package's physical dependency tree. Never link old source node_modules.

Runtime dependency: `@llamaindex/liteparse` exactly `2.10.1`, retaining installed
platform optional bindings. Development tooling needed at root: esbuild, tsx,
TypeScript, Node types, oxfmt (`^0.49.0`), oxlint (`^1.76.0`), Pi `0.99.2` (including
pi-ai) and host typebox `1.3.27`. Module host peers: pi-ai and pi-coding-agent only.

Carry `LICENSE`, `THIRD_PARTY_NOTICES.md`, and `licenses/LiteParse-APACHE-2.0.txt`
into root's runtime legal closure. The companion skill remains source-only and is
not a runtime resource. No global deployment or source repository changes were
performed by this migration. See [VALIDATION.md](./VALIDATION.md) for red/green
regressions, safe validation results and environment limits.
