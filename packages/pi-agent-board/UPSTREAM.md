# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/19ec6357fa3c4eb0126f8b0d4b6569de1a655ef9/packages/pi-agent-board
- Baseline version: 0.0.9
- Upstream history and license: CHANGELOG.md and LICENSE are retained.

## Current local differences

- package.json removes npm publish/prepack/pack lifecycle configuration and adds UPSTREAM.md to the shipped files. The viewer build and runtime/integration public entry names are retained.
- README.md uses a separately prepared installation workspace and native Pi registration; source-checkout use builds the viewer and loads the package explicitly instead of installing development code into settings. It clarifies optional PCC compatibility and immediate scoped Enabled changes without activation from opening settings.
- INTEGRATION.md identifies native Pi session IDs as public agent references and distinguishes saved legacy aliases from membership authority.
- AGENTS.md points maintenance at this package's source instead of an absent Agent Comms workspace. Existing archive, runtime and viewer rules live in src/board/AGENTS.md and src/board/viewer/AGENTS.md.
- The 0.0.9 runtime and guidance changes are adopted: `reply` is accepted as a posting alias, and help explains full thread IDs and closed-thread recovery.
- src/board/archive.ts and awareness.ts optimize exact unread membership and seen-ID transport. src/board/viewer/archive.ts separates folder listings from board-scoped reads. The nearest AGENTS.md files record the query constraints.

Other runtime TypeScript sources and viewer assets match the selected upstream baseline, apart from the local files and shared formatter output above.
