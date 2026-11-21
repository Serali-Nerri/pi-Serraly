# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/19ec6357fa3c4eb0126f8b0d4b6569de1a655ef9/packages/pi-codex-conversion
- Baseline version: 5.0.2
- Upstream history and license: CHANGELOG.md and LICENSE are retained. Nested provenance remains in UPSTREAM_SYNC.md, code-mode/UPSTREAM_SYNC.md, vendor UPSTREAM files and the native rust UPSTREAM files.
- Local history: [CHANGELOG.local.md](./CHANGELOG.local.md) records local changes separately from upstream releases.

## Selected upstream changes adopted

- Pi 1.6 host contracts and settings rendering are used throughout the package. QuickJS Code resolves Pi's bundled `quickjs-wasi` runtime; it no longer downloads a second runtime on first use.
- Responses Lite uses the upstream image preparation/cache and 6,000-pixel/10,000-patch limits, with the same session-cache identity passed by the local provider adapters.
- Upstream retry-after handling, transport recovery, session continuity, auto-reasoning guidance, tool discovery, Code/Notebook guidance and VM/TS help changes are adopted where their source files are shared with the local implementation.
- The package manifest follows the Pi 1.6 dependency line and keeps `quickjs-wasi` at the upstream 3.6.2 runtime used by Pi 1.6.

## Current local differences

- The package is maintained as a source-loaded workspace package: publication hooks, installation docs, local changelog/provenance and the aggregate integration follow this repository's policy rather than the upstream release workflow.
- Standalone Notes Compaction remains the owner of Notes/history integration. The local package intentionally omits the upstream `pi-browser` runtime dependency while retaining the local LAN voice page, manual browser startup and gateway settings.
- Local shell lifecycle delivery, Code/Notebook trace expansion and render ownership, aborted-run guards, session/host-process lifetime handling, TS checkpoint validation, native `apply_patch`/exec protocol and bundled artifact provenance are retained. These are owned by the nearest package docs and UPSTREAM_SYNC files.
- Local voice/controller and voice-settings integration remains in place where it differs from the upstream 5.0.2 voice tree; the package continues to expose the existing Codex Live gateway and standalone integration contracts.
- Local tests and offline package runners remain separate from upstream probes; no upstream package-wide publication or browser-CDP workflow was introduced.

The remaining TypeScript, WASM, native helpers, vendor trees and profiles are either the selected upstream files or the explicitly retained local artifacts above. Build and native provenance rules live in [development](../../docs/development.md#手动同步上游) and the nearest package documentation.
