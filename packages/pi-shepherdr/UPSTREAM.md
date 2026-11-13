# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/c3b422c60256907f5a4499cc44e4d055ac3cc28a/packages/pi-shepherdr
- Baseline version: 1.0.1
- Upstream history and license: CHANGELOG.md and LICENSE are retained.

## Current local differences

- package.json removes npm publish/prepack/pack lifecycle configuration and adds UPSTREAM.md to the shipped files. Type-only integration dependencies use the standalone Notes Compaction 0.0.17 and Agent Board 0.0.7 packages instead of Agent Comms.
- Integration type imports and the saved-reader JSDoc use the standalone packages' public context-sharing, runtime, integration and saved-session exports. Runtime discovery still accepts either standalone providers or upstream Agent Comms; this workspace does not include the aggregate.
- README.md uses a separately prepared installation workspace and native Pi registration for Shepherdr and Agent Board. It links upstream Agent Comms externally and omits the removed root extension API guide.
- Specific remote attachment errors refer to Pi Notes Compaction, the owner of notes and checkpoint sharing, rather than Codex Conversion. Shared provider-unavailable errors retain upstream's optional-provider guidance.
- The outdated Code Mode error reflects the supported 5.0.0 peer minimum.

Other runtime sources, Core-native resources and bundled profiles match the baseline.
