# UI sources and licenses

This private module combines separately licensed sources. Original copyright
and license notices are preserved; this index does not relicense them.

| Source | Preserved record |
| --- | --- |
| claude-style-tools, copyright 2026 Serali-Nerri | `claude-style-tools-LICENSE` |
| pi-cc-extensions, copyright 2026 minuque | `LICENSES/pi-cc-extensions.txt`, `claude-style-tools-THIRD_PARTY_NOTICES.md` |
| pi-compact-thinking, copyright 2026 Tifan Dwi Avianto | `LICENSES/pi-compact-thinking.txt` |
| pi-session-ui and pi-open-tui contributors | `pi-session-ui-LICENSE`, `pi-session-ui-UPSTREAM.md` |
| MarkedJS / Christopher Jeffrey / John Gruber: adapted reference-definition grammar | `LICENSES/marked.txt` |

The UI bundle contains local views and helpers only. Pi packages remain host
imports. The old direct grok-mermaid dependency and renderer were removed;
standard Mermaid rendering uses the host implementation.

The build copies this entire directory next to `index.js`. Source revisions and
intentional changes are documented in the workspace's `docs/provenance.md`.
