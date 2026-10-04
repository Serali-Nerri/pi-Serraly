# loop upstream and migration

## Imported baseline

- Read-only reference: `/home/thelya/Work/Scripts/pi_loop`.
- No Git repository or commit exists; the complete working-tree source was
  `src/index.ts` (there were no existing tests).
- Baseline `src/index.ts` SHA-256:
  `b1fc05255e1331215bdd16ebdaec8eae522d6929bd442a05792ff6823d8404f0`.
- Parent baseline backup:
  `/tmp/pi-serraly-stage-two-sources-20261002-000556`.
- The reference README describes a local fixed-interval subset of Claude Code’s
  `/loop`. Its behavior and limitations are retained in the new README.
- **No LICENSE or NOTICE was present in the reference.** No license has been
  invented or inherited from another module. The package manifest omits the
  `license` field, and the packed payload retains this provenance in
  `dist/UPSTREAM.md`. The root license index must retain this absence; clarify
  permission before any redistribution.

## Deliberate adaptations

- Added private workspace manifest, actual-host peer dependency
  `@earendil-works/pi-coding-agent: "*"`, and strict per-module TypeScript checks.
  No runtime third-party dependencies are required beyond the host and Node.
- Converted source indentation to tabs without changing parser behavior.
- The command handler now returns a promise as required by Pi 0.99.2’s public
  command type. Syntax, `local-loop`, `agent_settled`, job state, limits,
  whitelisted slash prompts, and delivery options remain unchanged.
- RED-first regressions exposed unowned delivery-watchdog callbacks after
  shutdown/agent start and a dispatch latch stranded by synchronous delivery
  errors. The watchdog is now owned and cancelled on lifecycle resets; errors
  reset the latch and still propagate. Normal interval/coalescing behavior is
  unchanged.
- Added deterministic parser, cancellation, busy/queued-message, scheduling,
  expiry, slash-command and lifecycle tests using Node’s mock clock. Tests run
  the real factory/command/event handlers, capture the public delivery/UI
  boundaries, and never send model requests or read real sessions.
- README covers only module behavior and contracts. Standalone
  `scripts/deploy.mjs` was excluded; it targets the old global extension folder.
  There were no old deployment/packaging tests to remove.
- No reference `node_modules`, `.pi`, outputs, or lockfiles were imported.

Reference files and deployed extensions remain untouched. No credentials,
real sessions/settings, model requests, or global deployment were used.
