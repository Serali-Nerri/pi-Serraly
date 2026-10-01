# Stage-one provenance and behavior changes

## Read-only source baselines

| Source | Revision | Isolated old verification |
| --- | --- | --- |
| `/home/thelya/Work/Scripts/claude-style-tools` | `a9d9ba9` | check + 187 tests + build passed |
| `/home/thelya/Work/Scripts/pi-session-ui` | `4582564` | check + 28 tests passed |

Both working trees were clean before extraction and remain unchanged. Baseline
verification used temporary copies in `/tmp/pi-ui-baselines.KaUpWt`; source
deploy scripts were not run. The old development versions are provenance, not
proof of compatibility with Pi 0.99.2.

The earlier plan recorded `c1eacd9`. Extraction includes its successor `a9d9ba9`
(`Wrap long write preview lines`, 2026-10-01 15:57 +08:00). The temporary baseline
and source `files.ts` have the same SHA-256
`a93cc1b25c047e1c2674b999e4733b367502c8a1717aabfd91523f9d36b67b9d`.
The new UI retains that write-wrapping regression.

## Adapted source

- ccstyle utilities and captured tool/file/patch views remain in `utils/` and
  `transcript/tool/`.
- Prototype integration, component walking and legacy ownership keys live in
  `compat/`.
- Thinking controller, duration restoration and context computation were split
  from their old feature files into `state/`, `transcript/`, `compat/` and
  `overlays/`.
- The original header/footer, Git/runtime and formatting sources form `shell/`.
  Full `pi-open-tui` attribution and MIT text remain in `modules/ui/licenses/`.
- Twelve-field config and the five-page panel remain in `config/`; Markdown has
  one `markdown/index.ts` registration.

Upstream revisions and full copyright/license text are preserved in
`modules/ui/licenses/`. Pi packages are host dependencies; the former direct
grok-mermaid implementation is absent from this bundle.

## Intentional differences

| Before | Unified UI |
| --- | --- |
| Two UI factories and widget bridges | One factory, lifecycle/router, scheduler and bridge |
| Rendering decisions repeated across domains | Shared source-aware policy protecting dedicated renderers and same-name overrides |
| Older copied Thinking message renderer | Decorated Pi 0.99.2 native hidden runs; native visible reasoning preserved |
| Independent timer and refresh ownership | Keyed scheduler; reverse-order cleanup and generation-safe results |
| Three unused settings, bespoke Task displays and scroll override | Removed; twelve settings and native wheel preference |
| UI-owned Mermaid/URL transformer | Host-native Mermaid/ordinary URLs, narrow CJK URL-boundary compatibility; retained admonitions, wrapped links and prose-only circled numerals |
| Incomplete idle independent-usage accounting | All-entry billing including every independent usage kind |
| Ambiguous context occupancy labels | Usage/mixed/estimated/unknown snapshot shared by footer and inspector |

Commands, selected visual features, effective defaults and the existing
`claude-style-tools.json`/Thinking-duration contracts remain stable. User saves
preserve unknown config fields and remove known discarded fields atomically.

## Validation record

- Host baseline: Pi **0.99.2**, Node **24.12.0**, TypeBox **1.3.27** through host
  development packages.
- Final post-fix `npm run verify`: typecheck, **801/801 tests**, zero failures or
  skips, bundle and external-dependency checks passed.
- Runtime suite includes the actual bundled CLI, SDK lifecycle, print/JSON/RPC,
  shared class identity and eight PTYs: regular/fullscreen × 40/80/120 columns,
  plus rich regular/fullscreen at 80 using builtin read/write/edit in tmp cwd.
- Actual reload tests preserve defaultTools selection and replace two TUI
  transcript generations. Native bash/codemode/MCP previews, real-host OSC8
  link destinations, acquisition failure and exceptional cleanup have regressions.
- Markdown coverage includes 270 transformer and 262 real-host render tests.
  Reference definitions in quotes/lists/nested containers retain their keys and
  destinations. Unsafe `www` labels use native inline-code styling to preserve
  literal math/Markdown characters; only CJK-boundary cases are rewritten.
  Complete definition ranges take precedence over fence-looking title text.
  Wrapped targets/titles, escaped angle destinations, and following indented code
  have byte-preservation regressions across eight container forms and three modes.
  Candidates validate in the header's existing containers before they gain
  precedence; newly opened quotes/lists cannot manufacture a definition.
  The classifier stores exact validated keys/source ranges for collection;
  eligible lazy list continuations preserve authoritative destinations.
  Inline HTML such as `<span>` cannot interrupt a paragraph to invent a key.
  Genuine HTML blocks track their own terminator (or blank-line boundary), so
  later code/definitions remain authoritative. Standalone terminator-like text
  outside those blocks cannot end a paragraph or create keys.
- The small reference-definition grammar is adapted from pinned host Marked;
  its complete MIT/Markdown BSD license is preserved. No Marked module is imported
  or bundled, and runtime staging also carries the complete license tree.
- The final bundle passes `node --check`, contains no physical Pi/TypeBox or
  removed Mermaid dependency, and carries all eight license/notice/index files.
- Full visual/mouse/resize acceptance in the user's terminal is the stage-one
  handoff, documented in `docs/acceptance.md`.
- Final scoped source/fixture reviews closed the reported renderer/lifecycle and
  Markdown findings. Review inspection, automated execution and user visual
  acceptance are recorded separately.
- User accepted the temporary UI conditional on renaming the repository to
  `pi-Serraly` and removing footer source labels. Both changes are complete;
  the renamed workspace passed **801/801** again and the temporary package was
  refreshed. Context accounting and `/context` provenance are unchanged.

Global extensions/settings and the other five source modules remain unchanged.
The accepted UI snapshot forms this repository's initial Git baseline.
No formal deployment has been made.
