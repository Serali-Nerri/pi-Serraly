# UI constraints

- Presentation only. Do not register tool renderers, change model messages or add Markdown transformations.
- Keep Pi 1.4 private compatibility localized and capability-checked. Restore owned hooks on cleanup; do not overwrite another extension's replacement.
- No full ExtensionContext/render context or lastComponent retained by components, timers or callbacks. Destructure only the current data/callbacks needed.
- No history traversal or message rebuild on an animation tick. Cache only bounded current layouts; release subscriptions/timers and stale stream frames on shutdown/replacement.
- Test owned behavior through real Pi components/extension lifecycle and isolated files, not source-text or fixed heap-size assertions. Preserve terminal selection and theme/width correctness.
