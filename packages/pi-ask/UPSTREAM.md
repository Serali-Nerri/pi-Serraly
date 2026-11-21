# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/19ec6357fa3c4eb0126f8b0d4b6569de1a655ef9/packages/pi-ask
- Baseline version: 0.0.21
- Upstream history and license: CHANGELOG.md and LICENSE are retained.

## Current local differences

- package.json removes npm publish/prepack/pack lifecycle configuration, adds UPSTREAM.md to the shipped files.
- README.md uses a separately prepared installation workspace and native Pi registration, keeps an explicit one-session load, and states the supported host and optional Pi Codex Conversion versions.
- AGENTS.md retains the local composition-root instruction.
- The outdated Code Mode error reflects the supported 5.0.2 peer minimum.
- The 0.0.21 shorter review/planning prompts are adopted without changing the local package entry and installation documentation.

Other runtime TypeScript sources match the selected upstream baseline.
