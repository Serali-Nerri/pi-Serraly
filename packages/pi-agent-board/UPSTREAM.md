# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/a06eae4d141fae421a8d0108a4a560013d6508a8/packages/pi-agent-board
- Baseline version: 0.0.3
- Upstream history and license: CHANGELOG.md and LICENSE are retained unchanged.

## Current local differences

- package.json removes npm publish/prepack/pack lifecycle configuration and adds UPSTREAM.md to the shipped files. The viewer build and exported runtime/integration entries are unchanged.
- README.md uses a separately prepared installation workspace and native Pi registration; source-checkout use builds the viewer and loads the package explicitly instead of installing development code into settings.
- package.json exposes the existing changelog entry as ./changelog so the optional local aggregate preserves both Pi entries through public exports.

Runtime TypeScript sources and viewer assets match the baseline.
