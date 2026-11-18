# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/4006488d10e01b7da55c3ebac5b0a7913005ba00/packages/pi-codex-imagegen
- Baseline version: 0.0.15
- Upstream history and license: CHANGELOG.md and LICENSE are retained. UPSTREAM_SYNC.md and the nested upstream license remain in place.

## Current local differences

- package.json removes npm publish/prepack/pack lifecycle configuration, ships UPSTREAM.md and CHANGELOG.local.md.
- README.md uses a separately prepared installation workspace and native Pi registration, states the supported optional Pi Codex Conversion version, and clarifies that GIF previews may be unavailable.
- AGENTS.md describes the OpenAI Codex reference relative to a checkout's codex-rs directory instead of a local absolute path, distinguishes the supported edit formats by access route, and records settings-input and route-ownership constraints. UPSTREAM_SYNC.md retains the local reference and review history.
- The outdated Code Mode error reflects the supported 5.0.1 peer minimum.
- API settings add an explicit base URL, Pi credential-provider ID and custom image model. Official defaults and the Codex resolver are unchanged.
- Custom models retain upstream's six quality choices while exposing only standard still-image controls. Settings UI, request construction and ordinary/Code Mode schemas agree on preset-only controls; native dialogs refresh the schema without resetting quality.
- Settings validation is owned by file/UI input boundaries rather than repeated for typed persistence.
- PNG chunk integrity checks use Node's native CRC32. Local API edit files are admitted against the encoded data-URL limit before reading, without restricting Codex inputs.

Usage is defined in README.md; local change history is in CHANGELOG.local.md.
