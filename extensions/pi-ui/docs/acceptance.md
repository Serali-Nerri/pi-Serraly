# UI validation and acceptance

## Commands and prerequisites

From the repository root:

```sh
npm run verify
```

For focused runtime debugging, run `extensions/pi-ui/test/runtime-integration.test.ts`
through the isolated runner described in the [development guide](../../../docs/development.md).
That guide owns build prerequisites, managed-host selection and Node qualification;
do not repeat full verification for each UI test change.

Tests use Pi **1.3.0** package code, not user configuration. They compile the
current UI to a temporary ESM bundle, keep Pi/TypeBox external, and load it with
the host's actual bundled CLI (`dist/bundle/cli.js`) and extension loader.

## Synthetic previews and captures

Run previews in a real terminal:

```sh
node scripts/preview.mjs fullscreen
node scripts/preview.mjs regular
node scripts/preview.mjs fullscreen rich
node scripts/preview.mjs regular rich
```

Pi defaults to fullscreen. `"tuiMode": "regular"` or `--tui-mode regular` selects
regular mode; the preview commands select their mode explicitly. Fullscreen
routes mouse input through Pi; regular mode leaves mouse input and scrollback to
the terminal.

The default profile uses a local scripted provider, a real built-in `read` call,
Thinking, Markdown, tables, code and Unicode. Try `/ccstyle status`,
`/ccstyle on`, `/ccstyle compact`, `/ccstyle off`, `/ccstyle panel`,
and `/quit`. Escape closes panels and text previews; UI does not register `/context`.

The optional `rich` profile uses Pi's built-in `read`, `write` and `edit` tools.
It reads `rich-seed.txt`, creates `rich-preview.ts`, then edits known content,
all under the printed temporary sandbox. Use Ctrl+O to inspect file/diff rows,
long Unicode lines and retained output. Compare the three style modes and native
Mermaid `off`/`final`/`streaming` settings. The reply also includes admonitions,
CJK/fullwidth URL boundaries, Markdown-active `www` paths, reference definitions
and an unknown-language fence.

Rich previews enable native OSC 8 links to reserved `example.invalid` targets.
Inspect destinations without opening them: the CLI network guard cannot control
an external browser. `/quit` removes the sandbox, including preview files and
settings.

Generate default POSIX PTY captures at 40/80/120 columns in both modes:

```sh
node scripts/capture.mjs /tmp/pi-ui-captures
less -R /tmp/pi-ui-captures/regular-80.ansi
```

Captures retain raw ANSI streams and synthetic diagnostic JSON. They exercise
the initial read conversation, `/ccstyle status` and `/quit`, not the full manual
checklist or screenshot goldens. The runtime suite also exercises rich profiles
at 80 columns.

## Automated coverage

| Boundary | What tests exercise |
| --- | --- |
| Factory and CLI | Compiled ESM loading, pinned host version, no factory-time UI timers/patches or business tool registration, command surface and help without session/provider startup. |
| Print/JSON/RPC | Scripted built-in read loop and extension commands; native prototypes/protocol output, no shell/bridge/UI timers. RPC `hasUI=true` alone does not activate terminal features. |
| SDK lifecycle and reload | In-memory settings/auth/sessions, repeated TUI activation and cleanup, one shared scheduler, inactive no-UI contexts, settings panel and text previews, real reload and defaultTools transitions. |
| Renderer and class identity | Public `registerToolRenderer` resolution in extension load order, built-in renderer merging, same-name overrides, rendererless and custom tools; host-created tool/TUI instances share imported prototypes and installed patches; built-in, codemode and MCP definitions preserve renderer ownership and retained/truncated output without MCP execution. |
| Codemode progress | Native empty/live/final/error output and recorded replay duration; elapsed redraws stop after completion or failure without a local renderer clock. |
| Preview and cursor | Public normalized preview input/render preserves signed wheel lines, local hitboxes and scrollbar-only capture; resize cancels dragging until release and a fresh press. Focused overlay cursors remain native above a sticky transcript and return to the editor on close. |
| HTML export | Real `AgentSession.exportToHtml()` output includes synthetic tool input and retained output through public renderers; isolated sessions never request a model. |
| Markdown and state | Real-host destinations, literal text, code/target preservation, reference definitions and container boundaries; billing/context and Thinking persistence use synthetic session data. |
| Failure and compaction | Missing/read-only methods, foreign wrappers, stale context access, unconditional cleanup and refresh after mounted-tree replacement. |
| Work Summary | Object-based semantic counts, recorded Thinking entries, top-level/internal operation deduplication, incomplete records, user-message boundaries, original-order expansion around prose/file/dedicated cards, and local child expansion without collapsing the Work Group. |
| Sticky prompts | Fullscreen viewed-history instruction selection through the interactive host's forwarding TUI reference, successor messages, jump-to-message, clipped Unicode, setting/style/mode gating, stale input and scrollbar exclusion. |
| Terminal modes and widths | Default fullscreen without mode overrides, explicit regular/fullscreen PTYs, alternate-screen behavior, notifications, bounded rows, temporary file/diff operations, native OSC 8 and shutdown cleanup. |

