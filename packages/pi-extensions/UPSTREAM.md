# Upstream provenance

- Pattern reference: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/a06eae4d141fae421a8d0108a4a560013d6508a8/packages/pi-extensions
- Referenced upstream package: `@howaboua/pi-extensions` 0.0.98 at that commit.
- Local package: `pi-extensions` 0.1.0, private and independently maintained.

## Relationship

This package follows the referenced upstream aggregate's Pi package pattern of explicit runtime dependencies on members. It uses separate TypeScript forwarding entries in `pi.extensions` for independent switches. The member set and forwarding entries are maintained here, without copying the upstream aggregate implementation.

`pi-agent-board` and `pi-browser` each declare a separate `changelog.ts` Pi entry. Their local manifests expose that file through the public `./changelog` export so this aggregate can register the declared entry without importing private sibling source. The changelog files and behavior remain owned by those packages.

## Members

| Package | Local version | Provenance |
| --- | --- | --- |
| `pi-codex-conversion` | 4.0.4 | [UPSTREAM](../pi-codex-conversion/UPSTREAM.md) |
| `pi-ask` | 0.0.16 | [UPSTREAM](../pi-ask/UPSTREAM.md) |
| `pi-browser` | 0.0.10 | [UPSTREAM](../pi-browser/UPSTREAM.md) |
| `pi-codex-imagegen` | 0.0.11 | [UPSTREAM](../pi-codex-imagegen/UPSTREAM.md) |
| `pi-agent-board` | 0.0.3 | [UPSTREAM](../pi-agent-board/UPSTREAM.md) |
| `pi-auto-trees` | 0.1.18 | [UPSTREAM](../pi-auto-trees/UPSTREAM.md) |
| `pi-shepherdr` | 0.2.23 | [UPSTREAM](../pi-shepherdr/UPSTREAM.md) |

All members come from the same pinned commit through this repository's retained packages. Each retains its own license, changelog, third-party notices and upstream provenance.

## License

This package's own files are MIT licensed; see [LICENSE](LICENSE). Member code is not relicensed here. See each member package for its license and notices.
