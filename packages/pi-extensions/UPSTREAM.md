# Upstream provenance

- Pattern reference: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/d67cb69b22decc4ea024236ba59dc4ddae9a2334/packages/pi-extensions
- Referenced upstream package: `@howaboua/pi-extensions` 0.0.99 at that commit.
- Local package: `pi-extensions` 0.2.0, private and independently maintained.

## Relationship

This package follows the referenced upstream aggregate's Pi package pattern of explicit runtime dependencies on members. It uses separate TypeScript forwarding entries in `pi.extensions` for independent switches. The member set and forwarding entries are maintained here, without copying the upstream aggregate implementation.

`pi-agent-board`, `pi-browser` and `pi-notes-compaction` each declare a separate `changelog.ts` Pi entry. Their local manifests expose that file through the public `./changelog` export so this aggregate can register the declared entry without importing private sibling source. The changelog files and behavior remain owned by those packages.

## Members

| Package               | Local version | Provenance                                     |
| --------------------- | ------------- | ---------------------------------------------- |
| `pi-codex-conversion` | 4.0.5         | [UPSTREAM](../pi-codex-conversion/UPSTREAM.md) |
| `pi-ask`              | 0.0.17        | [UPSTREAM](../pi-ask/UPSTREAM.md)              |
| `pi-browser`          | 0.0.11        | [UPSTREAM](../pi-browser/UPSTREAM.md)          |
| `pi-codex-imagegen`   | 0.0.12        | [UPSTREAM](../pi-codex-imagegen/UPSTREAM.md)   |
| `pi-agent-board`      | 0.0.4         | [UPSTREAM](../pi-agent-board/UPSTREAM.md)      |
| `pi-auto-trees`       | 0.1.19        | [UPSTREAM](../pi-auto-trees/UPSTREAM.md)       |
| `pi-shepherdr`        | 0.2.24        | [UPSTREAM](../pi-shepherdr/UPSTREAM.md)        |
| `pi-notes-compaction` | 0.0.10        | [UPSTREAM](../pi-notes-compaction/UPSTREAM.md) |
| `pi-ui`               | 0.3.0         | [UPSTREAM](../pi-ui/UPSTREAM.md)               |
| `pi-session-recap`    | 0.1.0         | [UPSTREAM](../pi-session-recap/UPSTREAM.md)    |

The eight Howaboua members come from the same pinned commit through this repository's retained packages. UI and Recap have independent provenance. Each member retains its own license and applicable changelogs and third-party notices.

All ten extensions are dependencies and have explicit forwarding entries; the three standalone changelog entries bring the total to thirteen. Each entry can be disabled through Pi's package resource filters. Members remain independently installable, but must not be registered alongside this aggregate.

## License

This package's own files are MIT licensed; see [LICENSE](LICENSE). Member code is not relicensed here. See each member package for its license and notices.
