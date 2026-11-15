# GitHub Watch

Opt-in GitHub watches that wake the same Pi session for unresolved PR feedback, conversation changes and completed Actions runs. Notifications contain links, counts or run conclusions, never comment bodies or job logs. The agent reads the details with `gh`.

## Install

Requires Pi 1.5 or later, Node.js 22.19 or later, and an authenticated `gh` CLI. Optional Codex Conversion integration requires version 5.0.0 or later. Works with structured tools, Pi native Code mode and Codex Conversion Code mode.

Prepare a separate installation workspace as described in [development](../../docs/development.md#本地安装工作区), then register this package with native Pi:

```sh
pi install /path/to/install-workspace/packages/pi-github-watch
```

Pi loads local packages in place; it does not install dependencies or build them. Registration takes effect at the next full Pi startup. Alternatively, enable its entry in the optional [pi-extensions](../pi-extensions/README.md) aggregate; do not register both.

This extension registers the `github_watch` tool and no slash commands.

## Watch a thread

Ask the agent to watch a worthwhile thread, such as an issue awaiting an answer or a PR awaiting bot reviews. Nothing is watched automatically.

The `github_watch` tool accepts a GitHub URL in its `thread` field, `owner/repo#123`, or a bare issue/PR number resolved through `gh repo view` in the current working directory. Call it without arguments for help. Its actions are `help`, `watch`, `status` and `cancel`. Omit `thread` when cancelling to stop all watches without a GitHub request.

Issues are checked every minute. PRs baseline conversation comments and standalone reviews immediately, wait seven minutes before the first check, then check every minute. Unresolved review threads are first fetched at that first check.

The first PR check surfaces all unresolved review threads, including ones that existed before the watch. Later checks notify when a thread appears, reopens or receives changed feedback, showing the current unresolved list. Unchanged threads and resolution alone do not wake the session. Resolved threads are excluded, but outdated threads remain visible until resolved.

Conversation comments and standalone reviews have no resolved state. Existing entries are baselined, then new or edited entries trigger notifications. Pending reviews and duplicate inline-review receipts are ignored. Replies by the authenticated `gh` account do not trigger notifications, although its unresolved threads remain in the list. Posts made through another account are treated as another participant's feedback.

Notifications encourage the agent to read the discussion, reply with a fix or reasoned disposition, and resolve addressed review threads. The watcher does not post replies or resolve threads itself. Watches continue after feedback notifications. A PR watch stops with a final notice when a check finds the PR closed or merged. Already-closed PRs return their state without starting a watch. To watch a reopened PR, start a new watch. Issue watches continue until cancelled or the session ends.

## Watch an Actions run

Give the agent a run URL such as `https://github.com/owner/repo/actions/runs/123`. The same `thread` field accepts it. Run IDs are not accepted as bare numbers, which still mean issues or PRs.

Runs are checked every minute. A watch follows the run's latest attempt and stops after notifying the session of its conclusion, including success, failure or cancellation. An already-completed run returns its result immediately without starting a watch. To watch a later rerun, start a new watch.

## Lifetime and recovery

Watches survive ordinary compaction but end on cancellation, session switch, reload or process shutdown. They are not restored when reopening a session. Failed checks pause the affected watch and show an error. Start the watch again after checking authentication and access to the watched URL. Resuming checks access and the PR or run state, then reuses the last successful baseline so changes made while paused surface on the next check.

Notifications arrive chronologically through the existing Codex Conversion delivery integration when available, otherwise as native Pi user messages. They queue behind an active response and start a turn when idle. No system prompt changes are used.

## Development

No build step is required. From the repository root, run `bun run check -- --package pi-github-watch`. For a one-session load in an isolated development environment:

```sh
pi -e ./packages/pi-github-watch
```

See [UPSTREAM.md](UPSTREAM.md) for the pinned source and local differences. The upstream [LICENSE](LICENSE) and [CHANGELOG.md](CHANGELOG.md) are retained.
