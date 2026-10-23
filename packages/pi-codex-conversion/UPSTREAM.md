# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/a06eae4d141fae421a8d0108a4a560013d6508a8/packages/pi-codex-conversion
- Baseline version: 4.0.4
- Upstream history and license: CHANGELOG.md and LICENSE are retained. Nested provenance remains in UPSTREAM_SYNC.md, code-mode/UPSTREAM_SYNC.md, vendor UPSTREAM files and the native rust UPSTREAM files.

## Current local differences

- src/tools/code-mode/local-expansion.ts adds per-call script, console-output and patch expansion choices. call-rendering.ts, result-rendering.ts and trace-rendering.ts wrap those regions without changing upstream rendering, preview budgets, tool naming or Display defaults. Ctrl+O remains host-owned and clears local choices on a global transition. Handlers retain only choices and the latest invalidate callback, never the host context or lastComponent. CARD-LICENSE.md preserves the local expansion provenance and MIT attribution.
- src/tools/code-mode/AGENTS.md records the old-context lifetime hazard: renderers must not retain the host render context or lastComponent, and patch cards must use the existing trace renderer.
- Local runtime is self-managed from immutable releases. src/extension/session-lifecycle.ts no longer polls the npm registry on session startup; src/adapter/local-version-warning.ts is removed, with no compatibility branch or skip flag.
- package.json uses a local static check without test execution, removes npm publish/prepack/prepare lifecycle scripts, ships UPSTREAM.md, and pins the typebox devDependency to the Pi 1.4.0 host's 1.3.27. Build and native maintenance scripts remain.
- README.md documents installation from an immutable release, local source loading and this repository's extension set. References to unmigrated extensions and missing root API docs were removed.
- example custom-tool browser docs treat the CDP helpers in this package as canonical; there is no browser-cdp sync step. The maintained browser extension remains pi-browser.
- scripts/build-changed-native-tool-binaries.mjs detects voice changes only under this package. scripts/verify-codex-tool-binaries.mjs has neutral bundled-binary messages.
- UPSTREAM_SYNC.md treats web search as an external extension and no longer points at the unmigrated pi-codex-web-run package.

Apart from the runtime differences listed above, functional sources, binaries, WASM and bundled profiles match the baseline.
