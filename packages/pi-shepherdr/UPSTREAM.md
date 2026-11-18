# Upstream provenance

- Source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/4006488d10e01b7da55c3ebac5b0a7913005ba00/packages/pi-shepherdr
- Baseline version: 1.0.2
- Upstream history and license: CHANGELOG.md and LICENSE are retained.

## Current local differences

- package.json removes npm publish/prepack/pack lifecycle configuration and adds UPSTREAM.md to the shipped files. Type-only integration dependencies use the standalone Notes Compaction 0.0.18 and Agent Board 0.0.8 packages instead of Agent Comms.
- Integration type imports and the saved-reader JSDoc use the standalone packages' public context-sharing, runtime, integration and saved-session exports. Runtime discovery still accepts either standalone providers or upstream Agent Comms; this workspace does not include the aggregate.
- README.md uses a separately prepared installation workspace and native Pi registration for Shepherdr and Agent Board. It links upstream Agent Comms externally and omits the removed root extension API guide.
- README.md distinguishes an explicit watch clearing the saved supervision opt-out from assignment restoring only the live watch, matching the retained upstream implementation. Sender attribution describes its compact machine/session/terminal fields.
- Specific remote attachment errors refer to Pi Notes Compaction, the owner of notes and checkpoint sharing, rather than Codex Conversion. Shared provider-unavailable errors retain upstream's optional-provider guidance.
- The outdated Code Mode error reflects the supported 5.0.1 peer minimum.
- Herdr Core 0.1.21 is the minimum on controllers and targets. New task submissions preserve a native turn baseline so queued idle status cannot start settlement retries; saved legacy tasks and watches remain readable.
- Remote and voice helper wires start only after terminal attachment readiness, retaining coalesced first input and graceful close credit handling.
- Initial cross-machine parent-read denial has a bounded retry window, with recovery notices after a real warning. Native parent/child identity checks and the final closing observation remain authoritative.
- Accepted peer quit and close-idle requests handle Windows ECONNRESET through the same once-only close finalizer as EOF, preserving receiver lifetime and terminal/session identity checks.
- Monitor events and settlements refresh only affected session views; subscription changes and missed events retain full reconciliation. Saved-session summaries use a size- and count-bounded LRU cache, and discovery filters known status before hydrating live identity.
- Package-owned behavioral regression tests cover attachment startup/cleanup, task settlement and parent supervision; the repository test runner supplies isolated configuration and offline execution.

Other runtime sources, Core-native resources and bundled profiles match the baseline.
