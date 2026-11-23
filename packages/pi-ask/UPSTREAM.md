# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/c4f48525475f278d41dc311f2707926216bfa35b/packages/pi-ask
- Baseline version: 0.0.22
- Upstream history and license: CHANGELOG.md and LICENSE are retained.

## Current local differences

- package.json removes npm publish/prepack/pack lifecycle configuration, adds UPSTREAM.md to the shipped files.
- README.md uses a separately prepared installation workspace and native Pi registration, keeps an explicit one-session load, and states the supported host and optional Pi Codex Conversion versions.
- AGENTS.md retains the local composition-root instruction.
- The 0.0.22 compact help is adopted without changing the local package entry and installation documentation.

Other runtime TypeScript sources match the selected upstream baseline.
