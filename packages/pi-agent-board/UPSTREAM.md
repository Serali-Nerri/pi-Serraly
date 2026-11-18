# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/4006488d10e01b7da55c3ebac5b0a7913005ba00/packages/pi-agent-board
- Baseline version: 0.0.8
- Upstream history and license: CHANGELOG.md and LICENSE are retained.

## Current local differences

- package.json removes npm publish/prepack/pack lifecycle configuration and adds UPSTREAM.md to the shipped files. The viewer build and runtime/integration public entry names are retained.
- README.md uses a separately prepared installation workspace and native Pi registration; source-checkout use builds the viewer and loads the package explicitly instead of installing development code into settings. It clarifies optional PCC compatibility and immediate scoped Enabled changes without activation from opening settings.
- INTEGRATION.md identifies native Pi session IDs as public agent references and distinguishes saved legacy aliases from membership authority.
- AGENTS.md points maintenance at this package's source instead of an absent Agent Comms workspace. Existing archive, runtime and viewer rules live in src/board/AGENTS.md and src/board/viewer/AGENTS.md.
- src/board/archive.ts and awareness.ts optimize exact unread membership and seen-ID transport. src/board/viewer/archive.ts separates folder listings from board-scoped reads. The nearest AGENTS.md files record the query constraints.

Other runtime TypeScript sources and viewer assets match the baseline, apart from shared formatter output.
