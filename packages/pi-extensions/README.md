# pi-extensions

Optional local aggregate that exposes all seven retained Howaboua Pi packages from this checkout as independently switchable Pi entries. It is one Pi package with explicit workspace dependencies. Installing packages individually remains the default.

This private package imports this repository's members and excludes `pi-ui`. Its member set differs from the upstream `@howaboua/pi-extensions` npm bundle; see [UPSTREAM.md](UPSTREAM.md).

## Requirements

- Pi 1.4.0 or newer.
- Node.js 22.19 or newer.
- A separate installation checkout prepared as described in [development](../../docs/development.md#本地安装-checkout). Pi loads local packages in place without installing dependencies or building outputs.

## Included packages

| Package | What the aggregate activates |
| --- | --- |
| `pi-codex-conversion` | Provider integration, tool execution, Code and Notebook integration, and tool cards. |
| `pi-ask` | Interactive questions, review triage and human handoff. |
| `pi-browser` | The logged-in browser tool and `/browser` settings. |
| `pi-codex-imagegen` | Image generation and editing tools. |
| `pi-agent-board` | The board tool, `/board` command and viewer. Existing board enablement settings are preserved. |
| `pi-auto-trees` | The `/marker`, prime and `/end` session workflow. |
| `pi-shepherdr` | Herdr multi-agent orchestration, including its Agent Board integration. |

`pi-ui` is not included; install it separately. `context-view` is also a separate upstream install.

The aggregate registers each member's public default extension entry. For `pi-agent-board` and `pi-browser` it also registers their separate public changelog entries, matching those packages' declared Pi manifests. The other five register their changelog coordinator from their default entry.

The manifest lists nine entries under `extensions/`: seven member entries plus `pi-browser-changelog.ts` and `pi-agent-board-changelog.ts`. All are enabled by default. `pi config` lists each file separately under the package's **Extensions** group, so members and the two standalone changelog entries can be switched independently. The five changelog coordinators registered inside a member's default entry follow that member's switch.

For example:

```text
Extensions
  [x] pi-codex-conversion.ts
  [x] pi-ask.ts
  [x] pi-browser-changelog.ts
  [x] pi-browser.ts
  ...
```

## Dependency versus activation

Each member is a `workspace:*` dependency so its public exports resolve from this package. Each file listed in `pi.extensions` forwards one public member export; Pi loads only enabled entries. Dependencies alone do not register extensions, including Shepherdr's dependency on Agent Board.

## Install

Install individual packages by default, or register this aggregate once and select its entries in `pi config`. Use a completed installation checkout:

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

Do not register the aggregate and any of its seven members at the same time. Pi loads both sources, so tools, commands, listeners and changelog coordinators would be duplicated.

Prepare the separate installation checkout from Requirements before changing registrations.

1. Record the current sources with `pi list`.
2. Back up Pi settings and any package resource filters.
3. Remove all seven member registrations with `pi remove <source>`.
4. Install the aggregate once.
5. Restart Pi to load the aggregate.

Removing a registration does not delete member configuration or data such as `pi-shepherdr.json`, board archives or browser settings.

Agent Board's command and tool load when `pi-agent-board.ts` is enabled. Existing `/board off` settings for the session, folder or global scope still apply and are not reset. Disable that entry in `pi config` to omit its command and tool; its standalone changelog entry has a separate switch.

To roll back, remove the aggregate and reinstall the desired member packages. Restore the backed-up settings if source paths changed.

## Development

The package manifest lists the forwarding entries in `extensions/`; no build step is needed. Run `bun run check -- --package pi-extensions` at the repository root for its type and format check.

MIT licensed. See [LICENSE](LICENSE) and [UPSTREAM.md](UPSTREAM.md). Member packages retain their own licenses and notices.
