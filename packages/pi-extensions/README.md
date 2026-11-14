# pi-extensions

Optional local aggregate that exposes all eleven extensions in this checkout as independently switchable Pi entries. It is one Pi package with explicit workspace dependencies. Installing packages individually remains the default.

This private package includes the nine retained Howaboua packages, `pi-ui` and `pi-session-recap`. Its member set differs from the upstream `@howaboua/pi-extensions` npm bundle; see [UPSTREAM.md](UPSTREAM.md).

## Requirements

- Pi 1.5.0 or newer.
- Node.js 22.19 or newer.
- Agent orchestration also needs the [Shepherdr runtime requirements](../pi-shepherdr/README.md#install).
- GitHub watches need the [GitHub Watch requirements](../pi-github-watch/README.md#install).
- A separate installation workspace prepared as described in [development](../../docs/development.md#本地安装工作区). Pi loads local packages in place without installing dependencies or building outputs.

## Included packages

| Package               | What the aggregate activates                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `pi-codex-conversion` | Provider integration, tool execution, Code and Notebook integration, and tool cards.              |
| `pi-ask`              | Interactive questions, review triage and human handoff.                                           |
| `pi-codex-imagegen`   | Image generation and editing tools.                                                               |
| `pi-agent-board`      | The board tool, `/board` command and viewer. Existing board enablement settings are preserved.    |
| `pi-auto-trees`       | The `/marker`, prime and `/end` session workflow.                                                 |
| `pi-shepherdr`        | Herdr multi-agent orchestration, including its Agent Board integration.                           |
| `pi-notes-compaction` | Persistent notes, session history search, context windows and shared context.                     |
| `pi-suggestions`      | Next-prompt drafts in the empty editor and the `/suggestions` settings command.                   |
| `pi-github-watch`     | The `github_watch` tool for opt-in feedback and Actions run notifications in the current session. |
| `pi-ui`               | Thinking, footer, activity-completion hints and sticky user messages.                             |
| `pi-session-recap`    | Manual and idle session recap cards.                                                              |

Enabling the Notes entry provides Notes/History; session auto-pruning remains off by default. Suggestions' prediction requests remain off by default; see its [README](../pi-suggestions/README.md) for setup. Recap's idle automatic mode is on by default and makes model requests; existing member settings are preserved. See each member's README for configuration. `context-view` and other extensions outside this repository remain separate installs.

The aggregate registers each member's public default extension entry, without separate changelog entries. Pi's native update notices cover the registered package, not its dependencies. This aggregate has no changelog of its own, so it does not show member update notices; individual member registrations retain those notices.

The manifest lists eleven entries under `extensions/`, one per member. All are enabled by default. `pi config` lists each file separately under the package's **Extensions** group, so members can be switched independently.

For example:

```text
Extensions
  [x] pi-codex-conversion.ts
  [x] pi-ask.ts
  [x] pi-codex-imagegen.ts
  ...
```

## Dependency versus activation

Each member is a `workspace:*` dependency so its public exports resolve from this package. Each file listed in `pi.extensions` forwards one public member export; Pi loads only enabled entries. Dependencies alone do not register extensions. Shepherdr discovers active Notes and Board integrations optionally; neither entry is required for agent orchestration.

## Install

Install individual packages by default, or register this aggregate once and select its entries in `pi config`. Use a completed installation workspace:

```sh
pi install ~/.pi/pi-Serraly/packages/pi-extensions
```

Registration changes apply at the next full Pi startup.

For isolated development, a source checkout can run the aggregate for one invocation. Build the workspace first:

```sh
bun install
bun run build
pi --no-extensions --no-skills -e ./packages/pi-extensions
```

## Migrate from individual packages

Do not register the aggregate and any of its eleven members at the same time, including Notes, Suggestions, GitHub Watch, UI and Recap. Pi loads both sources, so tools, commands and listeners would be duplicated.

Prepare the separate installation workspace from Requirements before changing registrations.

1. Record the current sources with `pi list`.
2. Back up Pi settings and any package resource filters.
3. Remove all member registrations with `pi remove <source>`, preserving any member resource filters when selecting aggregate entries.
4. Install the aggregate once.
5. Restart Pi to load the aggregate.

Removing a registration does not delete member configuration or data such as `pi-shepherdr.json` or board archives.

Agent Board's command and tool load when `pi-agent-board.ts` is enabled. Existing `/board off` settings for the session, folder or global scope still apply and are not reset. Disable that entry in `pi config` to omit its command and tool.

To roll back, remove the aggregate and reinstall the desired member packages. Restore the backed-up settings if source paths changed.

## Development

The package manifest lists the forwarding entries in `extensions/`; no build step is needed. Run `bun run check -- --package pi-extensions` at the repository root for its type and format check.

MIT licensed. See [LICENSE](LICENSE) and [UPSTREAM.md](UPSTREAM.md). Member packages retain their own licenses and notices.
