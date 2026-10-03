# pi-apply-patch-protocol source record

## Extracted from

- Source module: `extensions/pi-tools` (`pi-apply-patch` lineage, Apache-2.0 in this
  workspace; the upstream parser/grammar origin is recorded in that module's
  `UPSTREAM.md`).
- Extracted in the current working tree: the `apply_patch.v1` wire types and the four
  output budgets were moved verbatim from `src/report.ts`, and the consumer-side type
  declarations were moved verbatim from the UI parser.

## Contract split

The library owns the wire contract only: `APPLY_PATCH_FORMAT`, the four output budgets
(`PER_VIEW_DIFF_MAX_LINES`, `PER_VIEW_DIFF_MAX_BYTES`, `TOTAL_DIFF_MAX_LINES`,
`TOTAL_DIFF_MAX_BYTES`) and the `ApplyPatch*` type declarations.

Both sides keep their own policy:

- the producer keeps its diff algorithm, edit/time/work budgets, truncation strategy and
  `reportUnavailable` fallback;
- the consumer keeps its change/view defence thresholds, sanitizer and degradation
  behavior for unknown or legacy shapes.

`LICENSE` is the Apache-2.0 text carried by `extensions/pi-tools`.
