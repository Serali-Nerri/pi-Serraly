# Local changes

Local historical changes relative to upstream 0.0.7. [UPSTREAM.md](UPSTREAM.md) owns the current provenance; [CHANGELOG.md](CHANGELOG.md) retains upstream release history.

## 0.0.8 sync decision

The repository-watch implementation and its baseline-request optimizations were intentionally removed from the runtime. The package now uses upstream 0.0.8 exactly; the entries below are historical records of the discarded local behavior.

## Repository watches and baseline requests

- Add repository watches that notify the session of newly created issues and PRs, including the authenticated account's, as metadata awaiting evaluation.
- Avoid fetching discarded unresolved feedback during watch setup and discarded snapshots on resume, preserving the previous baseline and access checks.
- Retain both behaviors with upstream PR-head tracking; read the head commit through the existing PR-state request and preserve the last successful head baseline on resume.
