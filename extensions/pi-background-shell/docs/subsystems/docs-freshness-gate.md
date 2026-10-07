---
{
  "doc_id": "subsystems/docs-freshness-gate",
  "covers_sources": [],
  "covers_surfaces": []
}
---
# Documentation, build and payload gates

The gate is a focused deterministic data extractor, not an extension interpreter or semantic certification. No feature/Fusion combinators, archived attestations or removed model schemas remain.

## Source to docs

TypeScript AST extraction accepts direct unconditional tool/command/renderer calls and only the two direct `config.dockShortcut` conditions. Aliased/computed registration calls, duplicates, unsupported metadata expressions, spread/shorthand metadata, prompt fields and `before_agent_start` fail. New public names fail the fixed four-tool/seven-command inventory.

Only the current session-start/shutdown lifecycle hooks are accepted; alternate prompt-injection hooks also fail. Controlled schema/description imports cannot be shadowed.

Schemas use the current controlled Type.Object/String/Number/Boolean/Optional grammar, extracting parameter descriptions, required fields and constraints. `bg_run` must use exported literal `BG_RUN_DESCRIPTION` plus exactly `shellPolicyDescription(shellPolicy)` imported from shell-policy. Docs record the base and suffix rule; executable/args are runtime-only, checked by SDK tests. Arbitrary extension code is never evaluated and shell-selection environment variables are never read. Log-size descriptions allow data-only `formatSize`/numeric constants using Pi 1.0.4's 50 KiB host cap; host-schema parity is separately tested.

EventBus checks six fork v2 constants, api_version 2, closed run validator keys against the interface, and required/optional run fields. Reload protocol/audit identity and status/dock enums are checked. All production modules have exactly one explicit source owner; non-tool public surfaces have one prose owner. Tool pages, INDEX, owner map, runtime contracts and manifest are generated. Source and authored-prose hashes (including README, TESTING and UPSTREAM) detect stale changes, without pretending a regenerated hash is a human behavioral review. The exact documentation inventory rejects retired evidence and unknown artifacts.

`docs:generate` writes artifacts only after coverage checks. `docs:verify` renders twice in memory, compares bytes, checks local links/anchors and documentation reachability, and never writes files. Review source/prose changes before regenerating. Selftests mutate fields/expressions/coverage/prose/imports/payload and test independence from shell-selection environment.

## Runtime and pack

Build compiles and seals a new sibling candidate without clearing live dist. It emits the background entry and its runtime closure plus maps/dist package metadata, and rejects missing/unreachable/orphan files. The sealed candidate replaces live dist; failed validation restores the previous complete artifact. Ordinary tsc maps resolve back to the matching current TypeScript and embed matching source bytes; their JavaScript must match a data-only transpilation of that source. Only the manifest-declared bundled leaf uses a multi-source map and the shared bundler's input/closure checks. Deferred import targets must be literal, reachable and shipped.

`build` (also available as `build:runtime`) compiles, seals and validates the artifact and payload once. `prepack` runs `docs:verify` then `build`, without a second `pack:check`. Standalone `payload:check` and `pack:check` validate existing built artifacts without rebuilding. Verification and test commands are documented in [TESTING.md](../../TESTING.md).

Payload uses isolated npm home/cache/config/tmp with `pack --dry-run --ignore-scripts`, avoiding recursive prepack. Packed paths must exactly match source/dist/docs and the six module deliverables (including the historical changelog); tests/scripts/node_modules/tarballs or private host SDK copies cannot ship. Pi libraries and TypeBox are wildcard host peers; dev verification is pinned to Pi 1.0.4 and TypeBox 1.3.27, not an inherited compatibility range.

Package tests preserve durable-fs and file-URL safety guards, static lazy UI boundaries, compiled/source entry loading, raw output, isolated offline local tarball install, real host loading without bundled SDK, and bounded deferred-UI failure/close behavior. Root CI runs `npm run verify` once, including the package suites; no live paid calls or publication.
