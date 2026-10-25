# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/a06eae4d141fae421a8d0108a4a560013d6508a8/packages/pi-browser
- Baseline version: 0.0.10
- Upstream history and license: CHANGELOG.md and LICENSE are retained unchanged.

## Current local differences

- package.json removes npm publish/prepack/pack lifecycle configuration, adds UPSTREAM.md to the shipped files, and pins the typebox devDependency to the Pi 1.4.0 host's 1.3.27. The build, check, typecheck and lint scripts are retained.
- README.md uses a separately prepared installation checkout and native Pi registration.
- package.json exposes the existing changelog entry as ./changelog so the optional local aggregate preserves both Pi entries through public exports.

Runtime TypeScript sources, the remote worker build and bundled assets match the baseline.
