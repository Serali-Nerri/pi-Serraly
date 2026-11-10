# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/672ec0437b76b075d031fdd072a4f6529303e5d6/packages/pi-notes-compaction
- Baseline version: 0.0.15
- Upstream history: CHANGELOG.md is retained unchanged. The upstream root MIT LICENSE is included because the upstream package has no separate license file.

## Current local differences

- package.json removes npm publishing configuration, ships UPSTREAM.md and LICENSE, and aligns development Pi and TypeBox versions with this workspace. The Pi extension entry, public context-sharing export and native SQLite runtime dependency are retained.
- README.md describes individual or aggregate installation, the native SQLite dependency and session-pruning defaults and consequences.
- src/tools.ts registers new_context with defaultActive:false. Notes still explicitly enables it when window requests are allowed; Pi no longer automatically activates this never-enabled tool after tree navigation with requests off. Explicit historical activation is unchanged.

Apart from the tool-registration default above, runtime sources, migration and history safeguards match the baseline.
