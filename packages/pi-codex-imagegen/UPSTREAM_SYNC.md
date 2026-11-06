# Upstream synchronization

The contract follows OpenAI Codex image generation at commit b545c94041017d000e2c8b2f6272705d21b85dfb.

The TypeScript implementation uses `gpt-image-2.5` instead of the baseline's `gpt-image-2`.

The upstream source is `codex-rs/ext/image-generation/`, `codex-rs/codex-api/src/endpoint/images.rs` and `codex-rs/codex-api/src/images.rs` in [OpenAI Codex](https://github.com/openai/codex). Use Git at the revision above for the baseline, then compare relevant changes. `upstream/` retains attribution and the revision only. The executable implementation is TypeScript: it preserves Codex generation/edit selectors, native image endpoints, response metadata, and workspace-local artifacts without bundling the Rust client.

## September 28 review

Reviewed through Codex `1b1835f751ebdc0cfc50b3fe55d4571dbb294563`; the reference baseline remains the revision above.

- `transparent_background` follows `40eac3ce8a`: true requests transparency for generation or editing; omission or false requests an opaque background. This replaces the previous automatic background selection.
- HTTP redirects resolve proxy and `no_proxy` routing for each destination, following the route-aware transport change in `6ea62c4396`. The runtime remains identical to the web-search package's copy.

Live `gpt-image-2.5` endpoint checks on 2026-09-28 confirmed real alpha pixels, not just an accepted parameter: generation had 76.69% fully transparent pixels and an edit had 61.66%. The opaque control had no transparent or partially transparent pixels. These samples establish endpoint support, not a guarantee for every prompt.

## November 5 review

Targeted image-file history was reviewed through Codex `86ac0916597244a2e67a197822a5483924660ff1`; the baseline above is unchanged. Full commit-range ancestry was not verified.

- `f9e7b19df8aa75490fc1d90f98d3d95ad716d08e` adds feature-gated GIF generation/edit output and timing fields to Codex. This sync leaves the existing Codex PNG route unchanged; the separate API route follows the package's upstream dev implementation, not Codex's GIF limits.
- Codex still sends JSON to `images/generations` and `images/edits`, using `gpt-image-2`, quality/size `auto` and an opaque default. Its turn metadata, usage-limit and generation-ID additions do not change this package's existing request contract.
- CLIProxyAPI `v8.0.50` (`f7331b5197730226829cab32c31fb4ce546ef8fc`) recognizes `gpt-image-2.5` and forwards size, quality and output format on its Codex Images path. Its allowlist omits complexity. Gateway support does not establish direct OpenAI API support.
