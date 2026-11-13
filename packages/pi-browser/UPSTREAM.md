# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/c3b422c60256907f5a4499cc44e4d055ac3cc28a/packages/pi-browser
- Baseline version: 0.0.13
- Upstream history and license: CHANGELOG.md and LICENSE are retained.

## Current local differences

- package.json removes npm publish/prepack/pack lifecycle configuration, adds UPSTREAM.md to the shipped files.
- README.md uses a separately prepared installation workspace and native Pi registration, and states the supported host and optional Pi Codex Conversion versions.
- The outdated Code Mode error reflects the supported 5.0.0 peer minimum.
- The public ./extension export points Pi to extension.ts, with compiled declaration types for consumers. The aggregate uses this entry so lazy integrations retain host aliases; the compiled root remains a library API.
- build:voice-api emits the standalone voice API declarations before PCC compiles. The root build then fully builds Browser after PCC, resolving their build cycle without skipping type checking.

Other runtime TypeScript sources, the remote worker build and bundled assets match the baseline.
