# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/19ec6357fa3c4eb0126f8b0d4b6569de1a655ef9/packages/pi-shepherdr
- Baseline version: 1.0.3
- Upstream history and license: CHANGELOG.md and LICENSE are retained.
- Local history: [CHANGELOG.local.md](./CHANGELOG.local.md) records workspace-specific integration and reliability changes.

## Selected upstream changes adopted

- 1.0.3 delegation/help wording is adopted.
- The stale-attachment routing fix is adopted, so outdated attachments no longer block Notes or History lookup for unrelated agents.
- The package stays on the Pi 1.6.0/PCC 5.0.2 host line while preserving its public attachment, monitoring and settlement contracts.

## Current local differences

- package.json and README.md use the prepared installation workspace and integrate standalone Notes Compaction 0.0.19 and Agent Board 0.0.9 rather than adding the upstream Agent Comms package.
- The local Core 0.1.21 compatibility floor, native turn baseline, bounded parent-read retry, Windows close handling, attachment startup/cleanup, affected-session monitor refresh and bounded saved-session cache remain in place.
- Local regression tests cover attachment startup/cleanup, settlement and parent supervision. They are retained as package-owned offline checks.

Other runtime sources, Core-native resources and bundled profiles match the selected 1.0.3 baseline apart from the explicit standalone integration and reliability boundaries above.
