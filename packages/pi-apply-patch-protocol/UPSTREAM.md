# pi-apply-patch-protocol source record

## Extracted from

- Source: the `apply_patch.v1` wire report and parser previously maintained in this
  workspace. The current tree retains the presentation parser in
  `extensions/pi-ui/src/transcript/tool/apply-patch.ts`.
- The wire types and the four output budgets were moved verbatim from the report
  implementation, and the consumer-side type declarations were moved verbatim from
  the UI parser.

## Contract split

The library owns the wire contract only: `APPLY_PATCH_FORMAT`, the four output budgets
(`PER_VIEW_DIFF_MAX_LINES`, `PER_VIEW_DIFF_MAX_BYTES`, `TOTAL_DIFF_MAX_LINES`,
`TOTAL_DIFF_MAX_BYTES`) and the `ApplyPatch*` type declarations.

The consumer keeps its own policy: diff reconstruction, change/view defence
thresholds, sanitizer and degradation behavior for unknown or legacy shapes.
