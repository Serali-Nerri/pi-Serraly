# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/d67cb69b22decc4ea024236ba59dc4ddae9a2334/packages/pi-notes-compaction
- Baseline version: 0.0.10
- Upstream history: CHANGELOG.md is retained unchanged. The upstream root MIT LICENSE is included because the upstream package has no separate license file.

## Current local differences

- package.json removes npm publishing configuration, ships UPSTREAM.md and LICENSE, and aligns development Pi and TypeBox versions with this workspace. Both Pi extension entries and the public context-sharing export are retained.
- package.json exposes the existing changelog entry as ./changelog so the optional local aggregate preserves both Pi entries through public exports.
- README.md describes individual or aggregate installation, the native SQLite dependency and session-pruning defaults and consequences.

Runtime sources, migration and history safeguards match the baseline.
