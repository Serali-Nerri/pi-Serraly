# Local changes

Local changes relative to upstream 0.0.7. [UPSTREAM.md](UPSTREAM.md) owns provenance; [CHANGELOG.md](CHANGELOG.md) retains upstream release history.

## Repository watches and baseline requests

- Add repository watches that notify the session of newly created issues and PRs, including the authenticated account's, as metadata awaiting evaluation.
- Avoid fetching discarded unresolved feedback during watch setup and discarded snapshots on resume, preserving the previous baseline and access checks.
- Retain both behaviors with upstream PR-head tracking; read the head commit through the existing PR-state request and preserve the last successful head baseline on resume.
