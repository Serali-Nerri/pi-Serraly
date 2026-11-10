# Local changelog

Local changes relative to upstream 0.0.3. [UPSTREAM.md](UPSTREAM.md) owns provenance; [CHANGELOG.md](CHANGELOG.md) retains upstream release history.

## Draft validity with completion metadata

- Ignore non-model custom entries when checking whether a pending draft is stale. Previously pi-ui's completion timing changed the raw session leaf during the debounce and prevented the suggestion request.
- Retain message/context-edit invalidation, lifecycle cancellation and Notes-window checks, including a window change during the debounce.
