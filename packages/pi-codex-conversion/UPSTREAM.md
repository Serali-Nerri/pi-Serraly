# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/c4f48525475f278d41dc311f2707926216bfa35b/packages/pi-codex-conversion
- Baseline version: 5.1.0
- Upstream history and license: CHANGELOG.md and LICENSE are retained. Nested provenance remains in UPSTREAM_SYNC.md, code-mode/UPSTREAM_SYNC.md, vendor UPSTREAM files and the native rust UPSTREAM files.
- Local history: [CHANGELOG.local.md](./CHANGELOG.local.md) records local changes separately from upstream releases.

## Selected upstream changes adopted

- Pi 1.6 host contracts, VM Code, TS Notebook, settings migration and tool-details rendering are used throughout the package. Deno Notebook, QuickJS Code, Voice-only scope and standalone extra-tool scope are removed in line with upstream 5.1.0.
- GPT Live 1.1 API voice, Codex Live, Realtime, dictation and the upstream voice conversation lifecycle are retained. Responses Lite uses the upstream image preparation/cache and 6,000-pixel/10,000-patch limits.
- WebSocket request-size preflight and pre-text 1009 recovery are adopted. A size rejection after visible output remains non-replayable.
- Responses Lite keeps the same session-cache identity passed by the local provider adapters.
- Upstream retry-after handling, transport recovery, session continuity, auto-reasoning guidance, tool discovery, Code/Notebook guidance and VM/TS help changes are adopted where their source files are shared with the local implementation.
- The package manifest follows the Pi 1.6 dependency line and ships the VM Code Bun helper without the removed QuickJS runtime dependency.

## Current local differences

- The package is maintained as a source-loaded workspace package: publication hooks, installation docs, local changelog/provenance and the aggregate integration follow this repository's policy rather than the upstream release workflow.
- Standalone Agent Comms remains the owner of Notes/history integration. The local package intentionally omits the upstream `pi-browser` runtime dependency and `/codex voice server connect`, while retaining the local LAN voice page, manual browser access and Codex Live gateway settings.
- Local shell lifecycle delivery, Pi-aligned request timeouts, Code/Notebook trace expansion and render ownership, aborted-run guards, session/host-process lifetime handling, TS checkpoint validation, native `apply_patch`/exec protocol and bundled artifact provenance are retained. These are owned by the nearest package docs and UPSTREAM_SYNC files.
- Local tests and offline package runners remain separate from upstream probes; no upstream package-wide publication or browser-CDP workflow was introduced.

The remaining TypeScript, WASM, native helpers, vendor trees and profiles are either the selected upstream files or the explicitly retained local artifacts above. Build and native provenance rules live in [development](../../docs/development.md#手动同步上游) and the nearest package documentation.
