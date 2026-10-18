# pi-ui architecture — Pi 1.3.0

## Ownership

`src/index.ts` registers Markdown and the UI lifecycle. The lifecycle registers
only `/ccstyle`; UI does not own a context Inspector or register `/context`.
Factory loading has no UI timers or prototype patches.

`src/lifecycle.ts` owns one host subscription per event, a local domain router,
one `pi-ui-bridge`, the current context/generation, presentation commands and
resource cleanup. TUI resources require both `ctx.mode === "tui"` and `hasUI`.
Print, JSON and RPC retain their native prototypes and protocol output.
The router forwards public live declarations and tool observations before
transcript refresh. Session replacement, tree navigation, compaction and shutdown
clear live animation identities rather than treating replayed calls as active.

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
| `state/` | Billing/context snapshots, recorded Work Summary observations, Thinking timing and activity timing/persistence |
| `shell/` | Footer view, captured host identity/liveness, statuses, bounded Git/runtime queries and generation guards |
| `transcript/` | Thinking and tool/file/diff/Input-Output views over captured data |
| `overlays/` | Text-preview dialogs, hover/TUI state |
| `markdown/` | One display-only transformer; native Mermaid/ordinary URLs plus narrow CJK-punctuation URL-boundary compatibility |
| `config/` | Thirteen effective settings, atomic explicit saves and four-page Style/Files/Thinking/UI panel |

## Activity completion

The lifecycle owns the main-agent completion recorder independently of compact
Work Groups and compatibility patches. The first `agent_start` begins an activity;
repeated starts before `agent_settled` preserve that clock. Explicit blocking UI
prompts pause elapsed work, including overlapping prompts. Only `agent_settled`
freezes the result and appends one `pi-ui-activity-completion` custom entry with
`{ durationMs, completedAt }`. Intermediate agent/turn ends do not record
completion, and background agents do not extend the main activity clock.
Session replacement, tree navigation, reload and shutdown discard unfinished
timing rather than inventing a completion.

The public `registerEntryRenderer` renders this metadata as a muted, width-bounded,
right-aligned single line after the activity's final content:
`Worked for 2m 18s · 14:32:08`, with a local time and a date for records not from
today. `Worked for` identifies elapsed work without interpreting its outcome,
including when the user stops the activity. Alignment follows the available
content width on every render; narrow windows truncate the line. It is not a
footer status.
This uses native entry placement and branch replay,
not an assistant-message patch or a custom model-facing message. Saved sessions
retain the records across processes; missing historical timings stay absent.
The host's branch/compaction projection controls visible history: timings for
compacted-away content remain saved but are not restored as orphaned lines.
Only TUI sessions create records. Print/JSON/RPC stay untouched; style mode and
compatibility preflight do not gate this feature.

## Compatibility pipeline

Display patches preserve legacy `Symbol.for("claude-style-tools.*")` ownership
slots. `compat/method-pipeline.ts` mounts one dispatcher per host method and
composes ordered steps. Captured downstream methods cannot re-enter that mutable
dispatcher; disposed steps become inert even if a foreign wrapper captured them.
Only an owned prototype value is restored.

Thinking decorates hidden native runs after Pi builds its message content. Hosts
with a separate `buildContent` method use that completion point; otherwise the
decoration follows `updateContent`. Capability preflight and installation select
the same entry without executing accessors; an unusable builder retains native
rendering instead of falling back to an earlier update hook. Refreshes still use
`updateContent`, so deferred hosts such as Pi-Bolt retain their streaming
coalescing and decide when to build. Both paths share the existing method pipeline,
owner and animation scheduler, including reload and shutdown cleanup. Visible
reasoning, per-run overrides, native Markdown and errors stay with Pi. Compact
controls Work Group visibility in the original transcript positions rather than
collecting member content into one anchor panel. Expanded Thinking, progress text,
ordinary tools and standalone file/dedicated cards retain their recorded order,
including a message's own content order around its tool calls.
Final prose stays native, and nested-operation records do not become new cards.
Tool background and compact display steps
share the same tool update dispatcher. No rendering tool is re-registered.

Domain installation retains reverse-order cleanup and capability failure
reporting. An unusable display capability names the member and retains native
rendering; diagnostics do not infer a host version from a missing member.
Git/runtime subprocesses keep bounded timeouts; disposed sessions ignore
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
Renderer decisions consult source metadata only for names that can be native
builtins; non-builtin names retain their definition-based ownership without
enumerating the inventory. Collapsed cards bypass expanded-background work.
Decisions still read current definitions, settings and source metadata where
relevant; no cross-frame inventory cache can conceal late registration or overrides.

