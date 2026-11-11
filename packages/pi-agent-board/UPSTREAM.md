# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/096dbfca6af374ba23f6a5fe97e7c28566561a6c/packages/pi-agent-board
- Baseline version: 0.0.6
- Upstream history and license: CHANGELOG.md and LICENSE are retained.

## Current local differences

- package.json removes npm publish/prepack/pack lifecycle configuration and adds UPSTREAM.md to the shipped files. The viewer build and runtime/integration public entry names are retained.
- README.md uses a separately prepared installation workspace and native Pi registration; source-checkout use builds the viewer and loads the package explicitly instead of installing development code into settings.
- AGENTS.md points maintenance at this package's source instead of an absent Agent Comms workspace. Existing archive, runtime and viewer rules live in src/board/AGENTS.md and src/board/viewer/AGENTS.md.

Runtime TypeScript sources and viewer assets match the baseline.
