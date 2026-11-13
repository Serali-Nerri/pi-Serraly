# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/c3b422c60256907f5a4499cc44e4d055ac3cc28a/packages/pi-notes-compaction
- Baseline version: 0.0.17
- Upstream history and license: CHANGELOG.md and the MIT LICENSE are retained unchanged.

## Current local differences

- package.json removes npm publishing configuration, ships UPSTREAM.md and aligns development Pi versions with this workspace. The standalone Pi entry, public import keys and native SQLite dependency are retained; schema validation uses Pi's native schema package.
- README.md describes individual or aggregate installation, the native SQLite dependency, optional PCC compatibility and session-pruning defaults and consequences, including automatic Linux exit cleanup for already-enabled retention. Agent Comms remains an upstream alternative, not an installed dependency.
- AGENTS.md points maintenance at this package's source instead of an absent Agent Comms workspace. Existing history and resource rules live in src/notes/AGENTS.md.
- src/notes/tools.ts registers new_context with defaultActive:false. Notes still explicitly enables it when window requests are allowed; Pi no longer automatically activates this never-enabled tool after tree navigation with requests off. Explicit historical activation is unchanged.

Apart from the tool-registration default above, runtime sources, migration and history safeguards match the baseline.
