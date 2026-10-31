# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/e4aa5bb43c560b722829a5123b3f2e05d3d9a19d/packages/pi-auto-trees
- Baseline version: 0.1.19
- Upstream history and license: CHANGELOG.md and LICENSE are retained.

## Current local differences

- package.json removes npm publish/prepack/prepare/pack lifecycle configuration and adds UPSTREAM.md to the shipped files.
- README.md uses a separately prepared installation workspace and native Pi registration; its local development flow runs check and an explicit one-session load without a pack dry run.

Runtime TypeScript sources match the baseline.
