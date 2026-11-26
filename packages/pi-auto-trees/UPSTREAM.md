# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/4006488d10e01b7da55c3ebac5b0a7913005ba00/packages/pi-auto-trees
- Baseline version: 0.1.19
- Upstream history and license: CHANGELOG.md and LICENSE are retained.

The current upstream mainline no longer ships `pi-auto-trees`. This package is intentionally retained from the 0.1.19 baseline as a local standalone extension; its runtime source was not replaced by the current-main deletion.

## Current local differences

- package.json removes npm publication hooks and ships the local provenance and changelog.
- README.md uses a separately prepared installation workspace and native Pi registration, states the supported host and optional Pi Codex Conversion versions, and keeps a local development flow without a pack dry run.
- Commands and voice announcements use the standalone prompt wording, independent of PCC's Heavy setting. The removed PCC `prompt-mode` export is not required. The retained package is checked against Pi 1.6.1 and PCC 5.1.2; see [local history](CHANGELOG.local.md).
