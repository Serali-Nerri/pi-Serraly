# Source provenance

`pi-background-shell@0.1.0` is a local pure-background-shell fork imported from:

- Upstream: <https://github.com/ismailsaleekh/pi-background-tasks>
- Commit: `471f1dcae7ff13d8f989e4c056bdff1e6b01f1ef` (short `471f1dc`)
- npm release: [`pi-background-tasks@2.6.8`](https://www.npmjs.com/package/pi-background-tasks/v/2.6.8)

The baseline npm source, entry and dist had been checked against that commit. Retained and removed functionality is listed in [CHANGELOG.md](CHANGELOG.md); removed names describe provenance only, not supported fork functionality.

The original [ISC LICENSE](LICENSE) is retained unchanged. Upstream authorship remains credited there and in imported history/package metadata. No fork remote, homepage or published npm release is claimed. Historical upstream compatibility claims do not carry over.

## Workspace import

- Read-only local fork reference: `/home/thelya/Work/Scripts/bg`.
- Actual fork HEAD: `86c52d3b5d9f9ab92b843868293495d17ec5d878` (clean), superseding the earlier plan's `f8d056a` baseline.
- Source backup recorded by the parent: `/tmp/pi-serraly-stage-two-sources-20261002-000556`.
- Imported the complete tracked `src/`, `extensions/`, `tests/`, `scripts/`, `docs/`, strict TypeScript configs, package metadata, changelog and license; excluded `.git`, `.github` workflows, `node_modules`, `.pi`, `dist` and the source lockfile.
- Runtime business source and source-fork structure are unchanged, including the existing `.js` ESM specifiers used by NodeNext compilation and both reload ownership symbols. No stylistic rewrite or forced bundle.
- Intentional adaptations: private workspace manifest and Pi 1.1.0 dev pins; runtime peers limited to coding-agent/TUI/TypeBox (pi-ai is test-only); isolated test-script runner; hoisted dependency resolution in package fixtures; shipping CHANGELOG with its provenance links; refreshed source/docs/package gates. Root scripts own release staging and the thin entry wrapper. No global deployment, live requests or source-reference edits.

Current validation commands, coverage and limitations are in [TESTING.md](TESTING.md).

See [README](README.md) and [documentation](docs/INDEX.md).
