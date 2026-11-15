# UI constraints

- Own presentation, opt-in automatic session naming and `/rename`. Do not register tool renderers, change main-chat model messages or add Markdown transformations.
- Session naming uses public model/session APIs independently of mounted components. Keep its requests tool-free and separate from the main provider session; abort owned requests before cleanup and never replace a manual name with a late result.
- Automatic names and rename suggestions share the pinned Codex instructions in `session-title-prompt.ts`; keep provenance in UPSTREAM.md. Suggestions never save before confirmation or overwrite an edited input. Replacements, navigation and external renames close the old dialog and cancel its request.
- Keep private Pi compatibility localized and capability-checked. Restore owned hooks on cleanup; do not overwrite another extension's replacement.
- The type-erased dist/index.ts is the runtime entry, not a type-checking surface. Keep types/index.d.ts aligned with src/index.ts's default factory and ship it for public package consumers.
- No full ExtensionContext/render context or lastComponent retained by components, timers or callbacks. Destructure only the current data/callbacks needed.
- No history traversal or message rebuild on an animation tick. Cache only bounded current layouts; release subscriptions/timers and stale stream frames on shutdown/replacement.
- Thinking layout caches belong to immutable views; visibility/content changes replace the view. Invalidate on width, theme, preview/title settings and duration changes; never memoize live animation. Reasoning snapshots compare text/signature values and content positions, not mutable provider objects; select live versus structured summaries from the current active block after cache lookup.
- Keep Git reads outside render and bind cancellation to the mounted footer lifetime, including remount/replacement.
- Keep cached Thinking titles plain: `truncateToWidth` adds ANSI resets even for plain input; strip terminal sequences before animation and apply theme styling only to whole Unicode grapheme clusters.
- The host omits empty thinking runs. Render a presentation-only placeholder for the active run from `thinking_start`; do not wait for summary text, modify model content, or make empty historical runs visible.
- Test owned behavior through real Pi components/extension lifecycle and isolated files, not source-text or fixed heap-size assertions. Preserve terminal selection and theme/width correctness.
