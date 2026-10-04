# pi-config-core

Bounded, atomic JSON file I/O for the private pi-Serraly workspace. The library owns
the mechanism; every consumer keeps its own error, trust and merge policy.

```ts
import { readJsonFileBoundedSync, writeTextFileAtomicSync, type JsonFileRead } from "pi-config-core";

const read: JsonFileRead = readJsonFileBoundedSync(path, 64 * 1024);
writeTextFileAtomicSync(path, `${JSON.stringify(value, null, 2)}\n`, 64 * 1024);
```

## Contract

- `readJsonFileBoundedSync(path, maxBytes)` returns `{source: "missing"}` when the file
  does not exist (it is never created) and `{source: "file", value}` otherwise. `value`
  is `unknown`; shape validation belongs to the consumer. Any other failure — an
  unreadable path, a non-regular target, a file larger than `maxBytes`, invalid UTF-8 or
  invalid JSON — throws. Symlinks are followed, but the opened target must be a regular
  file, and the read never blocks on a FIFO.
- `writeTextFileAtomicSync(path, contents, maxBytes)` checks the encoded size before any
  side effect, then writes `<name>.<pid>.<uuid>.tmp` in the same directory with `wx` and
  `0600` and renames it over the target only after all bytes are written. A missing
  parent directory is created with `0700`; an existing parent directory keeps its mode.
  Failures clean up the temporary file and propagate; a write failure before rename
  leaves the original target unchanged. There is no lock and no crash-durable `fsync`:
  concurrent writers are last-writer-wins, and every successful write is complete.
- `maxBytes` must be a positive safe integer; a bad argument throws before any I/O.

Consumers: `pi-ui` (64 KiB, `claude-style-tools.json`) and `pi-subagents` (64 KiB,
`subagents-lite.json`). The library is bundled into each consumer at build time.
Provenance: [UPSTREAM.md](./UPSTREAM.md).
