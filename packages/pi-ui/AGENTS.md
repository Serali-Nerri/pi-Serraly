# UI constraints

- Presentation only. Do not register tool renderers, change model messages or add Markdown transformations.
- Keep Pi 1.4 private compatibility localized and capability-checked. Restore owned hooks on cleanup; do not overwrite another extension's replacement.
- The type-erased dist/index.ts is the runtime entry, not a type-checking surface. Keep types/index.d.ts aligned with src/index.ts's default factory and ship it for public package consumers.
- No full ExtensionContext/render context or lastComponent retained by components, timers or callbacks. Destructure only the current data/callbacks needed.
- No history traversal or message rebuild on an animation tick. Cache only bounded current layouts; release subscriptions/timers and stale stream frames on shutdown/replacement.
- Keep cached Thinking titles plain: `truncateToWidth` adds ANSI resets even for plain input; strip terminal sequences before animation and apply theme styling only to whole Unicode grapheme clusters.
- The host omits empty thinking runs. Render a presentation-only placeholder for the active run from `thinking_start`; do not wait for summary text, modify model content, or make empty historical runs visible.
- Test owned behavior through real Pi components/extension lifecycle and isolated files, not source-text or fixed heap-size assertions. Preserve terminal selection and theme/width correctness.
