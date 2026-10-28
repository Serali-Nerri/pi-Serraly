# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/d67cb69b22decc4ea024236ba59dc4ddae9a2334/packages/pi-shepherdr
- Baseline version: 0.2.24
- Upstream history and license: CHANGELOG.md and LICENSE are retained.

## Current local differences

- package.json removes npm publish/prepack/pack lifecycle configuration, adds UPSTREAM.md to the shipped files, and pins the typebox devDependency to the Pi 1.4.0 host's 1.3.27.
- README.md uses a separately prepared installation workspace and native Pi registration for Shepherdr and Agent Board; it no longer links the removed root extension API guide.
- Context attachment errors refer to Pi Notes Compaction, the current owner of notes and checkpoint sharing, rather than Codex Conversion.
- The outdated Code Mode error reflects the supported 4.0.5 peer minimum.

Other runtime TypeScript sources and bundled profiles match the baseline.
