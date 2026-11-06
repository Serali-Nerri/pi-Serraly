# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/5ede06bdc32da2b513f0709966af1f32908f243c/packages/pi-ask
- Baseline version: 0.0.18
- Upstream history and license: CHANGELOG.md and LICENSE are retained.

## Current local differences

- package.json removes npm publish/prepack/pack lifecycle configuration, adds UPSTREAM.md to the shipped files, and pins the typebox devDependency to the Pi 1.5.0 host's 1.3.27.
- README.md uses a separately prepared installation workspace and native Pi registration, keeps an explicit one-session load, and states the supported host and optional Pi Codex Conversion versions.
- AGENTS.md retains the local composition-root instruction.
- The outdated Code Mode error reflects the supported 4.0.9 peer minimum.

Other runtime TypeScript sources match the baseline.
