# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/4006488d10e01b7da55c3ebac5b0a7913005ba00/packages/pi-notes-compaction
- Baseline version: 0.0.18
- Upstream release history and MIT LICENSE are retained; workspace changes have a separate CHANGELOG.md section.

## Current local differences

- package.json removes npm publishing configuration, ships UPSTREAM.md and aligns development Pi versions with this workspace. The standalone Pi entry, public import keys and native SQLite dependency are retained; schema validation uses Pi's native schema package.
- README.md describes individual or aggregate installation, the native SQLite dependency, optional PCC compatibility and session-pruning defaults and consequences, including automatic Linux exit cleanup for already-enabled retention. Agent Comms remains an upstream alternative, not an installed dependency.
- AGENTS.md points maintenance at this package's source instead of an absent Agent Comms workspace. Existing history and resource rules live in src/notes/AGENTS.md.
- src/notes/tools.ts registers new_context with defaultActive:false. Notes still explicitly enables it when window requests are allowed; Pi no longer automatically activates this never-enabled tool after tree navigation with requests off. Explicit historical activation is unchanged.
- src/notes/notes.ts selects surviving branch revisions before reading SQLite bodies and preserves ordered legacy edits and recovery fallbacks. Local and saved queries reuse the materialized notes within one query.
- src/notes/saved-session-access.ts reuses the two most recent successful loads by resolved machine/session path within a saved-family request, bounding additional transcript retention. Identity, family membership and attachment ownership checks remain at each consuming edge; failures are not cached.
- src/notes/window-message.ts retains per-card click expansion in fullscreen Pi alongside the configured global expansion shortcut.

Apart from the changes above and shared formatter output, runtime sources, migration and history safeguards match the baseline. PCC-INTEGRATION.md describes the current optional same-cell rollover contract.
