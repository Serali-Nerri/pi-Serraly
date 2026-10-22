# pi-config-core source record

## Extracted from

- `extensions/pi-ui/src/config/config.ts`: the startup read, the save-time re-read and
  the temporary-file-plus-rename write.

This is this repository's own code; the shared library unifies only the mechanism
(bounded read, atomic write). No new configuration path, file name or migration is
introduced.

## Deliberate hardening over the extracted code

- a caller-declared byte ceiling on both read and write (the consumer declares
  64 KiB), so a save can never produce a file the next read refuses;
- strict UTF-8 decoding instead of replacement characters;
- `0600` for the written file and `0700` for a newly created parent directory;
- a collision-free temporary name (`<name>.<pid>.<uuid>.tmp`) instead of a fixed
  `<path>.tmp`, so concurrent writers never share a temporary file.

## Preserved policy

The library has no opinion about missing or malformed files; the UI keeps its own
error policy: defaults on load, refuse to save over a malformed file.
