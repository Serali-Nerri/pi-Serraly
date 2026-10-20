# pi-apply-patch-protocol

Shared `apply_patch.v1` wire contract for the private pi-Serraly workspace: the format
identifier, the four output budgets, and the `ApplyPatch*` type declarations.

Consumers: the retained, unregistered patch implementation in `pi-tools` and the
presentation parser in `pi-ui`. Only `pi-ui` bundles it into its runtime entry; the
producer's behavior and conformance tests continue to use the same contract. The library
declares no runtime dependencies and no Pi resources.

```ts
import { APPLY_PATCH_FORMAT, PER_VIEW_DIFF_MAX_LINES, type ApplyPatchReport } from "pi-apply-patch-protocol";
```

Provenance and the producer/consumer contract split: [UPSTREAM.md](./UPSTREAM.md).
