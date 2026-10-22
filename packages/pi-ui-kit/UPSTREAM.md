# pi-ui-kit source record

## Extracted from

- `extensions/pi-ui/src/transcript/tool/files.ts`: the `RenderLines` width-caching
  component and the tool-card layout (dot, title, `⎿` result branch, indentation).
- a question-dialog renderer formerly maintained in this workspace: `padToWidth`.

Both are this repository's own code; the tool-card rendering helpers in `pi-ui` were
in turn adapted from pi-cc-extensions, whose notice travels in `licenses/`.

## Deliberate changes over the extracted code

- colours come from Pi's semantic theme roles (`toolTitle`, `muted`, `dim`, `accent`,
  `success`, `error`, `warning`) instead of the hardcoded RGB palette, so the card
  follows the active theme and every state is distinguishable without relying on
  colour alone;
- the card chrome strips terminal control sequences and folds whitespace before
  colouring, so a title or message can never break the layout;
- the theme parameter is the narrow `ToolCardTheme` interface (Pi's `Theme` satisfies
  it structurally), which keeps the library testable without a host instance.

## Not moved

Per-tool information, renderer registration, `renderShell`, diff and I/O previews,
hover/show-more hitboxes, mouse routing, pending animation and each module's body
sanitizer stay with the owning extension.
