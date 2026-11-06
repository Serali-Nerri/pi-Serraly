# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/5ede06bdc32da2b513f0709966af1f32908f243c/packages/pi-agent-board
- Baseline version: 0.0.5
- Upstream history and license: CHANGELOG.md and LICENSE are retained.

## Current local differences

- package.json removes npm publish/prepack/pack lifecycle configuration and adds UPSTREAM.md to the shipped files. The viewer build and runtime/integration public entry names are retained.
- README.md uses a separately prepared installation workspace and native Pi registration; source-checkout use builds the viewer and loads the package explicitly instead of installing development code into settings.

Runtime TypeScript sources and viewer assets match the baseline.
