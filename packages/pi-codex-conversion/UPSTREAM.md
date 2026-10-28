# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/d67cb69b22decc4ea024236ba59dc4ddae9a2334/packages/pi-codex-conversion
- Baseline version: 4.0.5
- Upstream history and license: CHANGELOG.md and LICENSE are retained. Nested provenance remains in UPSTREAM_SYNC.md, code-mode/UPSTREAM_SYNC.md, vendor UPSTREAM files and the native rust UPSTREAM files.
- Local history: [CHANGELOG.local.md](./CHANGELOG.local.md) records recent local changes separately from upstream releases.

## Current local differences

- src/tools/code-mode/local-expansion.ts adds script, console-output and per-nested-call expansion choices. call-rendering.ts, result-rendering.ts and trace-rendering.ts wrap those regions without changing upstream preview budgets, tool naming or Display defaults. Updates without a trace snapshot preserve choices; explicit snapshots prune absent calls. Completed nested results can collapse while the outer script streams. Nested view_image calls show title/path and errors only, leaving script-emitted images to Pi's outer renderer without conditional deduplication or model-content changes. delegation/tool-executor.ts retains image-call input/state but skips hidden raw results in the nested render cache. Ctrl+O remains host-owned and clears local choices on a global transition. Handlers retain only choices and the latest invalidate callback, never the host context or lastComponent. CARD-LICENSE.md preserves the local expansion provenance and MIT attribution.
- src/tools/code-mode/AGENTS.md records the old-context lifetime hazard: renderers must not retain the host render context or lastComponent, and patch cards must use the existing trace renderer.
- Local runtime updates use a separate installation workspace. src/extension/session-lifecycle.ts no longer polls the npm registry on session startup; src/adapter/local-version-warning.ts is removed, with no compatibility branch or skip flag.
- Upstream's defaultActive:false tool registration replaces the former local runtime-admission and historical-declaration filters. Pi's recorded branch tool state remains authoritative on tree navigation.
- src/context-briefings.ts and src/adapter/notebook-status.ts discard context built for a run whose owner already aborted. Pi attributes hook failures to the registering extension, and an aborted run discards the context anyway; live-run failures still surface.
- src/extension/notes-migration.ts directs users to the Notes installation instructions instead of assuming an npm installation. Notes must be loaded, or the legacy continuity setting explicitly disabled, before old Notes-enabled configurations can run.
- package.json uses a local static check without test execution, removes npm publish/prepack/prepare lifecycle scripts and publish metadata (including .npmignore), ships UPSTREAM.md and CHANGELOG.local.md, and pins the typebox devDependency to the Pi 1.4.0 host's 1.3.27. Build and native maintenance scripts remain.
- tests/context-briefings.test.ts and tests/notebook-status.test.ts are the retained local consequence tests for the aborted-run guards. Upstream test files sync unchanged; no upstream test was added by this sync.
- README.md documents native Pi registration from a prepared installation workspace, local source loading and this repository's extension set. References to unmigrated extensions and missing root API docs were removed.
- example custom-tool browser docs treat the CDP helpers in this package as canonical; there is no browser-cdp sync step. The maintained browser extension remains pi-browser.
- scripts/build-changed-native-tool-binaries.mjs detects voice changes only under this package. scripts/verify-codex-tool-binaries.mjs has neutral bundled-binary messages.
- UPSTREAM_SYNC.md treats web search as an external extension and no longer points at the unmigrated pi-codex-web-run package.

Apart from the runtime differences listed above, functional sources, binaries, WASM and bundled profiles match the baseline.
