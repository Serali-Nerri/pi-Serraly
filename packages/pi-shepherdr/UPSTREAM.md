# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/5b641f0a7c7c93c53f9e9cda6abef498fc1441ef/packages/pi-shepherdr
- Baseline version: 1.0.5
- Upstream history and license: CHANGELOG.md and LICENSE are retained.
- Local history: [CHANGELOG.local.md](./CHANGELOG.local.md) records workspace-specific integration and reliability changes.

## Selected upstream changes adopted

- 1.0.5 shortened delegation help, agent receipts and recovery messages, final-report follow-up prompt, and `hc run --bg` vs `hc wait` guidance are adopted.
- Shepherdr's shared-context and Board integrations consume Agent Comms 0.0.7's public exports and align with Pi 1.6.1 and optional Pi Codex Conversion 5.1.2.

## Current local differences

- package.json, README.md and index.ts use the prepared installation workspace, provenance files, local changelog, Pi 1.6.1 / PCC 5.1.2 floors (including the outdated-PCC Code Mode error message) and Core 0.1.21 floor rather than the upstream npm publication workflow.
- The local Core 0.1.21 compatibility floor, native turn baseline, bounded parent-read retry, Windows close handling, attachment startup/cleanup, affected-session monitor refresh, Agent Comms-only saved-notes module resolution (`src/remote/notes-reader.mjs`) and bounded saved-session cache remain in place.
- Local regression tests cover attachment startup/cleanup, settlement and parent supervision. They are retained as package-owned offline checks.

Other runtime sources, Core-native resources and bundled profiles match the selected 1.0.5 baseline apart from the explicit Agent Comms integration and reliability boundaries above.
