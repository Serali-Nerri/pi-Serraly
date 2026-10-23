# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/a06eae4d141fae421a8d0108a4a560013d6508a8/packages/pi-auto-trees
- Baseline version: 0.1.18
- Upstream history and license: CHANGELOG.md and LICENSE are retained unchanged.

## Current local differences

- package.json removes npm publish/prepack/prepare/pack lifecycle configuration and adds UPSTREAM.md to the shipped files.
- README.md installs from an immutable release and its local development flow runs check and an explicit one-session load without a pack dry run.

Runtime TypeScript sources match the baseline.
