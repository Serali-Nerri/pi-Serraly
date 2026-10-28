- Port model-native Codex prompts, tools, transport and context into Pi. Add features only for model fit, quota efficiency or Pi integration. Native request semantics are the compatibility baseline; document necessary Pi adaptations. Noisy cache results alone do not justify divergence.
- Preserve cache/continuation across prompt, tool, request, replay and transport changes.
- Own GPT harness integration, not universal compatibility, UI, enterprise or a Pi fork. Route uncommon needs to overrides, extensions or forks.
- After a retryable connection failure, allow up to three fresh WebSocket retries within five minutes, then sticky SSE with a separate five-minute window. Preserve the healthy initial attempt. Fall back immediately on 426 or close 1009.
- Retry server_is_overloaded and slow_down across WebSocket/SSE within one three-minute budget. Honour HTTP/streamed retry delays using monotonic deadlines. Fail if advice exceeds the budget, including across fallback.
- When changing provider transport, compare src/providers/openai-codex-custom-provider.ts with Pi's stock openai-codex-responses provider: requests, transport/headers, reasoning/tier, retries, termination and touched behaviour.
- Structured mode exposes top-level tool schemas. Code uses one-shot exec/wait cells; Deno, TS and JS notebooks retain state and add notebook lifecycle controls. Notes/history and window policy belong to pi-notes-compaction.
- Keep prompt guidance short and argv-shaped.
- Keep README sections foldable and user-facing. Put detailed integration contracts in the owning documentation rather than duplicating them.
- Native runners execute bundled helpers directly. Rebuild locally and use the checkout, never patch installed npm files. Web/image tools belong to their TypeScript packages.
- Keep src/voice/rust/** and scripts/build-voice-helper.mjs paired; this repository maintains the only voice copy.
- Tool-card renderers must not retain the host render context or `lastComponent`; see src/tools/code-mode/AGENTS.md.
- Keep the typebox devDependency aligned with the host Pi runtime. Pi 1.4.0 resolves typebox 1.3.27; a duplicate 1.3.37 copy breaks declaration emit for public schemas.
- Session startup is offline. Do not poll npm or any registry for version updates; local checkout or optional release updates are managed explicitly.
- tools.customRustBinariesDir is the filename-based bundled-helper override, not a Code host override. Bundled-helper startup incompatibility errors point there, not through loader noise.
- Vendored apply-patch engine, path-uri and absolute-path track one Codex source commit. Keep product changes in standalone_executable.rs and pi-apply-patch-fs; preserve local dependency-API adaptations recorded in src/tools/rust/VENDORED.md when syncing.
- Reject review-driven drift from stock Pi unless backend-verified or intentional.
- Provider names/endpoints do not define backend identity. Renamed/proxied openai-codex-responses retains Codex transport, Fast Mode and account isolation.
- Proxies are deliberate policy/monitoring/routing seams. Environment proxies preserve ChatGPT contracts. Explicit openai-responses passthrough supports only its backend's capabilities. Never reject by provider name or assume proxy means non-ChatGPT.
- Native compaction supports OpenAI Codex and configured OpenAI/Codex passthrough only. V2 needs raw Responses output items, not arbitrary registered streams.
- Reuse `src/developer-messages.ts` for instruction delivery: `trySendCodexDeveloperCustomMessage` preserves caller rendering; false means nothing was sent, so fall back to `pi.sendMessage`. Delivery failures throw, not fall back.
- `src/adapter/developer-messages.ts` promotes authenticated custom-message carriers to Responses developer items in place. Preserve chronology and keep UI/history identity separate from provider role; never route these through Pi system-prompt updates.

## Upstream routes

Use an OpenAI Codex checkout as the reference. Before changing an upstream-derived area, compare its recorded pin with that checkout's HEAD and inspect the relevant path history. A checkout is a reference, not an automatic upgrade target. Keep intentional Pi adaptations and update provenance only for code actually adopted.

Paths below are relative to the Codex checkout's `codex-rs/`:

- Code host: `code-mode-host/src/`, `code-mode-runtime/src/`, `code-mode-protocol/src/`. Download the official executable pinned in `src/tools/code-mode/host-assets.ts`; do not restore vendored source or a local build route.
- Patch engine and path utilities: `apply-patch/src/`, `utils/absolute-path/src/`, `utils/path-uri/src/`. Local pin: `src/tools/rust/UPSTREAM.apply-patch`. The sync script preserves Pi's `standalone_executable.rs` and `pi-apply-patch-fs` adapter.
- Image and cache utilities: `utils/image/src/`, `utils/cache/src/`. Both local copies derive from the revision in `src/tools/rust/crates/codex-utils-image/UPSTREAM`. `src/tools/view-image/rust/main.rs` is Pi's wrapper, not an upstream standalone executable.
- PTY: `utils/pty/src/`, pinned by `src/tools/rust/crates/codex-utils-pty/UPSTREAM`. Shell execution is an adaptation of `exec-server/src/local_process.rs`, tracked separately in `src/tools/exec/rust/UPSTREAM`, not a copied exec server.
- Voice DSP: `voice-host/src/device_buffers.rs` and `voice-host/src/processing.rs` map to `src/voice/rust/src/codex_audio/{buffers,processing}.rs`. Pin and adaptation boundary: `src/voice/rust/VENDORED.md`. Its `vendor/` contains licence notices, not dependency source.
- Transport and compaction are TypeScript adaptations, not exact copies: compare `core/src/client.rs`, `core/src/client_common.rs`, `core/src/compact_remote_v2*.rs`, `codex-api/src/endpoint/responses*`, `codex-api/src/sse/responses*`, `responses-api-proxy/` and `models-manager/models.json`. `UPSTREAM_SYNC.md` records reviewed deltas; also compare Pi's stock provider.
- `vendor/js-tiktoken/` and `vendor/tree-sitter-bash/` come from the npm tarballs pinned in their own `UPSTREAM` files, not this Codex checkout. Retain the selected encoding/WASM payloads rather than adding unused encodings or native install hooks.
