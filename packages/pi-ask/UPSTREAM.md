# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/096dbfca6af374ba23f6a5fe97e7c28566561a6c/packages/pi-ask
- Baseline version: 0.0.19
- Upstream history and license: CHANGELOG.md and LICENSE are retained.

## Current local differences

- package.json removes npm publish/prepack/pack lifecycle configuration, adds UPSTREAM.md to the shipped files.
- README.md uses a separately prepared installation workspace and native Pi registration, keeps an explicit one-session load, and states the supported host and optional Pi Codex Conversion versions.
- AGENTS.md retains the local composition-root instruction.
- The outdated Code Mode error reflects the supported 4.0.10 peer minimum.

Other runtime TypeScript sources match the baseline.
