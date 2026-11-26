# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/5b641f0a7c7c93c53f9e9cda6abef498fc1441ef/packages/pi-agent-comms
- Baseline version: 0.0.7
- Upstream history and license: `CHANGELOG.md` and `LICENSE` are retained.

## Current local differences

- The package is maintained as a source-loaded workspace package. Publication hooks are removed, and workspace provenance/local history are shipped explicitly.
- Installation and source-checkout guidance uses this repository's prepared installation workspace rather than registering the development checkout directly in real Pi settings.
- Board/Notes protocols, saved-data paths and public integration exports follow upstream 0.0.7 (Pi 1.6.1 and optional Pi Codex Conversion 5.1.2); Shepherdr consumes those exports directly for shared context and Board routing.
- Local adaptations remain in place: `src/notes/tools.ts` registers `new_context` with `defaultActive: false` so `/tree` navigation does not auto-enable it when window requests are off; `src/notes/window-message.ts` adopts upstream 0.0.7's caret headers and keyboard-synced `views` state while accepting left-clicks anywhere on the context-window/reminder card rather than only the header row; `src/notes/notes.ts` and `src/notes/saved-session-access.ts` retain deferred SQLite body reads and bounded two-entry saved-session load reuse; and `src/board/archive.ts`, `src/board/awareness.ts` and `src/board/viewer/archive.ts` retain uncorrelated unread membership, seen-ID deduplication and board-scoped viewer queries.

Agent Comms replaces the former standalone `pi-agent-board` and `pi-notes-compaction` packages in this workspace. Existing saved data remains owned by Agent Comms at runtime; deleting the old source packages does not delete user data.
