# Native patch response

The executor requests `PI_APPLY_PATCH_JSON=summary`. The helper returns `status`,
`error`, `exact` and the `result` path lists/fuzz for success and partial failure,
without copying or serializing full file contents into a `changes` array.

Other set values, including `PI_APPLY_PATCH_JSON=1`, retain the detailed response
with per-file old/new contents. An unset variable keeps the text-only CLI output.
Patch application, path reporting and partial-failure semantics are the same in
all response modes.

Rebuild bundled artifacts after changing this protocol using
`bun run build:apply-patch`. This defaults to the current platform. To cross-build,
pass `--target <Rust target>` after the script name, for example:

```sh
bun run build:apply-patch --target x86_64-apple-darwin
```

Supported targets are the six GNU Linux, Apple Darwin and Windows MSVC triples
in `scripts/build-apply-patch-binary.mjs`. Install the matching Rust standard
library, C compiler/linker and SDK/sysroot first; cross-builds do not download or
accept SDK licences automatically. Cargo's target-specific compiler/linker
environment variables remain available. `CARGO_TARGET_DIR` selects the Cargo
artifact directory; an optional positional directory or `APPLY_PATCH_SOURCE_DIR`
selects the source workspace.

The script passes the selected target explicitly to Cargo, copies its actual
target-directory executable and records the source/binary digests, compiler host
and output target. Never relabel an old artifact as rebuilt.
