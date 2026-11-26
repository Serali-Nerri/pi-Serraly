# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/5b641f0a7c7c93c53f9e9cda6abef498fc1441ef/packages/pi-ask
- Baseline version: 0.0.23
- Upstream history and license: CHANGELOG.md and LICENSE are retained.
- Local history: [CHANGELOG.local.md](./CHANGELOG.local.md) records workspace-specific behavior changes.

## Current local differences

- package.json removes npm publish/prepack/pack lifecycle configuration, adds UPSTREAM.md and CHANGELOG.local.md to the shipped files, and aligns Pi 1.6.1 and optional Pi Codex Conversion 5.1.2 pins/peers.
- README.md uses a separately prepared installation workspace and native Pi registration, keeps an explicit one-session load, and states the supported Pi 1.6.1 and optional Pi Codex Conversion 5.1.2 versions.
- 0.0.23's shortened Ask replies, steering receipts and invalid-field errors are adopted; the outdated-PCC Code Mode error message in `index.ts` aligns with the 5.1.2 peer floor.

Other runtime TypeScript sources match the selected upstream baseline.
