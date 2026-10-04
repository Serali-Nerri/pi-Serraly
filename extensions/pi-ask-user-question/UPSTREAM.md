# questions upstream and migration

## Imported baseline

- Read-only reference: `/home/thelya/Work/Scripts/AskUserQuestion`.
- Git HEAD: `d3517efbc9f851b7dc62f44b802e2305472cecce`.
- Imported from the **current working tree**, not merely HEAD. Uncommitted files
  at migration were `README.md`, `package.json`, `package-lock.json`, `src/tool.ts`,
  and `test/tool.test.ts`. The source/test changes retain the `questions`
  namespace and `deferred` exposure.
- The parent’s baseline backup, including diffs, is
  `/tmp/pi-serraly-stage-two-sources-20261002-000556`.
- All nine `src/*.ts` files and all six `test/*.ts` files (five suites plus their
  helper) were copied unchanged. `LICENSE` is preserved verbatim: MIT,
  copyright 2026 Serali-Nerri.
- The reference README attributes the prompt, schema conventions, result
  mapping, labels, and behavior to Claude Code 2.1.259. Source attribution
  comments remain. The historical extraction record is preserved in
  `docs/claude-code-port.md`; its provenance is not rebranded as new work.

## Deliberate adaptations

- Private workspace package and strict per-module TypeScript boundary replace
  standalone dependency management. Actually imported host packages are peers
  with `"*"` ranges: `@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-tui`, and `typebox`. No host runtime copies or module-local
  development dependencies are shipped.
- Development/testing targets root-pinned Pi 1.0.2 and TypeBox 1.3.27 instead of
  the reference’s Pi 0.99.1 / TypeBox development range. Source behavior and
  every existing test are unchanged. Added `test/afk.test.ts` exercises the
  documented literal AFK environment names through timeout outcomes and countdown
  rendering, preserves partial-answer payloads and key-based idle reset, and checks
  immediate interval removal after manual submission, AFK completion, cancellation,
  and disposal. It uses the real dialog and a deterministic clock with interval
  ownership tracking; no production adaptation was needed.
- README now describes only module behavior, configuration, and contracts.
  Root scripts own building, isolated validation, and release staging.
- `scripts/deploy.mjs` and its `deploy` command were deliberately excluded.
  They target the old global extension directory and are not part of the new
  maintenance path. There were no deployment/packaging tests to remove.
- `node_modules`, `.pi`, old lockfiles, and reference repository metadata were
  not copied. The reference’s standalone AGENTS instructions were not imported;
  the destination workspace owns its guidelines.

Reference files were read only and remain unmodified; deployed extensions and
global settings were not changed. No real credentials, sessions, or settings
were read, and no model calls were made.
