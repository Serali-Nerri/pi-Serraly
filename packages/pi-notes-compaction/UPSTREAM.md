# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/19ec6357fa3c4eb0126f8b0d4b6569de1a655ef9/packages/pi-notes-compaction
- Baseline version: 0.0.19
- Upstream release history and MIT LICENSE are retained. Workspace history has a separate [CHANGELOG.local.md](./CHANGELOG.local.md) section.

## Selected upstream changes adopted

- Explicit model-role IDs now survive rollover metadata; role descriptions and the read-only `/roles` screen follow upstream 0.0.19 behavior.
- Notes reads/lists/searches reuse loaded notes; shared remote-backed parent reads are fixed; History paging is bounded and ranked searches reuse their scope.
- The standalone package remains on Pi 1.6.0 and its public Notes/context-sharing contracts remain compatible with the local Shepherdr and PCC integrations.

## Current local differences

- package.json, README.md and AGENTS.md retain the standalone Notes Compaction installation/workspace policy instead of upstream Agent Comms packaging. Agent Comms remains an upstream alternative, not a new dependency here.
- Local notes reads still select surviving branch revisions before reading SQLite bodies and preserve ordered legacy edits/recovery fallbacks. Saved-session access keeps the local bounded reuse policy and validates identity/attachment ownership at each consuming edge.
- `new_context` remains inactive by default until Notes explicitly enables it, and the local fullscreen window keeps per-card click expansion alongside the global expansion shortcut.

Apart from the selected local boundaries above and shared formatter output, runtime sources, migration and history safeguards match the 0.0.19 baseline. [PCC-INTEGRATION.md](PCC-INTEGRATION.md) owns the optional same-cell rollover contract.
