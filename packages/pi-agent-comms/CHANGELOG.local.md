# Local changes

## Unreleased

- Replace the maintained standalone Board and Notes Compaction packages with upstream Agent Comms 0.0.5, while retaining the repository's source-loaded installation and provenance policy.
- Carry forward the local Notes and Board adaptations not covered upstream: `new_context` `defaultActive: false` across `/tree` navigation, click-to-expand context-window/reminder cards, deferred SQLite note body loading, bounded two-entry saved-session load reuse, uncorrelated unread catch-up queries, seen-ID deduplication and board-scoped viewer reads.
