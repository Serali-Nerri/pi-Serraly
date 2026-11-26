# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/5b641f0a7c7c93c53f9e9cda6abef498fc1441ef/packages/pi-codex-conversion
- Baseline version: 5.1.2
- Upstream history and license: CHANGELOG.md and LICENSE are retained. Nested provenance remains in UPSTREAM_SYNC.md, code-mode/UPSTREAM_SYNC.md, vendor UPSTREAM files and the native rust UPSTREAM files.
- Local history: [CHANGELOG.local.md](./CHANGELOG.local.md) records local changes separately from upstream releases.

## Selected upstream changes adopted

- Pi 1.6.1 owns the admitted native tool selection and receives Codex compaction usage. PCC filters replaced tool declarations on model requests and compaction replay rather than removing them from Pi's persisted selection.
- Full Responses replay preserves completed tool calls across reconnects. Native compaction uses the actual Responses format, independent of execution mode.
- VM Code reports retained bindings and can reset an idle VM under memory pressure while preserving its in-session JSON store. VM Code and TS Notebook use the `exec` yield timeout and `wait`; the former `prompt-mode` integration is no longer exported.
- GPT Live 1.1 API voice, Codex Live, Realtime, dictation and the upstream voice conversation lifecycle are retained. Responses Lite uses the upstream image preparation/cache and 6,000-pixel/10,000-patch limits.
- WebSocket request-size preflight and pre-text 1009 recovery are adopted. A size rejection after visible output remains non-replayable.
- Responses Lite keeps the same session-cache identity passed by the local provider adapters.
- Upstream retry-after handling, transport recovery, session continuity, auto-reasoning guidance, tool discovery, Code/Notebook guidance and VM/TS help changes are adopted where their source files are shared with the local implementation.
- The manifest pins the Pi 1.6.1 SDK and tsrs `7.1.0-beta.tsrs5`. Bundled native helpers, WASM and vendor pins are unchanged in this update.

## Current local differences

- The package is maintained as a source-loaded workspace package: publication hooks, installation docs, local changelog/provenance and the aggregate integration follow this repository's policy rather than the upstream release workflow.
- Standalone Agent Comms remains the owner of Notes/history integration. The local package intentionally omits the upstream `pi-browser` runtime dependency and `/codex voice server connect`, while retaining the local LAN voice page, manual browser access and Codex Live gateway settings.
- Local shell completions can be delivered at completed turn boundaries, not just while idle. The tool projections also hide Pi's `find`, `grep` and `ls` when replaced.
- The TS runtime resolves the real installed manifest behind workspace links, checks for the platform-specific tsrs binary before accepting a cached installation and removes incomplete installs before retrying. Windows uses npm's JS entry point and separate compiler input and output streams.
- Pi-aligned request timeouts, WebSocket route retirement, Code/Notebook trace expansion and render ownership, aborted-run guards, session/host-process lifetime handling, TS checkpoint validation, MCP envelope/`ALL_TOOLS` guidance and locally rebuilt `apply_patch`/`exec_bridge` helpers retain their local adaptations and provenance.
- Local tests and offline package runners remain separate from upstream probes; no upstream package-wide publication or browser-CDP workflow was introduced.

The remaining TypeScript, WASM, native helpers, vendor trees and profiles are either the selected upstream files or the explicitly retained local artifacts above. Build and native provenance rules live in [development](../../docs/development.md#手动同步上游) and the nearest package documentation.
