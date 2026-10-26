# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/a06eae4d141fae421a8d0108a4a560013d6508a8/packages/pi-codex-imagegen
- Baseline version: 0.0.11
- Upstream history and license: CHANGELOG.md and LICENSE are retained. UPSTREAM_SYNC.md and the nested upstream license remain in place.

## Current local differences

- package.json removes npm publish/prepack/pack lifecycle configuration, adds UPSTREAM.md to the shipped files, and pins the typebox devDependency to the Pi 1.4.0 host's 1.3.27.
- README.md uses a separately prepared installation workspace and native Pi registration.
- AGENTS.md describes the OpenAI Codex reference relative to a checkout's codex-rs directory instead of a local absolute path.

Runtime TypeScript sources match the baseline.
