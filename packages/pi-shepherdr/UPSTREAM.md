# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/c4f48525475f278d41dc311f2707926216bfa35b/packages/pi-shepherdr
- Baseline version: 1.0.4
- Upstream history and license: CHANGELOG.md and LICENSE are retained.
- Local history: [CHANGELOG.local.md](./CHANGELOG.local.md) records workspace-specific integration and reliability changes.

## Selected upstream changes adopted

- 1.0.4 delegation, discovery, settings and recovery wording is adopted.
- The stale-attachment routing fix is adopted, so outdated attachments no longer block Notes or History lookup for unrelated agents.
- Shepherdr's shared-context and Board integrations now consume Agent Comms 0.0.5's public exports.

## Current local differences

- package.json and README.md use the prepared installation workspace, provenance files and local changelog rather than the upstream npm publication workflow.
- The local Core 0.1.21 compatibility floor, native turn baseline, bounded parent-read retry, Windows close handling, attachment startup/cleanup, affected-session monitor refresh and bounded saved-session cache remain in place.
- Local regression tests cover attachment startup/cleanup, settlement and parent supervision. They are retained as package-owned offline checks.

Other runtime sources, Core-native resources and bundled profiles match the selected 1.0.4 baseline apart from the explicit Agent Comms integration and reliability boundaries above.
