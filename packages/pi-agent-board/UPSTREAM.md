# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/e4aa5bb43c560b722829a5123b3f2e05d3d9a19d/packages/pi-agent-board
- Baseline version: 0.0.4
- Upstream history and license: CHANGELOG.md and LICENSE are retained.

## Current local differences

- package.json removes npm publish/prepack/pack lifecycle configuration and adds UPSTREAM.md to the shipped files. The viewer build and runtime/integration public entry names are retained.
- README.md uses a separately prepared installation workspace and native Pi registration; source-checkout use builds the viewer and loads the package explicitly instead of installing development code into settings.
- package.json exposes the existing changelog entry as ./changelog so the optional local aggregate preserves both Pi entries through public exports.

Runtime TypeScript sources and viewer assets match the baseline.
