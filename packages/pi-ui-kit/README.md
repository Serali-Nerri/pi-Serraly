# pi-ui-kit

Shared tool-card syntax for the private pi-Serraly workspace: one header line and one
indented status line, coloured through Pi's semantic theme roles.

```ts
import { RenderLines, renderToolHeader, renderToolStatus, toolHeaderText, toolStatusText } from "pi-ui-kit";

new RenderLines((width) => [
  ...renderToolHeader(theme, { title: "bg_logs", summary: "task-123", state: "running" }, width),
  ...renderToolStatus(theme, { state: "success", message: "tail · 4 KiB · truncated" }, width),
]);

// An owner that wraps through Pi's Text component builds the same text directly.
new Text(toolHeaderText(theme, { title: "Agent", summary: "(claude-sonnet-4-5)", state: "running" }), 0, 0);
new Text(toolStatusText(theme, { state: "success", message: statsLine, styled: true }), 0, 0);
```

## Contract

- `renderToolHeader(theme, {title, summary?, state?, glyph?}, width)` returns one line
  `● title summary`; the dot carries the state colour, the title uses `toolTitle` and
  the summary `muted`. A caller may pass its own `glyph` (for example a pending
  animation frame): the library renders that frame but never runs a timer or caches it.
- `renderToolStatus(theme, {state, message, styled?}, width)` returns one line
  `  ⎿ message`; the message carries the state colour and the branch is `dim`.
  `styled` marks a message the owner already sanitized and coloured, for example a
  multi-colour statistics line: the library then only adds the branch.
- `toolHeaderText(theme, value)` and `toolStatusText(theme, value)` build the same
  two card lines as plain strings, for an owner that does its own wrapping (Pi's
  `Text` component) instead of width-aware components.
- States are `running | success | error | cancelled | neutral`; each maps to its own
  role (`accent | success | error | warning | dim` for the header dot,
  `accent | success | error | warning | muted` for the status message), so no two
  states share a colour and the status text always names the outcome.
- Title, summary and message are plain text: terminal control sequences and control
  characters are removed and whitespace is folded before colouring. Body text keeps
  the owning module's sanitizer.
- Every returned line stays within `width` visible columns; a non-positive width
  returns an empty array.
- `padToWidth(text, width)` pads to `width` visible columns, counts wide characters
  by their columns, never truncates and returns `""` for a non-positive width.
- `RenderLines` caches one build per width and rebuilds after `invalidate()`; the
  owner decides when content, theme or expansion changed.

The library owns the card chrome only. Per-tool information, renderer registration,
diff and I/O bodies, hover/hitbox behaviour, mouse routing and animation stay with the
owning extension. It has no Pi resources and uses no private host API: `ToolCardTheme`
is the public slice of Pi's theme that the card needs, and Pi's `Theme` satisfies it
structurally.

Consumers: `pi-ui`, `pi-background-shell` (bundled into its
tsc output as a stateless leaf) and `pi-subagents`. Provenance:
[UPSTREAM.md](./UPSTREAM.md).
