# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/d67cb69b22decc4ea024236ba59dc4ddae9a2334/packages/pi-browser
- Baseline version: 0.0.11
- Upstream history and license: CHANGELOG.md and LICENSE are retained.

## Current local differences

- package.json removes npm publish/prepack/pack lifecycle configuration, adds UPSTREAM.md to the shipped files, and pins the typebox devDependency to the Pi 1.4.0 host's 1.3.27. The build, check, typecheck and lint scripts are retained.
- README.md uses a separately prepared installation workspace and native Pi registration.
- package.json exposes the existing changelog entry as ./changelog so the optional local aggregate preserves both Pi entries through public exports.
- The outdated Code Mode error reflects the supported 4.0.5 peer minimum.

Other runtime TypeScript sources, the remote worker build and bundled assets match the baseline.
