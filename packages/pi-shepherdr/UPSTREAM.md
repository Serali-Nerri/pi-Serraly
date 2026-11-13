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
- Herdr Core 0.1.21 is the minimum on controllers and targets. New task submissions preserve a native turn baseline so queued idle status cannot start settlement retries; saved legacy tasks and watches remain readable.
- Remote and voice helper wires start only after terminal attachment readiness, retaining coalesced first input and graceful close credit handling.
- Initial cross-machine parent-read denial has a bounded retry window, with recovery notices after a real warning. Native parent/child identity checks and the final closing observation remain authoritative.
- Package-owned behavioral regression tests cover attachment startup/cleanup, task settlement and parent supervision; the repository test runner supplies isolated configuration and offline execution.

Other runtime sources, Core-native resources and bundled profiles match the baseline.
