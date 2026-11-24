# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/c4f48525475f278d41dc311f2707926216bfa35b/packages/pi-agent-comms
- Baseline version: 0.0.5
- Upstream history and license: `CHANGELOG.md` and `LICENSE` are retained.

## Current local differences

- The package is maintained as a source-loaded workspace package. Publication hooks are removed, and workspace provenance/local history are shipped explicitly.
- Installation and source-checkout guidance uses this repository's prepared installation workspace rather than registering the development checkout directly in real Pi settings.
- Board/Notes protocols, saved-data paths and public integration exports follow upstream 0.0.5; Shepherdr consumes those exports directly for shared context and Board routing.
- Local adaptations carried over from the former standalone packages remain in place: `src/notes/tools.ts` registers `new_context` with `defaultActive: false` so `/tree` navigation does not auto-enable it when window requests are off; `src/notes/window-message.ts` supports click-to-expand on context-window and reminder cards; `src/notes/notes.ts` and `src/notes/saved-session-access.ts` retain deferred SQLite body reads and bounded two-entry saved-session load reuse; and `src/board/archive.ts`, `src/board/awareness.ts` and `src/board/viewer/archive.ts` retain uncorrelated unread membership, seen-ID deduplication and board-scoped viewer queries.

Agent Comms replaces the former standalone `pi-agent-board` and `pi-notes-compaction` packages in this workspace. Existing saved data remains owned by Agent Comms at runtime; deleting the old source packages does not delete user data.
