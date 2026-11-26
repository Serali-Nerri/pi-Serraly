# Local changes

## Unreleased

- Sync to upstream Agent Comms 0.0.7 (`5b641f0`) for Pi 1.6.1 and optional Pi Codex Conversion 5.1.2: adopt upstream 0.0.6/0.0.7 help/error/pruning updates and the `▾`/`▸` caret header with keyboard-synced `views` state in `src/notes/window-message.ts`, while keeping the entire context-window/reminder card clickable (not restricted to the header row), `new_context` `defaultActive: false`, deferred SQLite note body loading, bounded two-entry saved-session load reuse, and Board query/deduplication/viewer adaptations.
- Replace the maintained standalone Board and Notes Compaction packages with upstream Agent Comms 0.0.5, while retaining the repository's source-loaded installation and provenance policy.
- Carry forward the local Notes and Board adaptations not covered upstream: `new_context` `defaultActive: false` across `/tree` navigation, click-to-expand context-window/reminder cards, deferred SQLite note body loading, bounded two-entry saved-session load reuse, uncorrelated unread catch-up queries, seen-ID deduplication and board-scoped viewer reads.
