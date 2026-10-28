# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/d67cb69b22decc4ea024236ba59dc4ddae9a2334/packages/pi-ask
- Baseline version: 0.0.17
- Upstream history and license: CHANGELOG.md and LICENSE are retained.

## Current local differences

- package.json removes npm publish/prepack/pack lifecycle configuration, adds UPSTREAM.md to the shipped files, keeps the check, typecheck, lint and format scripts, and pins the typebox devDependency to the Pi 1.4.0 host's 1.3.27.
- README.md uses a separately prepared installation workspace and native Pi registration, keeps an explicit one-session load, and links Pi Codex Conversion by name rather than npm.
- AGENTS.md describes changelog.ts as shared release UI and keeps its registration and channel contract stable.
- The outdated Code Mode error reflects the supported 4.0.5 peer minimum.

Other runtime TypeScript sources match the baseline.
