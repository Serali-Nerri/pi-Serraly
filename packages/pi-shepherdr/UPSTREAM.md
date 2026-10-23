# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/a06eae4d141fae421a8d0108a4a560013d6508a8/packages/pi-shepherdr
- Baseline version: 0.2.23
- Upstream history and license: CHANGELOG.md and LICENSE are retained unchanged.

## Current local differences

- package.json removes npm publish/prepack/pack lifecycle configuration, adds UPSTREAM.md to the shipped files, and pins the typebox devDependency to the Pi 1.4.0 host's 1.3.27. The pi-agent-board dependency and runtime peer contracts are unchanged.
- README.md installs Shepherdr and Agent Board from immutable releases and no longer links the removed root extension API guide.

Runtime TypeScript sources and bundled profiles match the baseline.
