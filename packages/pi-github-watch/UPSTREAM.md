# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/5b641f0a7c7c93c53f9e9cda6abef498fc1441ef/packages/pi-github-watch
- Baseline version: 0.0.10
- Runtime source: `index.ts` and all files under `src/` match the upstream 0.0.10 implementation.
- Upstream history and license: CHANGELOG.md and LICENSE are retained.

## Current local differences

- package.json retains this workspace's provenance/local-history file list and `engines.node >=22.19.0`, removes npm publication lifecycle hooks, and records the Pi 1.6.1 / PCC 5.1.2 development line.
- No local repository-watch implementation remains. The `Repository` target, issue/PR discovery, new-thread delivery and related setup behavior remain discarded in favor of the upstream baseline, per the sync decision.

The extension remains opt-in and session-scoped; loading it does not contact GitHub. The local historical record is in [CHANGELOG.local.md](CHANGELOG.local.md), while current usage is defined by the upstream [README.md](README.md).
