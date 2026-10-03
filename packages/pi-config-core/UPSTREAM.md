# pi-config-core source record

## Extracted from

- `extensions/pi-ui/src/config/config.ts`: the startup read, the save-time re-read and
  the temporary-file-plus-rename write.
- `extensions/pi-subagents/src/config/config-io.ts`: `readGlobalRaw`, `readProjectRaw`
  and `writeJsonAtomic`.

Both are this repository's own code; the shared library unifies only the mechanism
(bounded read, atomic write). No new configuration path, file name or migration is
introduced, and `pi-add-dir` keeps its own asynchronous locking store.

## Deliberate hardening over the extracted code

- a caller-declared byte ceiling on both read and write (the two consumers each
  declare 64 KiB), so a save can never produce a file the next read refuses;
- strict UTF-8 decoding instead of replacement characters;
- `0600` for the written file and `0700` for a newly created parent directory;
- a collision-free temporary name (`<name>.<pid>.<uuid>.tmp`) instead of a fixed
  `<path>.tmp`, so concurrent writers never share a temporary file.

## Preserved policy differences

The library has no opinion about missing, malformed or untrusted files; each consumer
keeps its own error and trust policy (UI: defaults on load, refuse to save over a
malformed file; subagents: `{}` on a failed global load, `absent`/`untrusted`/
`malformed`/`loaded` for the project layer and no write to an untrusted project).
