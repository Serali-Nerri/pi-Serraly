# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/c3b422c60256907f5a4499cc44e4d055ac3cc28a/packages/pi-suggestions
- Baseline version: 0.0.3
- Upstream history and license: CHANGELOG.md and LICENSE are retained.

## Current local differences

- package.json removes npm packing lifecycle commands, includes provenance and static-check configuration in shipped files, and pins development host packages to Pi 1.5.2.
- README.md uses the separately prepared installation workspace and native Pi registration, documents a one-session source load, and links to the local optional aggregate.
- Draft validity ignores non-model custom state appended by other extensions, while retaining message/context-edit, navigation and Notes-window invalidation. See [local changelog](CHANGELOG.local.md).

Default instructions match the baseline. Suggestions remain off with no model selected; importing or registering the package does not enable model requests.
