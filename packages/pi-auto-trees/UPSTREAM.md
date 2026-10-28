# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/d67cb69b22decc4ea024236ba59dc4ddae9a2334/packages/pi-auto-trees
- Baseline version: 0.1.19
- Upstream history and license: CHANGELOG.md and LICENSE are retained.

## Current local differences

- package.json removes npm publish/prepack/prepare/pack lifecycle configuration and adds UPSTREAM.md to the shipped files.
- README.md uses a separately prepared installation workspace and native Pi registration; its local development flow runs check and an explicit one-session load without a pack dry run.

Runtime TypeScript sources match the baseline.