A grouping compatibility slot may retain an inactive reload tombstone. Cleanup
checks restored native methods, empty groups and no animation timer, rather than
requiring deletion of that slot.

## Isolation and limitations

- Child environments are allowlisted; HOME, agent/config/cache directories and
  cwd are temporary. No real credentials, settings or sessions are read.
- CLI children use offline mode, no persisted session, disabled discovery and
  explicit guard/UI/fixture extensions. A preload rejects fetch/socket/HTTP/TLS/
  DNS access; offline mode alone does not prohibit model requests.
- The provider is deterministic and local. Its literal synthetic key satisfies
  configuration only; it is neither persisted nor sent to an endpoint.
- Default cwd is empty; rich cwd contains only its seed and new/edited file.
  Normal completion and deadlines clean sandboxes; only requested capture output
  is retained. No global installation or deployment is performed.
- PTYs require `/usr/bin/python3` and POSIX `pty`, `termios` and `fcntl` modules.
  Missing support yields explicit PTY skips. Missing/wrong hosts, build errors and
  runtime failures are failures, not skips.

Automated checks establish synthetic behavior and render bounds, not visual
certification in the user's target terminal. Report results and platform skips
from actual runs; no pass counts or manual sign-off are implied by this document.
A PTY skip is recorded as a gap in the report and is never written as a pass. The shared tool-card
syntax is additionally rendered at 1/8/40/80 columns by the root integration
suite.

## Manual visual checklist

- [ ] Native startup header untouched by this module, footer layout, cwd, runtime and extension status segments.
- [ ] On/compact/off presentation; Thinking remains interactive in off.
- [ ] All four settings pages, thirteen settings and keyboard/focus behavior; `inputClip: 0` adaptive mode and explicit positive limits.
- [ ] Mouse-driven text previews, keyboard navigation, scrolling and Escape ownership.
- [ ] Fullscreen hover/expansion, text selection and links; regular keyboard paths.
- [ ] Narrow/wide resizing and light/dark theme changes without stale content.
- [ ] File/diff cards, long-line wrapping, native leading/intermediate gutter gaps, no false expansion for trailing omissions, retained-data expansion and Result Truncation notices.
- [ ] Single/group/compact PowerShell commands and grep/find expression+scope; POSIX/Windows filenames, CJK, combining characters and emoji fit narrow/wide summaries.
- [ ] Stable pending bodies animate without reassembling public renderer bodies; partial/final/cancel and hover/resize remain current.
- [ ] Exact action clicks versus identical ordinary output/diff/Thinking text; actual previews, drag selection, body collapse, links and keyboard paths.
- [ ] Saved semantic expanded background updates existing tool/file/patch/group/message/Thinking views on repaint in light/dark themes; diff semantics, selection, hover, off mode and dedicated renderers remain intact.
- [ ] Native Mermaid settings/fallbacks and bare-URL destinations.
- [ ] Compact semantic Work Summary remains one tail row during live Thinking, direct and internal tool calls; incomplete records are marked without a task-failure claim.
- [ ] Multiple assistant members stay in the expanded Work Group while a child tool or Thinking title is expanded; user messages split replayed groups.
- [ ] Compact expansion restores the original order of progress text, Thinking, ordinary tools and write/edit/apply_patch cards; repeated toggles, live updates and replay do not duplicate or reorder content.
- [ ] Declared calls animate during live waiting but not replay; grouped shell rows show recorded duration without duplicate single-card duration.
- [ ] Fullscreen expansion stops bottom-following at the clicked position and collapse keeps the current viewport; regular scrollback remains terminal-owned.
- [ ] Sticky user-message first lines follow the viewed history, yield to subsequent prompts, jump to the original message, and leave scrollbar hover/clicks and ordinary text selection usable.

At CJK punctuation boundaries, `www` paths containing Markdown-active characters
use native inline-code labels so text such as `$x$` stays literal. Include this
style difference in visual inspection.
