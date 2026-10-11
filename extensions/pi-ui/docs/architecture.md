# pi-ui architecture — Pi 1.1.0

## Ownership

`src/index.ts` registers Markdown and the UI lifecycle. The lifecycle registers
only `/ccstyle`; UI does not own a context Inspector or register `/context`.
Factory loading has no UI timers or prototype patches.

`src/lifecycle.ts` owns one host subscription per event, a local domain router,
one `pi-ui-bridge`, the current context/generation, presentation commands and
resource cleanup. TUI resources require both `ctx.mode === "tui"` and `hasUI`.
Print, JSON and RPC retain their native prototypes and protocol output.

Fullscreen is the host default. Explicit `tuiMode: "regular"` or
`--tui-mode regular` selects regular mode; UI presentation supports both.
Fullscreen mouse routing belongs to the host, while regular mode leaves mouse
input and scrollback to the terminal.

`src/scheduler.ts` is the single keyed scheduler. Thinking, tool/group loading,
footer elapsed time, query coalescing and deferred rebuilds share one timer.
Replacement cancellation is identity-safe; errors in one callback do not prevent
other jobs from running. Shutdown stops scheduling before resources are released.

## Boundaries

| Directory | Responsibility |
| --- | --- |
| `compat/` | Private host fields, prototype capability checks, source-aware renderer policy, ownership, grouping/compact/message/mouse integration |
| `state/` | Billing/context snapshots and Thinking timing/persistence controller |
| `shell/` | Footer view, captured host identity/liveness, statuses, bounded Git/runtime queries and generation guards |
| `transcript/` | Thinking and tool/file/diff/Input-Output views over captured data |
| `overlays/` | Text-preview dialogs, hover/TUI state |
| `markdown/` | One display-only transformer; native Mermaid/ordinary URLs plus narrow CJK-punctuation URL-boundary compatibility |
| `config/` | Twelve effective settings, atomic explicit saves and four-page Style/Files/Thinking/UI panel |

## Compatibility pipeline

Display patches preserve legacy `Symbol.for("claude-style-tools.*")` ownership
slots. `compat/method-pipeline.ts` mounts one dispatcher per host method and
composes ordered steps. Captured downstream methods cannot re-enter that mutable
dispatcher; disposed steps become inert even if a foreign wrapper captured them.
Only an owned prototype value is restored.

Thinking decorates hidden native runs after Pi builds its message content. Visible
reasoning, per-run overrides, native Markdown and errors stay with Pi. Compact
then composes the process presentation. Tool background and compact display steps
share the same tool update dispatcher. No rendering tool is re-registered.

Domain installation retains reverse-order cleanup and capability failure
reporting. Git/runtime subprocesses keep bounded timeouts; disposed sessions ignore
late results rather than updating newer installations.

## Renderer decisions

All tooling presentation domains use `compat/policy.ts`:

1. `off` or exclusion preserves native/tool-owned presentation.
2. A third-party dedicated call/result/self renderer is protected.
3. Public builtin source metadata permits the ccstyle renderer for real builtins.
4. Valid `apply_patch.v1` reports receive file/diff views; other reports use generic
   captured Input/Output.

Definitions, execution, tool discovery, schemas, prompts and returned content are
outside UI ownership.

The host resolver may provide renderer functions without a business definition;
the native tool component supplies its name. Renderer-cache identity includes that
name, rather than treating an anonymous renderer object as a tool identity.

Single, grouped and compact eligible-tool summaries use the shared captured-argument
formatter. Their viewport is the larger of 80% of terminal width and width minus
24 columns, bounded by available columns; status, indentation and detail consume
that same budget. `inputClip: 0` skips character preclipping, while positive limits
remain effective. Path fitting stays POSIX-first and grapheme-safe, preserving
filenames and separator semantics.

Pi 1.1.0 carries `outputPad` in the tool render context and requires self-shell
renderers to apply it themselves. Managed self-shell cards take their leading
indent from that value instead of a fixed column, keeping the indent inside the
viewport budget; `default`-shell expansions stay flush and let the host Box pad
them. An absent value falls back to the host default of one column, so the layout
is unchanged unless the operator chooses another padding. Settled bash/PowerShell
results also append the host-recorded `Took` duration, read from `durationMs`
rather than a renderer clock so the value is monotonic and survives reload; a
result stored without one omits the line.

Tool animation uses the keyed scheduler to request repaint only. Pending glyphs
are read by the view's `render`, not captured while assembling call/result bodies;
pending views must not enter settled caches. Real data and interaction changes
retain normal host invalidation.

Each expandable display declares the rows and actions it owns in its current
layout. Mouse routing checks that declaration before checking the action's text
hitbox; body text never grants action ownership. Expanded body clicks, drag
selection, links and keyboard expansion retain their existing behavior. Native
edit context omissions use the gutter; a trailing host omission is not retained
hidden content. Expanded diffs remain bounded and previews never reconstruct data
from disk.

`expandedCardBackground` is a validated host semantic background token, defaulting
to `userMessageBg`. UI-owned expanded cards, groups, message summaries and Thinking
read the current choice on repaint. Diff change backgrounds survive the outer
background; dedicated renderers and off-mode tool/message shells remain native.

Only source-confirmed builtin write/edit definitions receive file adapters.
Renderer-less same-name overrides use generic Input/Output and its matching
group/compact/background decisions.

## Data

Billing scans all session entries, including off-branch usage and every independent
usage kind. A session/revision cache uses cheap entry-count/leaf checks before the
next render; cache warming can therefore update idle totals without inventing a
public usage event.

Context uses the active projected history, invalidates anchors after edits or
compaction, and distinguishes actual usage anchors, mixed estimates, estimates
and unknown. Footer owns the context snapshot cache; leaf/session/model changes
and lifecycle invalidation refresh it. Billing entries do not enter the context
projection or latest-assistant cache ratio.

Thinking duration entries keep `claude-style-tools-thinking-duration` and
`{messageTimestamp, contentIndex, durationMs}`. Restoration reads `getEntries()`
across the full session and does not write historical session data.

Compaction watches mounted native transcript identities from the bridge. This
places the refresh after the host rebuild even if another compaction handler
awaits across timer turns. No extra animation timer is introduced.

Compact mounts its display-only Work Summary when transcript children are added,
before the host paints them; the bridge also reconciles rebuilt containers.
Synthetic summary shells are not native transcript identities. Work-group and
activity lifetime details belong to [work-summary.md](work-summary.md).

Development and runtime dependency trees are owned by the repository tooling,
not by this UI. See the [repository architecture](../../../docs/architecture.md).
