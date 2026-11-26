# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/5b641f0a7c7c93c53f9e9cda6abef498fc1441ef/packages/pi-suggestions
- Baseline version: 0.0.4 (upstream commit `5b641f0` raised Pi peer floors to `>=1.6.1`)
- Upstream history and license: CHANGELOG.md and LICENSE are retained.
- Local history: [CHANGELOG.local.md](./CHANGELOG.local.md) records the local invalidation and disabled-session decisions.

## Selected upstream changes adopted

- 0.0.4's prediction/editor update is adopted, including Pi 1.6.1 render types/peer alignment and the public synchronization boundary.
- Upstream context and manager identity checks are retained so predictions do not apply to a different session or model manager.

## Current local differences

- package.json, README.md and AGENTS.md retain the prepared installation workspace and local static-check policy; host peer and dev dependencies are aligned to Pi 1.6.1.
- Draft validity ignores non-model custom state appended by other extensions, while retaining message/context-edit, navigation and Notes-window invalidation.
- Disabled suggestions skip settled-event conversation snapshots and prediction synchronization after existing cancellation and non-human-TUI cleanup. Enabled-session invalidation remains unchanged.

Suggestions remain off with no model selected; importing or registering the package does not enable model requests.
