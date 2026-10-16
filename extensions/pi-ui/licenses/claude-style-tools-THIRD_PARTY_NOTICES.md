# Third-Party Notices

The rendering, thinking, context, Markdown, and utility modules marked with an
attribution comment are adapted from [minuque/pi-cc-extensions v0.8.69](https://github.com/minuque/pi-cc-extensions/tree/5d7a2666f51da9f450bd019af10200c88cc1df98),
commit `5d7a2666f51da9f450bd019af10200c88cc1df98`.
The long-path tool summary in `src/transcript/tool/names.ts` (with local
single-card/group wiring) is ported from v0.8.70
([`26aa98df`](https://github.com/minuque/pi-cc-extensions/commit/26aa98df430fa4112c6880367b9d477c0ef53f1f));
its path-style detection is posix-first so Linux paths are not relativized
with win32 separators.
Additional selective presentation adaptations use the read-only reference
[v0.9.10, `2b72669c`](https://github.com/minuque/pi-cc-extensions/tree/2b72669cafefe0771b2e3e63b0db5c478314d2d4):

- `ecbb13e`: adaptive summary viewport and `inputClip: 0`.
- `b7bca48`: shared PowerShell command and grep/find expression/scope summaries,
  including PowerShell spelling. No arbitrary argument/array payload fallback.
- `eaa328d` / `daacf75`: repaint-only spinner frames and animation cleanup.
  No cursor patch, viewport visibility probe or stopping frames above the viewport.
- `070b5fa`: declared action-row ownership only. Expanded diff limits remain local;
  unlimited inline diffs are not adopted.
- `7f10380`: native leading/intermediate gutter omissions and removal of terminal
  context omissions from the retained-content budget. The local diff renderer
  remains in use; no upstream rich-diff/highlighting stack is included.
- `a644f86`: validated semantic `expandedCardBackground` for UI-owned views.

These are selective behavior ports to the current Pi 1.3.0 interfaces, not whole
commit imports or a replacement of the v0.8.69 + `26aa98df` source baseline.

Further selective behavior adaptations reference
[v1.0.1, `0188b76f`](https://github.com/minuque/pi-cc-extensions/tree/0188b76f2597772bea3b42075857e030d9a89666):

- `4f37369`: fullscreen sticky user-message first lines. The local implementation
  selects native user-message components through Pi 1.3.0's layout and preserves
  saved messages. Pointer input is bounded horizontally as well as vertically;
  the scrollbar is excluded.
- `e1fbcd6` / `d669a32`: replayed user-message boundaries and child expansion
  without closing other members of the same Work Group.
- `5a7d542`: fullscreen expansion stops bottom-following at the current viewport.
- `76b0233`: pending animation during live declaration/waiting, using public
  activity events rather than animating historical unfinished calls.
- `44a57d1` / `28cfe13`: grouped shell rows show recorded duration, not output
  counts or a new presentation clock.

Collapse retains the current viewport, referencing
[`08ec9183`](https://github.com/minuque/pi-cc-extensions/commit/08ec91838842f15ec999850816a99435e7e15fbb)
on main. Its panel-splitting implementation is not imported. Thinking-title
interaction and object-based Work Summary counts, including recorded nested
operations, are local product decisions rather than upstream code imports.
Currencies, output-rate/TTFT features, summary-only edit previews, rich diff,
theme changes and unrelated upstream fixes are not included.

Copyright (c) 2026 minuque. Licensed under MIT; the complete license is in
`LICENSES/pi-cc-extensions.txt`.

The thinking implementation also includes code from
[tifandotme/pi-extensions, pi-compact-thinking](https://github.com/tifandotme/pi-extensions/tree/master/packages/pi-compact-thinking),
copyright (c) 2026 Tifan Dwi Avianto. The MIT license is included in
`LICENSES/pi-compact-thinking.txt`.

The file-change renderer is maintained locally. The upstream rich-diff renderer
and its Shiki dependencies are not included.

Patch ownership is a local divergence from the upstream patch slots: every owner
and prototype pipeline this module writes carries the
`Symbol.for("pi-serraly.ui.patch-owner")` brand. A slot that holds an unmarked
value is treated as a foreign patch, so it is never adopted, replaced or disposed
and the compatibility domain is skipped for that session; the upstream slot names
are kept so such conflicts stay discoverable.

The former claude-style-tools bundle included grok-mermaid 0.2.2 under
Apache-2.0. The unified UI removes that dependency and delegates standard Mermaid
rendering to Pi. No grok-mermaid code is included in this bundle.
Pi runtime packages are provided by the host and are not bundled.
