# Local changes relative to upstream 0.0.17

The current upstream artifact/help refresh is in [CHANGELOG.md](CHANGELOG.md). [UPSTREAM.md](UPSTREAM.md) owns the current split.

## Upstream 0.0.15 alignment

- The upstream text-only renderer now covers the earlier local duplicate-preview fix. Retain the settings-aware schema call for gateway and custom-model controls.

## Unreleased

- Use Node's native CRC32 for PNG integrity checks, retaining chunk validation without the per-bit JavaScript loop.
- Reject local API edit inputs that cannot fit the encoded data-URL limit before reading or encoding them; Codex's larger-input policy is unchanged.
- Rebase the gateway settings and still-image schemas onto upstream 0.0.14's Pi-native schema migration; require Pi Codex Conversion 4.0.10 for optional Code Mode integration.
- Port the validated gateway adaptation onto upstream 0.0.13, retaining the release's Code Mode help and Pi Codex Conversion 4.0.9 minimum.
- Add configurable Images API base URL, Pi credential provider and custom model to `/imagegen`, without changing Codex OAuth routing or introducing fallback.
- Preserve all six upstream quality choices when switching models. Custom models use still-image controls and omit preset-only complexity; existing preference files remain valid.
- Use native Pi settings dialogs with file/UI boundary validation and correctly offset mouse input.
- Delegate result-image display to Pi instead of drawing a second preview in the tool card, leaving model-visible content unchanged.
