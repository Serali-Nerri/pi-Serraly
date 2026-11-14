# Upstream provenance

- Pattern reference: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/d67cb69b22decc4ea024236ba59dc4ddae9a2334/packages/pi-extensions
- Referenced upstream package: `@howaboua/pi-extensions` 0.0.99 at that commit.
- Local package: `pi-extensions` 0.2.0, private and independently maintained.

## Relationship

This package follows the referenced upstream aggregate's Pi package pattern of explicit runtime dependencies on members. It uses separate TypeScript forwarding entries in `pi.extensions` for independent switches. The member set and forwarding entries are maintained here, without copying the upstream aggregate implementation.

Each member declares one Pi extension entry; the aggregate has no standalone changelog forwarding entries. Native update-notice limitations are documented in [README](./README.md).

## Members

| Package               | Local version | Provenance                                     |
| --------------------- | ------------- | ---------------------------------------------- |
| `pi-codex-conversion` | 5.0.0         | [UPSTREAM](../pi-codex-conversion/UPSTREAM.md) |
| `pi-ask`              | 0.0.19        | [UPSTREAM](../pi-ask/UPSTREAM.md)              |
| `pi-codex-imagegen`   | 0.0.14        | [UPSTREAM](../pi-codex-imagegen/UPSTREAM.md)   |
| `pi-agent-board`      | 0.0.7         | [UPSTREAM](../pi-agent-board/UPSTREAM.md)      |
| `pi-auto-trees`       | 0.1.19        | [UPSTREAM](../pi-auto-trees/UPSTREAM.md)       |
| `pi-shepherdr`        | 1.0.1         | [UPSTREAM](../pi-shepherdr/UPSTREAM.md)        |
| `pi-notes-compaction` | 0.0.17        | [UPSTREAM](../pi-notes-compaction/UPSTREAM.md) |
| `pi-suggestions`      | 0.0.3         | [UPSTREAM](../pi-suggestions/UPSTREAM.md)      |
| `pi-github-watch`     | 0.0.6         | [UPSTREAM](../pi-github-watch/UPSTREAM.md)     |
| `pi-ui`               | 0.3.0         | [UPSTREAM](../pi-ui/UPSTREAM.md)               |
| `pi-session-recap`    | 0.1.0         | [UPSTREAM](../pi-session-recap/UPSTREAM.md)    |

The nine Howaboua members come from the same pinned commit through this repository's retained packages. UI and Recap have independent provenance. Each member retains its own license and applicable changelogs and third-party notices.

All eleven extensions are dependencies and have explicit forwarding entries. Each entry can be disabled through Pi's package resource filters. Members remain independently installable, but must not be registered alongside this aggregate.

## License

This package's own files are MIT licensed; see [LICENSE](LICENSE). Member code is not relicensed here. See each member package for its license and notices.
