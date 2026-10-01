# Private Pi package

Stage one implements only `modules/ui`. Stop for user acceptance before adding
the other five modules or changing global Pi settings/extensions.

Use TypeScript ESM, `.ts` relative imports, tabs and double quotes. Preserve
upstream attribution. Keep all private host API access under `src/compat/`.
Only `src/lifecycle.ts` registers UI events with Pi. Views and controllers
receive snapshots, event routing, and the shared UI scheduler.

Run `npm run verify` against Pi 0.99.2. Use temporary agent directories, empty
working folders, synthetic sessions, and scripted providers. Never read real
auth/session files or send real model requests during validation.

Development dependencies belong to this workspace only. Compiled runtime
packages must be staged outside this dependency tree with no physical Pi host
copies. Do not deploy globally in stage one.

Source repositories are read-only migration references. No resets, commits,
deletes, or deploy scripts there. Do not commit without an explicit request.
