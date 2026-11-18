# Local changes

## Unreleased

- Sync upstream c3b422c to 4006488 (1.0.2): restore resumed-worker reporting and sticky unwatch, publish identity before launch readiness, fix standalone Bun helper execution, suppress empty unassigned completion notices, refresh sender guidance and adopt the new general profile.
- Adopt upstream Oxfmt/Oxlint/tsrs static checks without publishing hooks; retain separate offline tests and standalone Notes Compaction 0.0.18 / Agent Board 0.0.8 integration dependencies.
- Retain the local Core 0.1.21 native-turn settlement gates, remote/voice attachment and shutdown safeguards, parent-read retry ownership, Windows acknowledged-close handling and scoped monitor/cache optimizations; upstream's new lifecycle fixes do not replace them.
- Keep upstream release history in CHANGELOG.md; retain the local monitor/cache history here: refresh only affected session views, bound saved-session summaries with an LRU cache, and filter discovery status before live identity lookup.
- Fix Windows peer `/quit` and close-idle reporting an unacknowledged delivery after a valid closing receipt. Handle the subsequent connection reset and normal EOF through one terminal cleanup path, retaining failures for unacknowledged delivery, other socket errors and failed cleanup.
