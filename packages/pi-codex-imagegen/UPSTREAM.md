# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/19ec6357fa3c4eb0126f8b0d4b6569de1a655ef9/packages/pi-codex-imagegen
- Baseline version: 0.0.16
- Upstream history and license: CHANGELOG.md and LICENSE are retained. UPSTREAM_SYNC.md and the nested upstream license remain in place.
- Local history: [CHANGELOG.local.md](./CHANGELOG.local.md) records the gateway and validation adaptations.

## Selected upstream changes adopted

- 0.0.16's image artifact path is adopted: generated images are displayed from the already-produced artifact instead of being reread from disk, and help describes the active access mode and explicit edit selectors.
- Upstream text-only result ownership and Pi 1.6-compatible tool contracts are retained in the ordinary and Code Mode paths.

## Current local differences

- The package uses this repository's prepared installation workspace, provenance files and local changelog instead of the upstream npm publication workflow.
- API settings retain the local explicit base URL, Pi credential-provider ID and custom image model. Official defaults and Codex OAuth routing remain separate; gateway credentials are never written into the imagegen settings file.
- Custom models retain the upstream quality choices but expose only still-image controls. Preset-only complexity, GIF and SVG controls stay aligned across settings, request validation and Code Mode schemas.
- Local input boundaries retain PNG chunk integrity validation, encoded data-URL size admission before reading local files, and the distinction between Codex's larger edit inputs and OpenAI API limits.
- The local Code Mode description keeps the detailed, settings-aware selector and result guidance needed by this workspace. The package continues to use Pi's result-image display rather than drawing a duplicate preview in the tool card.

Usage is defined in [README.md](README.md); the Codex reference and review history remain in [UPSTREAM_SYNC.md](UPSTREAM_SYNC.md).
