# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/c3b422c60256907f5a4499cc44e4d055ac3cc28a/packages/pi-github-watch
- Baseline version: 0.0.6
- Upstream history and license: CHANGELOG.md and LICENSE are retained.

## Current local differences

- package.json removes npm packing lifecycle commands, adds UPSTREAM.md to shipped files, and declares the workspace Node.js minimum.
- README.md uses a separately prepared installation workspace and native Pi registration, links to the optional local aggregate, and corrects the supported Pi minimum to match the manifest.

Runtime TypeScript sources and static-check configuration match the baseline. Watches remain opt-in and session-scoped; loading the package does not contact GitHub.
