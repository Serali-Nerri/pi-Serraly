# Third-Party Notices

The rendering, thinking, context, Markdown, and utility modules marked with an
attribution comment are adapted from [minuque/pi-cc-extensions v0.8.69](https://github.com/minuque/pi-cc-extensions/tree/5d7a2666f51da9f450bd019af10200c88cc1df98),
commit `5d7a2666f51da9f450bd019af10200c88cc1df98`.
The long-path tool summary in `src/rendering/tool/names.ts` (with local
`default-mode.ts`/`grouping.ts` wiring) is ported from v0.8.70
([`26aa98df`](https://github.com/minuque/pi-cc-extensions/commit/26aa98df430fa4112c6880367b9d477c0ef53f1f));
its path-style detection is posix-first so Linux paths are not relativized
with win32 separators.
Copyright (c) 2026 minuque. Licensed under MIT; the complete license is in
`LICENSES/pi-cc-extensions.txt`.

The thinking implementation also includes code from
[tifandotme/pi-extensions, pi-compact-thinking](https://github.com/tifandotme/pi-extensions/tree/master/packages/pi-compact-thinking),
copyright (c) 2026 Tifan Dwi Avianto. The MIT license is included in
`LICENSES/pi-compact-thinking.txt`.

The file-change renderer is maintained locally. The upstream rich-diff renderer
and its Shiki dependencies are not included.

The former claude-style-tools bundle included grok-mermaid 0.2.2 under
Apache-2.0. The unified UI removes that dependency and delegates standard Mermaid
rendering to Pi. No grok-mermaid code is included in this bundle.
Pi runtime packages are provided by the host and are not bundled.
