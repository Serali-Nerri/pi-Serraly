# pi-apply-patch-protocol

Shared `apply_patch.v1` wire contract for the private pi-Serraly workspace: the format
identifier, the four output budgets, and the `ApplyPatch*` type declarations.

Consumers: `pi-tools` (producer) and `pi-ui` (presentation parser). The library declares
no runtime dependencies and no Pi resources; it is bundled into each consumer at build
time, and its license text travels with the consumer payload.

```ts
import { APPLY_PATCH_FORMAT, PER_VIEW_DIFF_MAX_LINES, type ApplyPatchReport } from "pi-apply-patch-protocol";
```

Provenance and the producer/consumer contract split: [UPSTREAM.md](./UPSTREAM.md).
