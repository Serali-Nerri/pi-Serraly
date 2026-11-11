# Local changes

## Unreleased

- Rebase the gateway settings and still-image schemas onto upstream 0.0.14's Pi-native schema migration; require Pi Codex Conversion 4.0.10 for optional Code Mode integration.
- Port the validated gateway adaptation onto upstream 0.0.13, retaining the release's Code Mode help and Pi Codex Conversion 4.0.9 minimum.
- Add configurable Images API base URL, Pi credential provider and custom model to `/imagegen`, without changing Codex OAuth routing or introducing fallback.
- Preserve all six upstream quality choices when switching models. Custom models use still-image controls and omit preset-only complexity; existing preference files remain valid.
- Use native Pi settings dialogs with file/UI boundary validation and correctly offset mouse input.
- Delegate result-image display to Pi instead of drawing a second preview in the tool card, leaving model-visible content unchanged.
