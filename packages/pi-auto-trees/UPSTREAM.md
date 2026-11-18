# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/4006488d10e01b7da55c3ebac5b0a7913005ba00/packages/pi-auto-trees
- Baseline version: 0.1.19
- Upstream history and license: CHANGELOG.md and LICENSE are retained.

## Current local differences

- package.json removes npm publish/prepack/prepare/pack lifecycle configuration and adds UPSTREAM.md to the shipped files.
- README.md uses a separately prepared installation workspace and native Pi registration, states the supported host and optional Pi Codex Conversion versions, and keeps a local development flow without a pack dry run.

Runtime TypeScript sources match the baseline.
