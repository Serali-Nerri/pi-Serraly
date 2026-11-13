# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/c3b422c60256907f5a4499cc44e4d055ac3cc28a/packages/pi-codex-imagegen
- Baseline version: 0.0.14
- Upstream history and license: CHANGELOG.md and LICENSE are retained. UPSTREAM_SYNC.md and the nested upstream license remain in place.

## Current local differences

- package.json removes npm publish/prepack/pack lifecycle configuration, ships UPSTREAM.md and CHANGELOG.local.md.
- README.md uses a separately prepared installation workspace and native Pi registration, states the supported optional Pi Codex Conversion version, and clarifies that GIF previews may be unavailable.
- AGENTS.md describes the OpenAI Codex reference relative to a checkout's codex-rs directory instead of a local absolute path, distinguishes the supported edit formats by access route, and records image-display, settings-input and route-ownership constraints. UPSTREAM_SYNC.md retains the local reference and review history.
- The outdated Code Mode error reflects the supported 5.0.0 peer minimum.
- API settings add an explicit base URL, Pi credential-provider ID and custom image model. Official defaults and the Codex resolver are unchanged.
- Custom models retain upstream's six quality choices while exposing only standard still-image controls. Settings UI, request construction and ordinary/Code Mode schemas agree on preset-only controls; native dialogs refresh the schema without resetting quality.
- Settings validation is owned by file/UI input boundaries rather than repeated for typed persistence.
- Custom result rendering is text-only; Pi owns image display without changing model-visible content.

Usage is defined in README.md; local change history is in CHANGELOG.local.md.
