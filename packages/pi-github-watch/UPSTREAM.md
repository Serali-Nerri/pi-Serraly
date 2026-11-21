# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/19ec6357fa3c4eb0126f8b0d4b6569de1a655ef9/packages/pi-github-watch
- Baseline version: 0.0.8
- Runtime source: `index.ts` and all files under `src/` match the upstream 0.0.8 implementation.
- Upstream history and license: CHANGELOG.md and LICENSE are retained.

## Current local differences

- package.json retains this workspace's provenance/local-history file list, removes npm publication lifecycle hooks, and records the Pi 1.6/PCC 5.0.2 development line.
- No local repository-watch implementation remains. The `Repository` target, issue/PR discovery, new-thread delivery and related setup behavior were deliberately discarded in favor of upstream 0.0.8, per the sync decision.

The extension remains opt-in and session-scoped; loading it does not contact GitHub. The local historical record is in [CHANGELOG.local.md](CHANGELOG.local.md), while current usage is defined by the upstream [README.md](README.md).
