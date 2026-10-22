# pi-apply-patch-protocol

Shared `apply_patch.v1` wire contract for the private pi-Serraly workspace: the format
identifier, the four output budgets, and the `ApplyPatch*` type declarations.

Consumer: the presentation parser in `pi-ui`, which bundles the library into its
runtime entry. The library declares no runtime dependencies and no Pi resources.

```ts
import { APPLY_PATCH_FORMAT, PER_VIEW_DIFF_MAX_LINES, type ApplyPatchReport } from "pi-apply-patch-protocol";
```

Provenance and the contract split: [UPSTREAM.md](./UPSTREAM.md).
