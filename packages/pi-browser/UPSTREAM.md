# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/e4aa5bb43c560b722829a5123b3f2e05d3d9a19d/packages/pi-browser
- Baseline version: 0.0.13
- Upstream history and license: CHANGELOG.md and LICENSE are retained.

## Current local differences

- package.json removes npm publish/prepack/pack lifecycle configuration, adds UPSTREAM.md to the shipped files, and pins the typebox devDependency to the Pi 1.4.0 host's 1.3.27. The build, check, typecheck and lint scripts are retained.
- README.md uses a separately prepared installation workspace and native Pi registration.
- package.json exposes the existing changelog entry as ./changelog so the optional local aggregate preserves both Pi entries through public exports.
- The outdated Code Mode error reflects the supported 4.0.7 peer minimum.

- The public ./extension export points Pi to extension.ts, with compiled declaration types for consumers. The aggregate uses this entry so lazy integrations retain host aliases; the compiled root remains a library API.
- build:voice-api emits the standalone voice API declarations before PCC compiles. The root build then fully builds Browser after PCC, resolving their build cycle without skipping type checking.

Other runtime TypeScript sources, the remote worker build and bundled assets match the baseline.
