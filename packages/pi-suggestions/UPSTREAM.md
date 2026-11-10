# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/672ec0437b76b075d031fdd072a4f6529303e5d6/packages/pi-suggestions
- Baseline version: 0.0.3
- Upstream history and license: CHANGELOG.md and LICENSE are retained.

## Current local differences

- package.json removes npm packing lifecycle commands, includes provenance and static-check configuration in shipped files, and pins development host packages to Pi 1.5.0.
- README.md uses the separately prepared installation workspace and native Pi registration, documents a one-session source load, and links to the local optional aggregate.
- Draft validity ignores non-model custom state appended by other extensions, while retaining message/context-edit, navigation and Notes-window invalidation. See [local changelog](CHANGELOG.local.md).

Default instructions match the baseline. Suggestions remain off with no model selected; importing or registering the package does not enable model requests.
