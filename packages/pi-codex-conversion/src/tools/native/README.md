# Bundled native builds

From the package directory, rebuild a generic helper with:

```sh
bun run build:native-tool codex-exec-shim exec_bridge
```

The current platform is the default. Pass `--target <Rust target>` to cross-build
for one of the six bundled Apple Darwin, GNU Linux or Windows MSVC targets. The
build uses Cargo's explicit target output, including `CARGO_TARGET_DIR` when set;
`CODEX_TOOLS_SOURCE_DIR` selects a different native source workspace. Install the
matching Rust standard library, C compiler/linker and SDK/sysroot separately.
SDK download and licence acceptance are not part of the build script.

Patch helper builds record additional source/binary provenance; see the
[patch response and build contract](../apply-patch/README.md).

The exec helper correlates requests by ID. Read waits can complete out of order
across processes; each stdout JSON frame is serialized atomically. Process
startup, stdin writes, termination and shutdown retain request order. Read tasks
are reaped as requests arrive and aborted/joined at shutdown or stdin closure.
The TypeScript bridge serializes reads per process, including sequence capture
and decoding, so foreground and background reads cannot duplicate stream bytes.
