# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/4006488d10e01b7da55c3ebac5b0a7913005ba00/packages/pi-github-watch
- Baseline version: 0.0.7
- Upstream history and license: CHANGELOG.md and LICENSE are retained.

## Current local differences

- package.json removes npm packing lifecycle commands, ships provenance and local history, and declares the workspace Node.js minimum.
- README.md uses a separately prepared installation workspace and native Pi registration, links to the optional local aggregate, and corrects the supported Pi minimum to match the manifest.
- Watch setup fetches only its conversation baseline; paused watches reuse their previous snapshot after access and state checks instead of fetching feedback that would be discarded.
- Repository watches accept `owner/repo` or a repository URL and notify the session of issues and PRs created after the watch starts.

Static checks use the shared upstream Oxfmt/Oxlint/tsrs configuration. Watches remain opt-in and session-scoped; loading the package does not contact GitHub. Local history is in [CHANGELOG.local.md](CHANGELOG.local.md).