Single, grouped and compact eligible-tool summaries use the shared captured-argument
formatter. Their viewport is the larger of 80% of terminal width and width minus
24 columns, bounded by available columns; status, indentation and detail consume
that same budget. `inputClip: 0` skips character preclipping, while positive limits
remain effective. Path fitting stays POSIX-first and grapheme-safe, preserving
filenames and separator semantics.

Pi 1.3.0 carries `outputPad` in the tool render context and requires self-shell
renderers to apply it themselves. Managed self-shell cards take their leading
indent from that value instead of a fixed column, keeping the indent inside the
viewport budget; `default`-shell expansions stay flush and let the host Box pad
them. An absent value falls back to the host default of one column, so the layout
is unchanged unless the operator chooses another padding. Settled bash/PowerShell
results also append the host-recorded `Took` duration, read from `durationMs`
rather than a renderer clock so the value is monotonic and survives reload; a
result stored without one omits the line.
Collapsed tool-group shell rows use that same recorded duration without
duplicating the single-card line.

Tool animation uses the keyed scheduler to request repaint only. Pending glyphs
are read by the view's `render`, not captured while assembling call/result bodies;
pending views must not enter settled caches. Real data and interaction changes
retain normal host invalidation.
Declared calls in the current live activity animate while awaiting execution,
including while required file arguments are still arriving.
Their pending state does not claim execution has begun; replayed unfinished calls
do not start live animation, and real results determine the final state.

Each expandable display declares the rows and actions it owns in its current
layout. Mouse routing checks that declaration before checking the action's text
hitbox; body text never grants action ownership. Expanded body clicks, drag
selection, links and keyboard expansion retain their existing behavior. Native
edit context omissions use the gutter; a trailing host omission is not retained
hidden content. Expanded diffs remain bounded and previews never reconstruct data
from disk.
Thinking title text and the explicit expansion hint are both declared targets;
body selection and links remain host-owned. Fullscreen mouse expansion stops
bottom-following at the current position, and collapse keeps the current viewport.
That position is read from the pinned host's `viewportTop` and held through its
primary ScrollView; these private instance assumptions are validated against the
real Pi host rather than by the prototype-only capability probe.
Regular-mode scrolling remains terminal-owned.

Text-preview overlays consume normalized mouse events directly: hit-testing uses
component-local coordinates and scrolling preserves the signed `wheelDelta` line
count, including zero. Only a scrollbar press starts pointer capture; track clicks,
thumb dragging and release retain clamped scrolling. A change in rendered terminal
rows/columns, dialog layout or scrollbar track size cancels active thumb dragging
and preserves the clamped scroll offset. Release followed by a fresh scrollbar
press resumes dragging in the new layout. Raw regular-input mouse packets are
decoded at the input boundary, not synthesized from normalized events. Generic
completed-tool and summary checkmarks use the theme's `success` foreground rather
than a fixed RGB color.

Fullscreen sticky user prompts are enabled by `stickyUserMessage` by default,
only in `on` and `compact` modes. The first body line is pinned once its message
passes above the viewport; a later user message takes over under the same
positional condition. Clicking the drawn line returns to its original message.
The active renderer is identified through the current primary ScrollView and
layout, not object equality with the extension's stable TUI reference: the
interactive host passes a forwarding reference to component factories.
Sticky hit-testing is bounded to the current painted row and horizontal span,
never the scrollbar column. An ordinary repaint retains a press only while its
instruction, layout root and geometry remain unchanged; scrolling, resizing and
replacement invalidate it. Moving onto sticky text clears any previous tool-card
hover, even though sticky input is handled before ordinary component dispatch.
The frame identifies native user messages through the host layout (native
`UserMessageComponent` boxes and container layout heights); assistant content is
never a user instruction. Native container lookup starts at the newest eligible
child and stops at the nearest nonempty instruction; row offsets refer into the
host's existing line array instead of copying historical output. It uses each
current frame's geometry, so content changes, expansion and resizing do not
depend on a second invalidation protocol. It neither scans OSC prompt zones nor patches
user-message content. Frame and mouse patches obey the same capability,
branded ownership and identity-safe cleanup rules; no display marker may escape
to the terminal or modify saved message content.
The pinned layout-frame shape is inspected locally; runtime imports stay on the
public Pi package entries that the isolated extension loader resolves.

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
Each reconciliation discovers anchor parents in one mounted-tree traversal shared
by all Work Groups, rather than walking the transcript again for every group.
Synthetic summary shells are not native transcript identities. Work-group and
activity lifetime details belong to [work-summary.md](work-summary.md).

Development and runtime dependency trees are owned by the repository tooling,
not by this UI. See the [repository architecture](../../../docs/architecture.md).
