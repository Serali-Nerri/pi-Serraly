# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/c3b422c60256907f5a4499cc44e4d055ac3cc28a/packages/pi-agent-board
- Baseline version: 0.0.7
- Upstream history and license: CHANGELOG.md and LICENSE are retained.

## Current local differences

- package.json removes npm publish/prepack/pack lifecycle configuration and adds UPSTREAM.md to the shipped files. The viewer build and runtime/integration public entry names are retained.
- README.md uses a separately prepared installation workspace and native Pi registration; source-checkout use builds the viewer and loads the package explicitly instead of installing development code into settings. It clarifies optional PCC compatibility and immediate scoped Enabled changes without activation from opening settings.
- AGENTS.md points maintenance at this package's source instead of an absent Agent Comms workspace. Existing archive, runtime and viewer rules live in src/board/AGENTS.md and src/board/viewer/AGENTS.md.

Runtime TypeScript sources and viewer assets match the baseline.
